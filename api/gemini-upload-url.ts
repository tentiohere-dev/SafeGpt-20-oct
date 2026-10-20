import { requireSession } from "./_auth";
import { getKeyPool, json, methodNotAllowed, readJson } from "./_utils";

export const config = { maxDuration: 30 };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType.trim() : "";
  const fileName = typeof body?.fileName === "string" ? body.fileName.trim().slice(0, 180) : "video-upload";
  const fileSize = Number(body?.fileSize);
  const excludedSlots = Array.isArray(body?.excludeKeySlots)
    ? body.excludeKeySlots.filter((slot: unknown) => Number.isInteger(slot) && Number(slot) >= 0 && Number(slot) < 50)
    : [];
  if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return json(res, 400, { error: "A valid image or video MIME type is required." });
  }
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return json(res, 400, { error: "The file size is required to create a resumable upload session." });
  }

  const keys = getKeyPool("gemini");
  const available = keys
    .map((key, keySlot) => ({ key, keySlot }))
    .filter(({ keySlot }) => !excludedSlots.includes(keySlot));
  if (!available.length) {
    return json(res, 503, {
      error: "Gemini could not create an upload session with any remaining server key.",
      geminiExhausted: true,
    });
  }

  for (const { key, keySlot } of available) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(fileSize),
            "X-Goog-Upload-Header-Content-Type": mimeType,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ file: { displayName: fileName || "video-upload" } }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        await response.text().catch(() => "");
        continue;
      }
      const uploadUrl = response.headers.get("x-goog-upload-url") || response.headers.get("location");
      if (!uploadUrl || !uploadUrl.startsWith("https://generativelanguage.googleapis.com/")) continue;
      return json(res, 200, { uploadUrl, keySlot });
    } catch {
      // Try the next configured Gemini key.
    }
  }
  return json(res, 503, {
    error: "Gemini could not create an upload session with any configured key. Check server-side Gemini keys and retry.",
    geminiExhausted: true,
  });
}
