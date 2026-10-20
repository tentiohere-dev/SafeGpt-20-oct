import { getKeyPool, json } from "./_utils";

type VisionMessage = { role: "user" | "assistant"; content: string };
type VisionRequest = {
  messages: VisionMessage[];
  fileUri: string;
  fileName: string;
  mimeType: string;
  keySlot?: number;
  systemPrompt?: string;
  segmentStartSeconds?: number;
  segmentEndSeconds?: number;
  maxWaitMs?: number;
};

function writeEvent(res: any, event: Record<string, unknown>) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function orderedKeys(keys: string[], preferredSlot?: number) {
  const slots = keys.map((key, keySlot) => ({ key, keySlot }));
  if (!Number.isInteger(preferredSlot)) return slots;
  return slots.sort((a, b) => Number(b.keySlot === preferredSlot) - Number(a.keySlot === preferredSlot));
}

function promptText(body: VisionRequest) {
  const messages = body.messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n\n");
  return [body.systemPrompt?.trim(), messages || "Analyze the attached media for visible safety hazards."]
    .filter(Boolean)
    .join("\n\n");
}

async function readGeminiSse(
  response: Response,
  onText: (text: string) => void,
): Promise<string> {
  if (!response.body) throw new Error("Gemini returned an empty response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";
  let completedText = "";

  const consumeEvent = (rawEvent: string) => {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (event?.error) throw new Error("Gemini returned an analysis error.");
    const delta = event?.delta?.type === "text" ? event.delta.text : "";
    const generateContentText = Array.isArray(event?.candidates?.[0]?.content?.parts)
      ? event.candidates[0].content.parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("")
      : "";
    const interactionText = typeof event?.output_text === "string" ? event.output_text : "";
    const text = String(delta || generateContentText || "");
    if (text) {
      collected += text;
      onText(text);
    }
    if (interactionText) completedText = interactionText;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) consumeEvent(event);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  const output = collected || completedText;
  if (!output.trim()) throw new Error("Gemini finished without returning analysis text.");
  return output.trim();
}

async function requestGemini(
  key: string,
  body: VisionRequest,
  remainingMs: number,
  onText: (text: string) => void,
) {
  const isVideo = body.mimeType.startsWith("video/");
  const prompt = promptText(body);
  let url: string;
  let payload: any;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (isVideo) {
    const start = Number(body.segmentStartSeconds);
    const end = Number(body.segmentEndSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60.5) {
      throw new Error("Video analysis must be requested in valid segments of at most 60 seconds.");
    }
    url = "https://generativelanguage.googleapis.com/v1beta/interactions";
    headers["x-goog-api-key"] = key;
    headers["Api-Revision"] = "2026-05-20";
    payload = {
      model: "gemini-3.8-flash",
      stream: true,
      input: [
        {
          type: "video",
          uri: body.fileUri,
          mime_type: body.mimeType,
          processing: {
            type: "static",
            start_offset: start,
            end_offset: end,
          },
        },
        {
          type: "text",
          text: `${prompt}\n\nAnalyze only this video segment (${start.toFixed(1)}–${end.toFixed(1)} seconds). Include key timestamps.`,
        },
      ],
    };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const contents = body.messages
      .filter((message) => message && (message.role === "user" || message.role === "assistant"))
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
    if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Analyze the attached image." }] });
    contents[contents.length - 1].parts.push({
      file_data: { mime_type: body.mimeType, file_uri: body.fileUri },
    });
    payload = {
      contents,
      systemInstruction: { parts: [{ text: body.systemPrompt || "Analyze this image accurately and describe visible details." }] },
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(1, remainingMs)),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini ${response.status}: ${errorText.slice(0, 400)}`);
  }
  return readGeminiSse(response, onText);
}

export async function streamGeminiMedia(req: any, res: any, body: VisionRequest, options?: { maxWaitMs?: number }) {
  const keys = getKeyPool("gemini");
  if (keys.length === 0) {
    return json(res, 503, {
      error: "No Gemini server key is configured. Add a server-side Gemini key, or configure the Ollama fallback.",
      geminiExhausted: true,
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  writeEvent(res, { type: "progress", message: "Analyzing with Gemini…" });

  const isVideo = body.mimeType.startsWith("video/");
  const maxWaitMs = Math.max(1, Math.min(options?.maxWaitMs ?? body.maxWaitMs ?? 290_000, 290_000));
  const deadline = Date.now() + maxWaitMs;
  let lastError = "";
  const keysInOrder = orderedKeys(keys, body.keySlot);

  for (let index = 0; index < keysInOrder.length; index += 1) {
    const { key, keySlot } = keysInOrder[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const slotsLeft = keysInOrder.length - index;
    const attemptMs = Math.max(1_000, Math.floor(remainingMs / slotsLeft));
    let partial = "";
    try {
      const content = await requestGemini(key, body, attemptMs, (text) => {
        partial += text;
        writeEvent(res, { type: "delta", text });
      });
      writeEvent(res, { type: "complete", content, provider: "Gemini", model: isVideo ? "gemini-3.8-flash" : "gemini-2.5-flash" });
      res.end();
      return;
    } catch (error: any) {
      lastError = String(error?.message || "Gemini analysis failed.");
      if (partial) writeEvent(res, { type: "reset" });
      if (index + 1 < keysInOrder.length && Date.now() < deadline) {
        writeEvent(res, { type: "progress", message: `Retrying with Gemini key ${index + 2} of ${keysInOrder.length}…` });
      }
    }
  }

  writeEvent(res, {
    type: "error",
    error: "Every configured Gemini key failed or ran out of quota.",
    geminiExhausted: true,
    details: lastError ? "Gemini attempts were exhausted." : undefined,
  });
  res.end();
}
