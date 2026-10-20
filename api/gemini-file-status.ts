import { requireSession } from "./_auth";
import { getKeyPool, json, methodNotAllowed, readJson } from "./_utils";

export const config = { maxDuration: 15 };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  const fileName = typeof body?.fileName === "string" ? body.fileName.trim() : "";
  if (!/^files\/[A-Za-z0-9_-]+$/.test(fileName)) return json(res, 400, { error: "Invalid Gemini file reference." });
  const keys = getKeyPool("gemini");
  if (!keys.length) {
    return json(res, 503, {
      error: "Media analysis is not configured: no Gemini server key is available.",
      geminiExhausted: true,
    });
  }

  const resource = fileName.split("/").map(encodeURIComponent).join("/");
  const preferredSlot = Number.isInteger(body?.keySlot) ? Number(body.keySlot) : -1;
  const keyOrder = keys
    .map((key, keySlot) => ({ key, keySlot }))
    .sort((a, b) => Number(b.keySlot === preferredSlot) - Number(a.keySlot === preferredSlot));
  for (const { key, keySlot } of keyOrder) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${resource}?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) continue;
      const file = await response.json().catch(() => null);
      if (!file || !["PROCESSING", "ACTIVE", "FAILED"].includes(file.state)) continue;
      return json(res, 200, {
        state: file.state,
        fileUri: typeof file.uri === "string" ? file.uri : null,
        mimeType: typeof file.mimeType === "string" ? file.mimeType : null,
        videoDuration: typeof file.videoMetadata?.videoDuration === "string" ? file.videoMetadata.videoDuration : null,
        keySlot,
        error: file.state === "FAILED" ? String(file.error?.message || "Gemini could not process this file.") : undefined,
      });
    } catch {
      // Try the next configured Gemini key.
    }
  }
  return json(res, 503, {
    error: "Gemini could not check the uploaded file state. Retry the upload.",
    geminiExhausted: true,
  });
}
