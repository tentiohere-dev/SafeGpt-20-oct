import { getKeyPool, json, methodNotAllowed, readJson } from "./_utils";
import { requireSession } from "./_auth";

export const config = { maxDuration: 60 };

const REQUEST_BUDGET_MS = 40_000;
const ATTEMPT_TIMEOUT_MS = 6_000;

const SYSTEM_PROMPT =
  "You are an emergency first aid and safety assistant. The user may be in a real emergency involving injury, burns, fire, gas leaks, or other dangerous situations. Give clear, calm, numbered step-by-step guidance. Be direct and concise. Always end with: Call emergency services immediately if the situation is life threatening.";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function cleanMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) return null;
  const result: ChatMessage[] = [];
  for (const item of value) {
    if (
      !item ||
      !["system", "user", "assistant"].includes(item.role) ||
      typeof item.content !== "string" ||
      item.content.length > 50_000
    ) return null;
    // The server owns the emergency instructions; do not let a client-supplied
    // system message override them.
    if (item.role !== "system") {
      result.push({ role: item.role, content: item.content.replace(/\u0000/g, "").trim() });
    }
  }
  return result.length ? result : null;
}

function openAiMessages(messages: ChatMessage[]) {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...messages]
    .map(({ role, content }) => ({ role, content }));
}

async function requestCompletion(
  provider: "cerebras" | "groq" | "openrouter",
  model: string,
  key: string,
  messages: ChatMessage[],
  deadline: number,
  imageBase64 = "",
  visionMimeType = "image/jpeg",
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const endpoint = provider === "cerebras"
    ? "https://api.cerebras.ai/v1/chat/completions"
    : provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://openrouter.ai/api/v1/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://safegpt.app";
    headers["X-Title"] = "SafeGPT Emergency Response";
  }

  const requestMessages: any[] = openAiMessages(messages);
  if (imageBase64) {
    let lastUser = -1;
    for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
      if (requestMessages[index].role === "user") {
        lastUser = index;
        break;
      }
    }
    if (lastUser >= 0) {
      requestMessages[lastUser] = {
        role: "user",
        content: [
          { type: "text", text: requestMessages[lastUser].content },
          {
            type: "image_url",
            image_url: {
              url: `data:${visionMimeType};base64,${imageBase64}`,
            },
          },
        ],
      };
    }
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
    body: JSON.stringify({
      model,
      messages: requestMessages,
      max_tokens: 1200,
      temperature: 0.2,
    }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data?.choices?.[0]?.message?.content ? data : null;
}

async function completeWithFallback(
  steps: Array<{ provider: "cerebras" | "groq" | "openrouter"; model: string }>,
  messages: ChatMessage[],
  deadline: number,
) {
  for (const step of steps) {
    for (const key of getKeyPool(step.provider)) {
      if (Date.now() >= deadline) return null;
      try {
        const data = await requestCompletion(step.provider, step.model, key, messages, deadline);
        if (data) {
          if (step.provider === steps[0].provider) return data;
          return {
            ...data,
            fallbackProvider: `${step.provider === "openrouter" ? "OpenRouter" : step.provider === "groq" ? "Groq" : "Cerebras"} · ${step.model}`,
          };
        }
      } catch {
        // Retry with the next key/provider. Do not expose upstream details or keys.
      }
    }
  }
  return null;
}

function geminiContents(messages: ChatMessage[], body: any) {
  const systemText = SYSTEM_PROMPT;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  if (contents.length === 0) return null;

  const last = contents[contents.length - 1];
  if (typeof body.geminiFileUri === "string" && body.geminiFileUri.startsWith("https://")) {
    if (typeof body.visionMimeType !== "string" || !body.visionMimeType.startsWith("video/")) return null;
    last.parts.push({ file_data: { mime_type: body.visionMimeType, file_uri: body.geminiFileUri } });
  } else if (typeof body.imageBase64 === "string" && body.imageBase64.length > 0) {
    if (body.imageBase64.length > 3_500_000) return null;
    if (typeof body.visionMimeType !== "string" || !body.visionMimeType.startsWith("image/")) return null;
    last.parts.push({ inline_data: { mime_type: body.visionMimeType, data: body.imageBase64 } });
  } else {
    return null;
  }
  return { contents, systemInstruction: { parts: [{ text: systemText }] } };
}

async function visualResponse(messages: ChatMessage[], body: any, deadline: number) {
  const geminiBody = geminiContents(messages, body);
  if (!geminiBody) return { error: "Attach a valid image or video for visual analysis." };

  for (const key of getKeyPool("gemini")) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
          body: JSON.stringify(geminiBody),
        },
      );
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      if (data?.candidates?.[0]?.content?.parts?.length) return data;
    } catch {
      // Retry with the next Gemini key.
    }
  }

  // OpenRouter can inspect inline images, but cannot access Gemini-hosted video
  // files. Keep video failures explicit rather than silently dropping the clip.
  if (typeof body.imageBase64 === "string" && body.imageBase64.length > 0) {
    const mimeType = body.visionMimeType;
    if (typeof mimeType === "string" && /^image\/(jpeg|png|webp|gif)$/.test(mimeType)) {
      for (const key of getKeyPool("openrouter")) {
        if (Date.now() >= deadline) break;
        try {
          const data = await requestCompletion(
            "openrouter",
            "google/gemini-2.5-flash",
            key,
            messages,
            deadline,
            body.imageBase64,
            mimeType,
          );
          if (data) return { ...data, fallbackProvider: "OpenRouter · Gemini 2.5 Flash" };
        } catch {
          // Keep trying the remaining server-side OpenRouter keys.
        }
      }
    }
  }
  return null;
}

export default async function handler(req: any, res: any) {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;

  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid JSON body." });
  const step = body.step;
  if (!["cerebras", "deepseek", "gemini-visual"].includes(step)) {
    return json(res, 400, { error: "Invalid emergency response step." });
  }
  const messages = cleanMessages(body.messages);
  if (!messages) return json(res, 400, { error: "Emergency messages are invalid or too long." });

  if (step === "gemini-visual") {
    const data = await visualResponse(messages, body, deadline);
    if (data && "error" in data) return json(res, 400, data);
    if (data) return json(res, 200, data);
    return json(res, 503, {
      error: "Visual emergency analysis is temporarily unavailable. Describe the danger in text and call local emergency services if anyone is at risk.",
    });
  }

  const steps = step === "cerebras"
    ? [
        { provider: "cerebras" as const, model: "gpt-oss-120b" },
        { provider: "groq" as const, model: "llama-3.3-70b-versatile" },
        { provider: "openrouter" as const, model: "deepseek/deepseek-r1-0528" },
      ]
    : [
        { provider: "openrouter" as const, model: "deepseek/deepseek-r1-0528" },
        { provider: "cerebras" as const, model: "gpt-oss-120b" },
        { provider: "groq" as const, model: "llama-3.3-70b-versatile" },
      ];

  if (!steps.some(({ provider }) => getKeyPool(provider).length)) {
    return json(res, 503, {
      error: "Emergency AI is not configured. Add server-side CEREBRAS_API_KEY(S), GROQ_API_KEY(S), or OPENROUTER_API_KEY(S).",
    });
  }
  const data = await completeWithFallback(steps, messages, deadline);
  if (data) return json(res, 200, data);
  return json(res, 503, {
    error: "Emergency AI providers are temporarily unavailable. Try again if safe; call your local emergency services now if anyone is at risk.",
  });
}
