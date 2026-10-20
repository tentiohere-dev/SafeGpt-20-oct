import { getKeyPool, json, methodNotAllowed, readJson, rotateIndexFromError } from "./_utils";
import { requireSession } from "./_auth";

type Provider = "groq" | "openrouter" | "gemini" | "nvidia" | "cerebras";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid JSON body" });

  const provider = body.provider as Provider;
  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const visionMimeType = typeof body.visionMimeType === "string" ? body.visionMimeType : "";
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const geminiFileUri = typeof body.geminiFileUri === "string" ? body.geminiFileUri : "";

  if (!provider || !modelId || !Array.isArray(messages)) {
    return json(res, 400, { error: "Missing provider/modelId/messages" });
  }

  const serverKeys = getKeyPool(provider as any);
  const keys = serverKeys;
  if (!keys.length) return json(res, 500, { error: `Server is missing ${provider.toUpperCase()}_API_KEYS` });

  let lastErr = "";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const content = await callProvider(provider, key, modelId, messages, imageBase64, visionMimeType, systemPrompt, geminiFileUri);
      return json(res, 200, { content });
    } catch (e: any) {
      lastErr = typeof e?.message === "string" ? e.message : "Provider error";
      if (!/^\w+\s+\d+:/i.test(lastErr)) break;
      const m = lastErr.match(/^\w+\s+(\d+):\s*([\s\S]*)$/i);
      const status = m ? Number(m[1]) : 0;
      const errText = m ? m[2] : lastErr;
      if (!rotateIndexFromError(errText, status)) break;
    }
  }

  return json(res, 502, { error: "AI provider request failed. Check server-side provider configuration and availability." });
}

async function callProvider(
  provider: Provider,
  apiKey: string,
  modelId: string,
  messages: any[],
  imageBase64: string,
  visionMimeType: string,
  systemPrompt: string,
  geminiFileUri: string = ""
): Promise<string> {
  switch (provider) {
    case "groq":
      return callOpenAiCompat("Groq", "https://api.groq.com/openai/v1/chat/completions", apiKey, modelId, messages, imageBase64);
    case "openrouter":
      return callOpenAiCompat(
        "OpenRouter",
        "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        modelId,
        messages,
        imageBase64,
        { "HTTP-Referer": "https://safegpt.app", "X-Title": "SafeGPT" }
      );
    case "nvidia":
      return callOpenAiCompat("NVIDIA", "https://integrate.api.nvidia.com/v1/chat/completions", apiKey, modelId, messages, "");
    case "cerebras":
      return callOpenAiCompat("Cerebras", "https://api.cerebras.ai/v1/chat/completions", apiKey, modelId, messages, "");
    case "gemini":
      return callGemini(apiKey, modelId, messages, imageBase64, visionMimeType, systemPrompt, geminiFileUri);
    default:
      throw new Error("Unsupported provider");
  }
}

async function callOpenAiCompat(
  label: string,
  url: string,
  apiKey: string,
  modelId: string,
  messages: any[],
  imageBase64: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  const payload = imageBase64
    ? [
        ...messages.slice(0, -1),
        {
          role: "user",
          content: [
            { type: "text", text: messages[messages.length - 1]?.content || "" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ]
    : messages;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({ model: modelId, messages: payload, max_tokens: 16384, temperature: 0.7 }),
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`${label} ${res.status}: ${e.slice(0, 500)}`);
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${label} returned no content`);
  return content;
}

async function callGemini(
  apiKey: string,
  modelId: string,
  messages: any[],
  imageBase64: string,
  visionMimeType: string,
  systemPrompt: string,
  geminiFileUri: string = ""
): Promise<string> {
  const contents = (messages || [])
    .filter((m) => m?.role !== "system")
    .map((m) => ({
      role: m?.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m?.content || "") }],
    }));

  if (geminiFileUri && contents.length > 0) {
    // Prefer file URI (direct upload) — supports large files, no inline base64
    (contents[contents.length - 1].parts as any[]).push({
      file_data: { mime_type: (visionMimeType || "video/mp4").trim() || "video/mp4", file_uri: geminiFileUri },
    });
  } else if (imageBase64 && contents.length > 0) {
    (contents[contents.length - 1].parts as any[]).push({
      inline_data: { mime_type: (visionMimeType || "image/jpeg").trim() || "image/jpeg", data: imageBase64 },
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      systemPrompt
        ? { contents, systemInstruction: { parts: [{ text: systemPrompt }] } }
        : { contents }
    ),
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Gemini ${res.status}: ${e.slice(0, 500)}`);
  }
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no content");
  return text;
}
