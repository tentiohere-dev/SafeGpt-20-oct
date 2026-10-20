import { getKeyPool, json, methodNotAllowed, rotateIndexFromError } from "./_utils";
import { requireSession } from "./_auth";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const groqKeys = getKeyPool("groq");
  const nvidiaKeys = getKeyPool("nvidia");
  const keys: Array<{ provider: "groq" | "nvidia"; key: string }> = groqKeys.length ? groqKeys.map((k) => ({ provider: "groq" as const, key: k })) : [];
  for (const k of nvidiaKeys) keys.push({ provider: "nvidia" as const, key: k });

  if (!keys.length) return json(res, 500, { error: "Server is missing GROQ_API_KEYS and NVIDIA_API_KEYS" });

  const rawBody = await readRaw(req);
  if (!rawBody || rawBody.length === 0) return json(res, 400, { error: "Missing body" });
  if (rawBody.length > MAX_AUDIO_BODY) return json(res, 413, { error: "Audio file too large (max 4 MB)" });

  let lastErr = "";
  for (const { provider, key } of keys) {
    try {
      const out = await forwardTranscription(provider, key, req.headers, rawBody);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(out));
      return;
    } catch (e: any) {
      lastErr = typeof e?.message === "string" ? e.message : "STT error";
      const m = lastErr.match(/^\w+\s+(\d+):\s*([\s\S]*)$/i);
      const status = m ? Number(m[1]) : 0;
      const errText = m ? m[2] : lastErr;
      if (!rotateIndexFromError(errText, status)) break;
    }
  }

  return json(res, 502, { error: "Audio transcription failed. Check server-side provider configuration and availability." });
}

async function forwardTranscription(provider: "groq" | "nvidia", apiKey: string, headers: any, rawBody: Buffer) {
  const contentType = String(headers?.["content-type"] || headers?.["Content-Type"] || "");
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new Error("Unsupported content-type");
  }

  const url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/audio/transcriptions"
      : "https://integrate.api.nvidia.com/v1/audio/transcriptions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${apiKey}`,
    },
    body: rawBody as any,
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`${provider === "groq" ? "Groq" : "NVIDIA"} ${res.status}: ${e.slice(0, 500)}`);
  }

  const data: any = await res.json();
  return data;
}

// Keep the cap below Vercel's 4.5 MB request-body limit.
const MAX_AUDIO_BODY = 4 * 1024 * 1024;

async function readRaw(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX_AUDIO_BODY) {
      for await (const _ of req) { /* drain */ }
      return Buffer.alloc(MAX_AUDIO_BODY + 1); // sentinel > limit
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
