import { json, methodNotAllowed, readJson, readEnv } from "./_utils";
import { requireSession } from "./_auth";

function timeout(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export default async function handler(req: any, res: any) {
  if (!(await requireSession(req, res))) return;
  const ngrok = readEnv("NGROK_URL").replace(/\/+$/, "");

  // GET — status check for model status screen
  if (req.method === "GET") {
    if (!ngrok) return json(res, 200, { online: false, models: [] });
    try {
      const r = await fetch(`${ngrok}/api/tags`, {
        headers: { "ngrok-skip-browser-warning": "1" },
        signal: timeout(5000),
      });
      if (!r.ok) return json(res, 200, { online: false, models: [] });
      const data: any = await r.json().catch(() => ({}));
      const models: string[] = (data?.models || []).map((m: any) => String(m.name || ""));
      return json(res, 200, { online: true, models });
    } catch {
      return json(res, 200, { online: false, models: [] });
    }
  }

  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  if (!ngrok) return json(res, 500, { error: "NGROK_URL not configured on server" });

  const body = await readJson(req);
  const modelId = typeof body?.modelId === "string" ? body.modelId : "";
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";

  if (!modelId || messages.length === 0) {
    return json(res, 400, { error: "Missing modelId or messages" });
  }

  const ollamaMessages = messages.map((m: any) => ({ ...m }));
  if (imageBase64) {
    const lastUser = [...ollamaMessages].reverse().find((m) => m.role === "user");
    if (lastUser) lastUser.images = [imageBase64];
  }

  try {
    const r = await fetch(`${ngrok}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify({ model: modelId, messages: ollamaMessages, stream: false }),
      signal: timeout(30000),
    });
    if (!r.ok) {
      const e = await r.text().catch(() => "");
      return json(res, 502, { error: `Local model ${r.status}: ${e.slice(0, 200)}` });
    }
    const data: any = await r.json().catch(() => ({}));
    const content = String(data?.message?.content || data?.response || "").trim();
    if (!content) return json(res, 502, { error: "Local model returned no content" });
    return json(res, 200, { content });
  } catch (e: any) {
    return json(res, 502, { error: e?.message || "Local proxy error" });
  }
}
