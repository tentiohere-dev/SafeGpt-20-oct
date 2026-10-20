import AsyncStorage from "@react-native-async-storage/async-storage";
import { File as ExpoFile } from "expo-file-system";
import { Platform } from "react-native";

export type MediaProgress = {
  phase: "uploading" | "processing" | "analyzing" | "fallback";
  message: string;
  percent?: number;
};

export type GeminiUploadedFile = {
  fileUri: string;
  fileName: string;
  mimeType: string;
  keySlot: number;
  size: number;
  videoDurationSeconds?: number;
};

export class GeminiUnavailableError extends Error {
  readonly geminiExhausted = true;

  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

class GeminiKeyFailure extends Error {
  constructor(readonly status: number) {
    super(`Gemini upload failed with HTTP ${status}.`);
    this.name = "GeminiKeyFailure";
  }
}

class UploadTransportFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadTransportFailure";
  }
}

type SavedUploadSession = {
  uploadUrl: string;
  keySlot: number;
  offset: number;
  savedAt: number;
};

type UploadResponse = {
  status: number;
  text: string;
  received: number | null;
};

const CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const TINY_INLINE_MAX_BYTES = 512 * 1024;

function getApiBase(): string {
  if (Platform.OS === "web") return "";
  const env = (globalThis as any)?.process?.env ?? {};
  return String(env.EXPO_PUBLIC_PROXY_BASE_URL || env.EXPO_PUBLIC_PROXY_URL || "").replace(/\/+$/, "");
}

function sessionStorageKey(fileName: string, mimeType: string, size: number, lastModified: number, source: File | Blob | string) {
  const sourceTag = typeof source === "string" ? source.slice(-120) : "blob";
  return `safegpt.gemini-upload:${encodeURIComponent(fileName)}:${encodeURIComponent(mimeType)}:${size}:${lastModified}:${encodeURIComponent(sourceTag)}`;
}

async function readSavedSession(key: string): Promise<SavedUploadSession | null> {
  try {
    const raw = Platform.OS === "web"
      ? globalThis.sessionStorage?.getItem(key)
      : await AsyncStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedUploadSession;
    if (
      typeof value.uploadUrl !== "string" ||
      !value.uploadUrl.startsWith("https://generativelanguage.googleapis.com/") ||
      !Number.isInteger(value.keySlot) ||
      !Number.isFinite(value.offset) ||
      Date.now() - value.savedAt > SESSION_TTL_MS
    ) {
      await removeSavedSession(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function saveSession(key: string, value: SavedUploadSession) {
  try {
    const raw = JSON.stringify({ ...value, savedAt: Date.now() });
    if (Platform.OS === "web") globalThis.sessionStorage?.setItem(key, raw);
    else await AsyncStorage.setItem(key, raw);
  } catch {
    // Upload continues even if device/browser storage is unavailable.
  }
}

async function removeSavedSession(key: string) {
  try {
    if (Platform.OS === "web") globalThis.sessionStorage?.removeItem(key);
    else await AsyncStorage.removeItem(key);
  } catch {}
}

async function getBlob(source: File | Blob | string): Promise<Blob> {
  if (typeof source !== "string") return source;
  if (Platform.OS !== "web") {
    try {
      return new ExpoFile(source) as unknown as Blob;
    } catch {
      // Some document providers return URIs that ExpoFile cannot read directly.
    }
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error("Could not read the selected file from this device.");
  return response.blob();
}

function getReceivedOffset(xhr: XMLHttpRequest): number | null {
  const raw = xhr.getResponseHeader("x-goog-upload-size-received");
  const received = raw ? Number(raw) : NaN;
  if (Number.isSafeInteger(received) && received >= 0) return received;
  const range = xhr.getResponseHeader("range") || "";
  const match = range.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : null;
}

function sendUploadRequest(
  uploadUrl: string,
  offset: number,
  body: Blob,
  command: string,
  onProgress?: (loaded: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.timeout = 120_000;
    xhr.setRequestHeader("X-Goog-Upload-Offset", String(offset));
    xhr.setRequestHeader("X-Goog-Upload-Command", command);
    if (command === "query") xhr.setRequestHeader("X-Goog-Upload-Protocol", "resumable");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded);
    };
    xhr.onerror = () => reject(new UploadTransportFailure("Network connection dropped during upload."));
    xhr.ontimeout = () => reject(new UploadTransportFailure("Gemini upload timed out."));
    xhr.onabort = () => reject(new UploadTransportFailure("Gemini upload was interrupted."));
    xhr.onload = () => resolve({
      status: xhr.status,
      text: xhr.responseText || "",
      received: getReceivedOffset(xhr),
    });
    xhr.send(body);
  });
}

async function queryUploadOffset(uploadUrl: string): Promise<number | null> {
  try {
    const response = await sendUploadRequest(uploadUrl, 0, new Blob([]), "query");
    if (response.status === 200 || response.status === 308) return response.received;
    return null;
  } catch {
    return null;
  }
}

async function createUploadSession(
  fileName: string,
  mimeType: string,
  fileSize: number,
  excludedSlots: number[],
): Promise<SavedUploadSession> {
  const response = await fetch(`${getApiBase()}/api/gemini-upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mimeType, fileName, fileSize, excludeKeySlots: excludedSlots }),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data?.geminiExhausted) {
      throw new GeminiUnavailableError(data.error || "All server-side Gemini keys failed to create an upload session.");
    }
    throw new Error(data?.error || `Could not start the Gemini upload (HTTP ${response.status}).`);
  }
  if (
    typeof data?.uploadUrl !== "string" ||
    !data.uploadUrl.startsWith("https://generativelanguage.googleapis.com/") ||
    !Number.isInteger(data?.keySlot)
  ) {
    throw new Error("Gemini returned an invalid upload session.");
  }
  return { uploadUrl: data.uploadUrl, keySlot: data.keySlot, offset: 0, savedAt: Date.now() };
}

async function uploadChunks(
  blob: Blob,
  session: SavedUploadSession,
  storageKey: string,
  onProgress?: (progress: MediaProgress) => void,
): Promise<any> {
  let offset = Math.max(0, Math.min(blob.size, session.offset));
  let transportRetries = 0;
  await saveSession(storageKey, { ...session, offset });

  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK_SIZE);
    const chunk = blob.slice(offset, end);
    const finalChunk = end === blob.size;
    try {
      const response = await sendUploadRequest(
        session.uploadUrl,
        offset,
        chunk,
        finalChunk ? "upload, finalize" : "upload",
        (loaded) => onProgress?.({
          phase: "uploading",
          message: "Uploading directly to Gemini…",
          percent: Math.min(100, Math.round(((offset + loaded) / blob.size) * 100)),
        }),
      );

      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
        throw new GeminiKeyFailure(response.status);
      }
      if (response.status !== 200 && response.status !== 201 && response.status !== 308) {
        throw new Error(`Gemini rejected the upload (HTTP ${response.status}).`);
      }

      offset = response.received !== null && response.received > offset
        ? Math.min(response.received, blob.size)
        : end;
      session.offset = offset;
      await saveSession(storageKey, session);
      transportRetries = 0;

      if (finalChunk && offset >= blob.size) {
        try {
          const data = JSON.parse(response.text);
          if (data?.file?.uri && data?.file?.name) return data.file;
        } catch {}
        // If the final acknowledgement was lost, query the resumable session once.
        const finalState = await queryUploadOffset(session.uploadUrl);
        if (finalState === blob.size) {
          throw new UploadTransportFailure("Gemini finalized the upload but did not return file metadata. Please retry.");
        }
      }
    } catch (error: any) {
      if (error instanceof GeminiKeyFailure) throw error;
      if (!(error instanceof UploadTransportFailure)) throw error;
      transportRetries += 1;
      if (transportRetries > 3) throw error;

      const serverOffset = await queryUploadOffset(session.uploadUrl);
      if (serverOffset !== null && serverOffset >= 0 && serverOffset <= blob.size) {
        offset = serverOffset;
        session.offset = offset;
        await saveSession(storageKey, session);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * transportRetries));
    }
  }

  throw new UploadTransportFailure("Gemini accepted the upload bytes but did not return the file reference.");
}

export async function uploadFileToGemini(
  source: File | Blob | string,
  mimeType: string,
  fileName: string,
  onProgress?: (progress: MediaProgress) => void,
): Promise<GeminiUploadedFile> {
  if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw new Error("Select a supported image or video file.");
  }
  const blob = await getBlob(source);
  if (!blob.size) throw new Error("The selected file is empty or could not be read.");
  const sourceLastModified = Number((source as any)?.lastModified) || 0;
  const storageKey = sessionStorageKey(fileName, mimeType, blob.size, sourceLastModified, source);
  const excludedSlots: number[] = [];
  let session = await readSavedSession(storageKey);
  let file: any = null;

  while (!file) {
    if (!session) {
      session = await createUploadSession(fileName, mimeType, blob.size, excludedSlots);
      await saveSession(storageKey, session);
    } else {
      const remoteOffset = await queryUploadOffset(session.uploadUrl);
      if (remoteOffset !== null && remoteOffset >= 0 && remoteOffset <= blob.size) {
        session.offset = remoteOffset;
      }
    }

    try {
      file = await uploadChunks(blob, session, storageKey, onProgress);
    } catch (error: any) {
      if (error instanceof GeminiKeyFailure) {
        if (!excludedSlots.includes(session.keySlot)) excludedSlots.push(session.keySlot);
        await removeSavedSession(storageKey);
        session = null;
        continue;
      }
      throw error;
    }
  }

  await removeSavedSession(storageKey);
  const fileNameFromUri = String(file.name || "").match(/files\/[A-Za-z0-9_-]+/)?.[0] || "";
  if (!file.uri || !fileNameFromUri) {
    throw new Error("Gemini finished uploading but did not return a usable file reference.");
  }
  onProgress?.({ phase: "processing", message: "Upload complete. Waiting for Gemini to process the file…", percent: 100 });
  return {
    fileUri: String(file.uri),
    fileName: fileNameFromUri,
    mimeType: String(file.mimeType || mimeType),
    keySlot: session.keySlot,
    size: blob.size,
  };
}

export async function waitForGeminiFile(
  uploaded: GeminiUploadedFile,
  onProgress?: (progress: MediaProgress) => void,
): Promise<GeminiUploadedFile> {
  let attempt = 0;
  while (true) {
    const response = await fetch(`${getApiBase()}/api/gemini-file-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: uploaded.fileName, keySlot: uploaded.keySlot }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data?.geminiExhausted) throw new GeminiUnavailableError(data.error || "Gemini could not check the uploaded file.");
      throw new Error(data?.error || `Gemini file status check failed (HTTP ${response.status}).`);
    }
    if (data.state === "ACTIVE" && typeof data.fileUri === "string") {
      const durationText = String(data.videoDuration || "");
      const durationMatch = durationText.match(/^([\d.]+)s$/);
      return {
        ...uploaded,
        fileUri: data.fileUri,
        fileName: String(data.fileName || uploaded.fileName),
        mimeType: String(data.mimeType || uploaded.mimeType),
        keySlot: Number.isInteger(data.keySlot) ? data.keySlot : uploaded.keySlot,
        videoDurationSeconds: durationMatch ? Number(durationMatch[1]) : undefined,
      };
    }
    if (data.state === "FAILED") {
      throw new GeminiUnavailableError(data.error || "Gemini could not process this file.");
    }
    if (data.state !== "PROCESSING") {
      throw new Error("Gemini returned an unknown file-processing state.");
    }
    attempt += 1;
    onProgress?.({
      phase: "processing",
      message: uploaded.mimeType.startsWith("video/") ? "Processing video…" : "Processing image…",
      percent: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 1500 : 3000));
  }
}

/**
 * Compatibility helper for small inline images only. Larger media must use the
 * Gemini Files API resumable ticket flow.
 */
export async function readAsBase64(source: File | Blob | string): Promise<string | null> {
  const blob = await getBlob(source);
  if (blob.size > TINY_INLINE_MAX_BYTES) {
    throw new Error("This file is too large for inline base64. Use the Gemini resumable upload instead.");
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
