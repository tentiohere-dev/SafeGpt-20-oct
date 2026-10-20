import { getKeyPool, json, methodNotAllowed, readJson, rotateIndexFromError } from "./_utils";
import { requireSession } from "./_auth";

// 32 000-char cap — supports long Arabic safety briefings and full documents.
const MAX_TTS_CHARS = 32000;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  const text = typeof body?.text === "string" ? body.text : "";
  const lang = typeof body?.lang === "string" ? body.lang : "ar";

  if (!text.trim()) return json(res, 400, { error: "Missing text" });
  if (text.length > MAX_TTS_CHARS) return json(res, 400, { error: `Text too long (max ${MAX_TTS_CHARS} characters)` });
  if (lang !== "ar") return json(res, 400, { error: "This endpoint currently supports Arabic Groq TTS only" });

  const serverKeys = getKeyPool("groq");
  const keys = serverKeys;
  if (!keys.length) return json(res, 500, { error: "Server is missing GROQ_API_KEYS" });

  let lastErr = "";
  for (const key of keys) {
    try {
      const mp3 = await groqArabicTtsMp3(text, key);
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/mpeg");
      res.end(Buffer.from(mp3));
      return;
    } catch (e: any) {
      lastErr = typeof e?.message === "string" ? e.message : "TTS error";
      const m = lastErr.match(/^Groq\s+(\d+):\s*([\s\S]*)$/i);
      const status = m ? Number(m[1]) : 0;
      const errText = m ? m[2] : lastErr;
      if (!rotateIndexFromError(errText, status)) break;
    }
  }

  return json(res, 502, { error: "Speech generation failed. Check server-side Groq configuration and availability." });
}

async function groqArabicTtsMp3(text: string, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "playai-tts-arabic",
      voice: "Aaliya-PlayAI",
      input: text,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Groq ${res.status}: ${e.slice(0, 500)}`);
  }
  return await res.arrayBuffer();
}
