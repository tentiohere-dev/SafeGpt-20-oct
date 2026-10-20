import { requireSession } from "./_auth";
import { json, methodNotAllowed, readJson } from "./_utils";
import { streamGeminiMedia } from "./_vision";

export const config = { maxDuration: 300 };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid JSON body." });
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : "";
  const fileUri = typeof body.fileUri === "string" ? body.fileUri.trim() : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const fileName = typeof body.fileName === "string" ? body.fileName : "media";
  if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(mimeType) || !fileUri.startsWith("https://generativelanguage.googleapis.com/")) {
    return json(res, 400, { error: "A valid Gemini file reference and image/video MIME type are required." });
  }
  if (messages.length > 30 || messages.some((message: any) => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 50_000)) {
    return json(res, 400, { error: "Media analysis messages are invalid or too long." });
  }

  return streamGeminiMedia(req, res, {
    messages,
    fileUri,
    fileName,
    mimeType,
    keySlot: Number.isInteger(body.keySlot) ? Number(body.keySlot) : undefined,
    systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt.slice(0, 12_000) : undefined,
    segmentStartSeconds: Number(body.segmentStartSeconds),
    segmentEndSeconds: Number(body.segmentEndSeconds),
  });
}
