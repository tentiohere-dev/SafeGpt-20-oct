import { ApiKeys } from "@/context/AppContext";
import { normalizeNumerals, RagChunk, toArabicIndicNumber } from "@/services/ragService";
import { smartRetrieve, SmartRetrieveResult } from "@/services/smartRetriever";
import { performWebSearch, performWebSearchForced, formatSearchResultsForPrompt } from "@/services/webSearchService";
import { getProviderKeyPool } from "@/services/keyManager";
import { getRotatedKeyPool, reportProviderFailure, reportProviderSuccess } from "@/services/reliabilityMonitor";
import { classifyQuery } from "@/services/queryClassifier";
import { Platform } from "react-native";

function envValue(name: string): string {
  try {
    const g: any = globalThis as any;
    const v = g.process?.env?.[name];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function shouldUseServerProxy(): boolean {
  return envValue("EXPO_PUBLIC_USE_SERVER_PROXY") === "1" || Platform.OS === "web";
}

function proxyBaseUrl(): string {
  const base = envValue("EXPO_PUBLIC_PROXY_BASE_URL");
  return base ? base.replace(/\/+$/, "") : "";
}

// ─── MODEL DEFINITIONS ────────────────────────────────────────────────────────
export type AIModel =
  | "cerebras-gpt-oss-120b"
  | "groq-gpt-oss-120b"
  | "groq-llama-3.3-70b"
  | "groq-llama-3.1-8b"
  | "openrouter-hermes-405b"
  | "openrouter-llama-3.3-70b"
  | "openrouter-qwen3-plus"
  | "openrouter-gemini-2.5-flash"
  | "openrouter-qwen2.5-vl-72b"
  | "openrouter-deepseek-r1"
  | "gemini-2.5-flash"
  | "local-llama3.2-vision"
  | "local-llama3.1-8b"
  | "nvidia-free";

export const MODEL_CONFIGS: Record<
  AIModel,
  { provider: string; modelId: string; supportsVision: boolean; label: string }
> = {
  // ── Groq priority 1 ──────────────────────────────────────────────────────
  "groq-gpt-oss-120b": {
    provider: "groq",
    // Groq's most powerful available model (gpt-oss-120b alias)
    modelId: "openai/gpt-oss-120b",
    supportsVision: false,
    label: "Groq GPT-OSS 120B",
  },
  "groq-llama-3.3-70b": {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    supportsVision: false,
    label: "Groq Llama 3.3 70B",
  },
  "groq-llama-3.1-8b": {
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    supportsVision: false,
    label: "Groq Llama 3.1 8B",
  },
  // ── OpenRouter priority 2 ─────────────────────────────────────────────────
  "openrouter-hermes-405b": {
    provider: "openrouter",
    modelId: "nousresearch/hermes-4-405b",
    supportsVision: false,
    label: "Hermes 3 405B (OpenRouter)",
  },
  "openrouter-llama-3.3-70b": {
    provider: "openrouter",
    modelId: "meta-llama/llama-3.3-70b-instruct",
    supportsVision: false,
    label: "Llama 3.3 70B (OpenRouter)",
  },
  "openrouter-qwen3-plus": {
    provider: "openrouter",
    modelId: "qwen/qwen3-235b-a22b",
    supportsVision: false,
    label: "Qwen3 Plus (OpenRouter)",
  },
  "openrouter-gemini-2.5-flash": {
    provider: "openrouter",
    modelId: "google/gemini-2.5-flash",
    supportsVision: true,
    label: "Gemini 2.5 Flash (OpenRouter)",
  },
  "openrouter-qwen2.5-vl-72b": {
    provider: "openrouter",
    modelId: "qwen/qwen2.5-vl-72b-instruct",
    supportsVision: true,
    label: "Qwen2.5 VL 72B (OpenRouter)",
  },
  // ── Gemini priority 3 (vision primary) ───────────────────────────────────
  "gemini-2.5-flash": {
    provider: "gemini",
    modelId: "gemini-2.5-flash",
    supportsVision: true,
    label: "Gemini 2.5 Flash",
  },
  // ── Local ngrok priority 4 ────────────────────────────────────────────────
  "local-llama3.2-vision": {
    provider: "local",
    modelId: "llama3.2-vision:latest",
    supportsVision: true,
    label: "Local Llama 3.2 Vision",
  },
  "local-llama3.1-8b": {
    provider: "local",
    modelId: "llama3.1:8b",
    supportsVision: false,
    label: "Local Llama 3.1 8B",
  },
  // ── Cerebras priority 0 (emergency — ultra-fast, key-rotating) ──────────
  "cerebras-gpt-oss-120b": {
    provider: "cerebras",
    modelId: "gpt-oss-120b",
    supportsVision: false,
    label: "Cerebras GPT-OSS 120B",
  },
  // ── OpenRouter DeepSeek ────────────────────────────────────────────────
  "openrouter-deepseek-r1": {
    provider: "openrouter",
    modelId: "deepseek/deepseek-r1-0528",
    supportsVision: false,
    label: "DeepSeek R1-0528 (OpenRouter)",
  },
  // ── NVIDIA priority 5 (last fallback) ────────────────────────────────────
  "nvidia-free": {
    provider: "nvidia",
    modelId: "meta/llama-3.3-70b-instruct",
    supportsVision: false,
    label: "NVIDIA Llama 3.3 70B",
  },
};

// ── Reasoning/Chat fallback order (Gemini EXCLUDED — vision only) ─────────────
const FALLBACK_ORDER: AIModel[] = [
  "cerebras-gpt-oss-120b",    // 0.  Cerebras (ultra-fast, emergency primary — key rotates automatically)
  "groq-gpt-oss-120b",        // 1a. Groq primary (cerebras fallback + fastest)
  "groq-llama-3.3-70b",       // 1b. Groq backup 1
  "groq-llama-3.1-8b",        // 1c. Groq backup 2
  "openrouter-hermes-405b",   // 2a. OpenRouter
  "openrouter-llama-3.3-70b", // 2b.
  "openrouter-qwen3-plus",    // 2c.
  "local-llama3.1-8b",        // 3.  Local (no Gemini here — vision only)
  "nvidia-free",              // 4.  NVIDIA last fallback
];

// ── Vision fallback: Gemini primary → local Llama 3.2 Vision only ────────────
const VISION_FALLBACK_ORDER: AIModel[] = [
  "gemini-2.5-flash",          // Primary vision model
];

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are SafeGPT, an expert AI assistant specialized in Health & Safety for construction sites.
You have deep knowledge of NEBOSH, OSHA, Saudi safety regulations, and construction site hazards.
Always provide practical, actionable safety advice. When identifying hazards, always suggest corrective actions.
Be concise, professional, and safety-focused.
Format every response as a short optional title followed by a numbered list.
Each numbered point must be concise, simple, and no longer than 1 to 2 lines.
Do not use markdown bullets, asterisks, dashed separators, arrows, or random lettered lists.

BILINGUAL RULE: When the user writes in Arabic, always respond with BOTH Arabic AND English.
Format bilingual responses with an Arabic heading, then numbered Arabic points, then an English heading, then numbered English points.

When the user writes only in English, respond only in English (unless they ask for Arabic too).`;

const LAW_SAFETY_RULES = `SAFETY-CRITICAL APPLICATION RULES — READ BEFORE ANSWERING:
1. Answer ONLY from the document context or search results provided above.
2. If the specific article or regulation requested is not in the provided context, respond with exactly: "I could not find this in the provided document. Please check the source document directly."
3. NEVER substitute a different article number than the one the user asked for.
4. NEVER answer legal or regulatory questions from your training knowledge.
5. Always state the exact Article number and document name when citing any law.
6. If you are uncertain about any part of your answer, say so explicitly. Do not guess.`;

function isLawOrArticleQuery(query: string): boolean {
  return /article\s*\d|مادة\s*\d|المادة\s*\d|regulation|labor law|labour law|نظام العمل|لائحة|تشريع|clause\s*\d|section\s*\d{1,3}/i.test(
    query
  );
}

function buildSystemPromptForQuery(query: string, ragUsed: boolean): string {
  if (ragUsed || isLawOrArticleQuery(query)) {
    return LAW_SAFETY_RULES + "\n\n" + SYSTEM_PROMPT;
  }
  return SYSTEM_PROMPT;
}

function getRequestedArticleNumber(query: string): number | null {
  const classification = classifyQuery(query);
  return classification.type === "structural" && classification.target === "article"
    ? classification.number
    : null;
}

function isLawArticleChunk(chunk: RagChunk): boolean {
  return (
    chunk.metadata?.doc_type === "law" ||
    chunk.metadata?.section_type === "legal_article"
  );
}

function matchesRequestedArticle(chunk: RagChunk, articleNumber: number): boolean {
  if (!isLawArticleChunk(chunk)) return false;
  const rawNumber =
    chunk.metadata.article_number_int ?? chunk.metadata.article_number;
  const parsedNumber = Number.parseInt(normalizeNumerals(String(rawNumber ?? "")), 10);
  return parsedNumber === articleNumber;
}

function articleNotFoundMessage(articleNumber: number): string {
  return `Article ${articleNumber} was not found in the uploaded document.`;
}

function buildStrictArticleRules(articleNumber: number): string {
  return `MANDATORY RULES FOR LAW AND REGULATION DOCUMENT QUERIES:
1. You are answering a question about Article ${articleNumber} from the uploaded document.
2. If the retrieved document text above contains Article ${articleNumber}, return its full text completely and exactly as provided. Do not summarize, shorten, translate, add commentary, or include any other article. Return the article text itself, not the surrounding retrieval labels.
3. If the retrieved document text above does not contain Article ${articleNumber}, respond with exactly this and nothing else: "${articleNotFoundMessage(articleNumber)}"
4. NEVER use your training knowledge to answer questions about this article or other law or regulation content.
5. NEVER substitute a different article for the one requested.
6. NEVER add articles, clauses, or legal information beyond what was explicitly requested.
7. NEVER guess or infer what an article says if it is not present in the retrieved text.
These rules take priority over all other formatting and answer instructions.`;
}

// ─── CITATION VERIFICATION ────────────────────────────────────────────────────

export function verifyCitations(
  aiResponse: string,
  retrievedChunks: RagChunk[]
): { verified: boolean; hallucinated: number[]; warning: string | null } {
  const citationMatches = aiResponse.matchAll(
    /[Aa]rticle\s+(\d+)|[Mm]adة\s+(\d+)|[Aa]rt\.\s*(\d+)|المادة\s+(\d+)|مادة\s+(\d+)/g
  );
  const citedNumbers = Array.from(citationMatches)
    .map((m) => parseInt(m[1] || m[2] || m[3] || m[4] || m[5] || "0", 10))
    .filter((n) => n > 0);

  if (citedNumbers.length === 0 || retrievedChunks.length === 0) {
    return { verified: true, hallucinated: [], warning: null };
  }

  const retrievedNumbers = retrievedChunks
    .map((c) => (c.metadata as any).article_number_int)
    .filter((n): n is number => typeof n === "number");

  const hallucinated = citedNumbers.filter((n) => !retrievedNumbers.includes(n));

  if (hallucinated.length > 0) {
    return {
      verified: false,
      hallucinated,
      warning:
        `⚠️ Safety Warning: The AI referenced Article(s) ${hallucinated.join(", ")} which were ` +
        `not retrieved from the uploaded document. Verify manually before taking any action on this information.`,
    };
  }
  return { verified: true, hallucinated: [], warning: null };
}

// ─── LEGAL SEARCH QUERY BUILDER ───────────────────────────────────────────────

export function buildLegalSearchQuery(originalQuery: string): string {
  const articleMatch = originalQuery.match(
    /(?:article|art\.|مادة|المادة)\s*(?:رقم\s*)?(\d+)/i
  );
  if (articleMatch) {
    return `Article ${articleMatch[1]} Saudi Labor Law safety regulation site:laws.gov.sa OR site:hrsd.gov.sa OR site:ilo.org`;
  }
  return `${originalQuery} Saudi HSE regulation construction safety`;
}

// ─── RAG RETRIEVAL CONFIDENCE ─────────────────────────────────────────────────

export function isRagRetrievalConfident(ragResult: SmartRetrieveResult): boolean {
  if (ragResult.notFound) return false;
  if (!ragResult.text || ragResult.text.trim().length === 0) return false;
  if (ragResult.chunks.length === 0) return false;
  return true;
}

// ─── SMART ROUTING ────────────────────────────────────────────────────────────
const URGENT_KW = ["emergency","urgent","immediate","danger","hazard","risk","accident",
  "injury","fire","explosion","chemical","toxic","fall","collapse","confined space",
  "طارئ","خطر","حريق","انهيار","إصابة","سقوط","عاجل","فضاء محصور"];
const COMPLEX_KW = ["explain","compare","analyze","calculate","design","develop","strategy",
  "plan","assessment","difference between","how does","why does","what causes",
  "اشرح","قارن","حلل","صمم","استراتيجية","تقييم المخاطر","ما الفرق"];

export function isComplexOrUrgent(query: string): boolean {
  const l = query.toLowerCase();
  return URGENT_KW.some((k) => l.includes(k)) || COMPLEX_KW.some((k) => l.includes(k)) || query.length > 300;
}

export function detectLanguage(text: string): "ar" | "en" {
  const ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return ar > text.length * 0.18 ? "ar" : "en";
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const a: any = AbortSignal as any;
  return typeof a?.timeout === "function" ? a.timeout(ms) : undefined;
}

function cleanKey(value?: string): string {
  return (value || "").trim();
}

function cleanUrl(value?: string): string {
  return cleanKey(value).replace(/\/+$/, "");
}

function cleanFormattingSymbols(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/>{2,}/g, "")
    .replace(/-{2,}/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitIntoPoints(text: string): string[] {
  const normalized = cleanFormattingSymbols(text);
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const points: string[] = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s*(?:[0-9]+[.)]|[A-Za-z][.)]|[-•●▪◦]+)\s*/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) points.push(cleaned);
  }
  if (points.length > 1) return points;
  return normalized
    .split(/(?<=[.!?؟。])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatResponseSection(text: string): string {
  const cleaned = cleanFormattingSymbols(text);
  if (!cleaned) return "";
  const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let title = "";
  let body = cleaned;
  if (lines.length > 1 && !/^\s*(?:[0-9]+[.)]|[A-Za-z][.)]|[-•●▪◦]+)/u.test(lines[0]) && lines[0].length <= 80) {
    title = cleanFormattingSymbols(lines[0]);
    body = lines.slice(1).join("\n");
  }
  const points = splitIntoPoints(body).slice(0, 12);
  const numbered = points.map((point, index) => `${index + 1}. ${point}`).join("\n\n");
  return [title, numbered].filter(Boolean).join("\n\n");
}

function formatAIResponse(content: string): string {
  const cleaned = cleanFormattingSymbols(content);
  const bilingualMatch = cleaned.match(/([\s\S]*?)(?:\n\s*(?:English|EN)\s*:?\s*\n|\n\s*ENGLISH\s*:?\s*\n)([\s\S]*)/i);
  if (cleaned.includes("---EN---")) {
    const [ar, en] = cleaned.split("---EN---");
    return `Arabic\n\n${formatResponseSection(ar)}\n\nEnglish\n\n${formatResponseSection(en)}`.trim();
  }
  if (bilingualMatch && /[\u0600-\u06FF]/.test(bilingualMatch[1])) {
    return `Arabic\n\n${formatResponseSection(bilingualMatch[1])}\n\nEnglish\n\n${formatResponseSection(bilingualMatch[2])}`.trim();
  }
  return formatResponseSection(cleaned);
}

// ─── PROVIDER CALLERS ─────────────────────────────────────────────────────────
async function callProxyChat(
  provider: "groq" | "openrouter" | "gemini" | "nvidia" | "cerebras",
  modelId: string,
  messages: any[],
  imageBase64?: string,
  visionMimeType?: string,
  _clientKey?: string,
  geminiFileUri?: string
): Promise<string> {
  const base = proxyBaseUrl();
  const url = `${base}/api/chat`;
  const bodyObj: Record<string, unknown> = {
    provider,
    modelId,
    messages,
    imageBase64: imageBase64 || "",
    visionMimeType: (visionMimeType || "").trim(),
    systemPrompt: SYSTEM_PROMPT,
  };
  // Provider keys stay in server environment variables on web/Vercel.
  if (geminiFileUri) bodyObj.geminiFileUri = geminiFileUri;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
    signal: timeoutSignal(30000),
  });
  if (!res.ok) {
    const e = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${e.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const content = String(data?.content || "").trim();
  if (!content) throw new Error("Proxy returned no content");
  return content;
}

function isRetryableProviderError(err: unknown): boolean {
  const msg = typeof (err as any)?.message === "string" ? (err as any).message : "";
  if (!msg) return true;
  if (/^Proxy\s+\d+:/i.test(msg)) return true;
  if (/abort|timeout|network|failed to fetch/i.test(msg)) return true;
  const m = msg.match(/^(Groq|OpenRouter|Gemini|NVIDIA)\s+(\d+):/i);
  if (!m) return true;
  const status = Number(m[2]);
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

async function callGroq(apiKey: string, modelId: string, messages: any[], imageBase64?: string, apiKeysCtx?: any): Promise<string> {
  if (shouldUseServerProxy()) {
    return callProxyChat("groq", modelId, messages, imageBase64, undefined, apiKey);
  }
  const pool = getRotatedKeyPool("groq", apiKeysCtx || ({ groqApiKey: apiKey } as any));
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const out = await callGroqSingle(key, modelId, messages, imageBase64);
      reportProviderSuccess("groq");
      return out;
    } catch (e) {
      lastErr = e;
      reportProviderFailure("groq");
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("Groq call failed");
}

async function callGroqSingle(apiKey: string, modelId: string, messages: any[], imageBase64?: string): Promise<string> {
  const payload = imageBase64
    ? [...messages.slice(0,-1), {
        role: "user",
        content: [
          { type: "text", text: messages[messages.length-1].content },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      }]
    : messages;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages: payload, max_tokens: 2048, temperature: 0.7 }),
    signal: timeoutSignal(20000),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`Groq ${res.status}: ${e.slice(0,200)}`); }
  return (await res.json()).choices[0].message.content;
}

async function callOpenRouter(apiKey: string, modelId: string, messages: any[], imageBase64?: string): Promise<string> {
  if (shouldUseServerProxy()) {
    return callProxyChat("openrouter", modelId, messages, imageBase64, undefined, apiKey);
  }
  const pool = getRotatedKeyPool("openrouter", { openrouterApiKey: apiKey } as any);
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const out = await callOpenRouterSingle(key, modelId, messages, imageBase64);
      reportProviderSuccess("openrouter");
      return out;
    } catch (e) {
      lastErr = e;
      reportProviderFailure("openrouter");
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("OpenRouter call failed");
}

async function callOpenRouterSingle(apiKey: string, modelId: string, messages: any[], imageBase64?: string): Promise<string> {
  const payload = imageBase64
    ? [...messages.slice(0, -1), {
        role: "user",
        content: [
          { type: "text", text: messages[messages.length - 1].content },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      }]
    : messages;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://safegpt.app", "X-Title": "SafeGPT" },
    body: JSON.stringify({ model: modelId, messages: payload, max_tokens: 2048 }),
    signal: timeoutSignal(30000),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`OpenRouter ${res.status}: ${e.slice(0,200)}`); }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content;
}

async function callGemini(apiKey: string, modelId: string, messages: any[], imageBase64?: string, geminiFileUri?: string, visionMimeType?: string): Promise<string> {
  if (shouldUseServerProxy()) {
    return callProxyChat("gemini", modelId, messages, imageBase64, visionMimeType, apiKey, geminiFileUri);
  }
  const pool = getRotatedKeyPool("gemini", { geminiApiKey: apiKey } as any);
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const out = await callGeminiSingle(key, modelId, messages, imageBase64, visionMimeType, geminiFileUri);
      reportProviderSuccess("gemini");
      return out;
    } catch (e) {
      lastErr = e;
      reportProviderFailure("gemini");
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("Gemini call failed");
}

async function callGeminiSingle(
  apiKey: string,
  modelId: string,
  messages: any[],
  imageBase64?: string,
  visionMimeType?: string,
  geminiFileUri?: string
): Promise<string> {
  const contents = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  if (geminiFileUri && contents.length > 0) {
    // Prefer file URI (direct upload) — supports large files, no inline base64
    const mt = (visionMimeType || "video/mp4").trim() || "video/mp4";
    (contents[contents.length-1].parts as any[]).push({ file_data: { mime_type: mt, file_uri: geminiFileUri } });
  } else if (imageBase64 && contents.length > 0) {
    const mt = (visionMimeType || "image/jpeg").trim() || "image/jpeg";
    (contents[contents.length-1].parts as any[]).push({ inline_data: { mime_type: mt, data: imageBase64 } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      signal: timeoutSignal(30000),
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] } }) }
  );
  if (!res.ok) { const e = await res.text(); throw new Error(`Gemini ${res.status}: ${e.slice(0,200)}`); }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no content");
  return text;
}

async function callLocal(ngrokUrl: string, modelId: string, messages: any[], imageBase64?: string): Promise<string> {
  const msgs = messages.filter(m => m.role !== "system");
  if (imageBase64 && msgs.length > 0) {
    msgs[msgs.length-1] = { ...msgs[msgs.length-1], images: [imageBase64] };
  }
  const res = await fetch(`${cleanUrl(ngrokUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
    body: JSON.stringify({ model: modelId, messages: msgs, stream: false }),
    signal: timeoutSignal(30000),
  });
  if (!res.ok) throw new Error(`Local ${res.status}`);
  const data = await res.json();
  const content = data.message?.content || data.response || "";
  if (!content) throw new Error("Local model returned no content");
  return content;
}

// Routes local Ollama calls through the server-side /api/local proxy.
// The ngrok URL never reaches the browser — it lives only in NGROK_URL env var on Vercel.
async function callLocalProxy(modelId: string, messages: any[], imageBase64?: string): Promise<string> {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const res = await fetch(`${base}/api/local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, messages, imageBase64 }),
    signal: timeoutSignal(35000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Local proxy ${res.status}`);
  const content = data.content || "";
  if (!content) throw new Error("Local model returned no content");
  return content;
}

async function callNvidia(apiKey: string, modelId: string, messages: any[]): Promise<string> {
  if (shouldUseServerProxy()) {
    return callProxyChat("nvidia", modelId, messages, undefined, undefined, apiKey);
  }
  const pool = getRotatedKeyPool("nvidia", { nvidiaApiKey: apiKey } as any);
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const out = await callNvidiaSingle(key, modelId, messages);
      reportProviderSuccess("nvidia");
      return out;
    } catch (e) {
      lastErr = e;
      reportProviderFailure("nvidia");
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("NVIDIA call failed");
}

async function callNvidiaSingle(apiKey: string, modelId: string, messages: any[]): Promise<string> {
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 2048 }),
    signal: timeoutSignal(20000),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`NVIDIA ${res.status}: ${e.slice(0,200)}`); }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("NVIDIA returned no content");
  return content;
}

// ── Cerebras — OpenAI-compatible, key rotation, falls back to Groq GPT-OSS 120B ─
async function callCerebras(apiKey: string, modelId: string, messages: any[], apiKeysCtx?: any): Promise<string> {
  if (shouldUseServerProxy()) {
    return callProxyChat("cerebras", modelId, messages, undefined, undefined, apiKey);
  }
  const pool = getProviderKeyPool("cerebras", apiKeysCtx || ({ cerebrasApiKey: apiKey } as any));
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: modelId, messages, max_tokens: 2048, temperature: 0.7 }),
        signal: timeoutSignal(20000),
      });
      if (!res.ok) { const e = await res.text(); throw new Error(`Cerebras ${res.status}: ${e.slice(0,200)}`); }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Cerebras returned no content");
      reportProviderSuccess("cerebras" as any);
      return content;
    } catch (e) {
      lastErr = e;
      reportProviderFailure("cerebras" as any);
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("Cerebras call failed");
}

async function callModel(
  model: AIModel,
  apiKeys: ApiKeys,
  messages: any[],
  imageBase64?: string,
  visionMimeType?: string,
  geminiFileUri?: string
): Promise<string> {
  const { provider, modelId } = MODEL_CONFIGS[model];
  switch (provider) {
    case "groq":      if (shouldUseServerProxy()) return callProxyChat("groq", modelId, messages, imageBase64, undefined, cleanKey(apiKeys.groqApiKey));
                      if (!cleanKey(apiKeys.groqApiKey)) throw new Error("No Groq key"); return callGroq(cleanKey(apiKeys.groqApiKey), modelId, messages, imageBase64, apiKeys);
    case "openrouter":if (shouldUseServerProxy()) return callProxyChat("openrouter", modelId, messages, imageBase64, undefined, cleanKey(apiKeys.openrouterApiKey));
                      if (!cleanKey(apiKeys.openrouterApiKey)) throw new Error("No OR key"); return callOpenRouter(cleanKey(apiKeys.openrouterApiKey), modelId, messages, imageBase64);
    case "gemini":    {
      if (shouldUseServerProxy()) {
        return callProxyChat("gemini", modelId, messages, imageBase64, visionMimeType, cleanKey(apiKeys.geminiApiKey), geminiFileUri);
      }
      if (!cleanKey(apiKeys.geminiApiKey)) throw new Error("No Gemini key");
      const pool = getProviderKeyPool("gemini", { geminiApiKey: cleanKey(apiKeys.geminiApiKey) });
      let lastErr: any = null;
      for (const key of pool) {
        try {
          return await callGeminiSingle(key, modelId, messages, imageBase64, visionMimeType, geminiFileUri);
        } catch (e) {
          lastErr = e;
          if (!isRetryableProviderError(e)) break;
        }
      }
      throw lastErr || new Error("Gemini call failed");
    }
    case "local": {
      if (shouldUseServerProxy()) {
        return callLocalProxy(modelId, messages, imageBase64);
      }
      if (!cleanUrl(apiKeys.ngrokUrl)) throw new Error("No ngrok URL");
      return callLocal(cleanUrl(apiKeys.ngrokUrl), modelId, messages, imageBase64);
    }
    case "cerebras": {
      if (shouldUseServerProxy()) return callProxyChat("cerebras", modelId, messages, undefined, undefined, cleanKey((apiKeys as any).cerebrasApiKey));
      const cerebrasKey = cleanKey((apiKeys as any).cerebrasApiKey);
      if (!cerebrasKey) throw new Error("No Cerebras key");
      return callCerebras(cerebrasKey, modelId, messages, apiKeys);
    }
    case "nvidia":    if (shouldUseServerProxy()) return callProxyChat("nvidia", modelId, messages, undefined, undefined, cleanKey(apiKeys.nvidiaApiKey));
                      if (!cleanKey(apiKeys.nvidiaApiKey)) throw new Error("No NVIDIA key"); return callNvidia(cleanKey(apiKeys.nvidiaApiKey), modelId, messages);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ─── RAG SEARCH ───────────────────────────────────────────────────────────────
function extractArticleReference(query: string): string | null {
  const normalized = normalizeNumerals(query);
  const match = normalized.match(/(?:article|المادة|مادة)\s*(?:number|no\.?)?\s*[\(\[]?\s*([0-9]+)\s*[\)\]]?/i);
  return match?.[1] || null;
}

function articleHeadingRegex(articleRef: string): RegExp {
  const ar = toArabicIndicNumber(articleRef);
  const n = articleRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = ar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n|[.;:])\\s*((?:Article|ARTICLE|المادة)\\s*(?:number|no\\\\.?)?\\s*[\\\\(\\\\[]?\\s*(?:${n}|${a})\\s*[\\\\)\\\\]]?\\s*[:：.\\\\-–—]?)`, "i");
}

function anyArticleHeadingRegex(): RegExp {
  return /(?:^|\n|[.;:])\s*((?:Article|ARTICLE|المادة)\s*(?:number|no\.?)?\s*[\(\[]?\s*[0-9٠-٩۰-۹]+\s*[\)\]]?\s*[:：.\-–—]?)/gi;
}

function exactArticleChunkFromText(doc: { name: string; content?: string }, articleRef: string): RagChunk | null {
  const text = doc.content || "";
  if (!text) return null;
  const exact = articleHeadingRegex(articleRef).exec(text);
  if (!exact || exact.index === undefined) return null;
  const start = exact.index;
  const afterExact = start + exact[0].length;
  const rest = text.slice(afterExact);
  const nextRegex = anyArticleHeadingRegex();
  const next = nextRegex.exec(rest);
  const end = next?.index !== undefined ? afterExact + next.index : text.length;
  const section = text.slice(start, end).trim();
  if (!section) return null;
  return {
    id: `${doc.name}:article:${articleRef}:runtime`,
    text: section,
    normalizedText: normalizeNumerals(section).toLowerCase(),
    metadata: {
      document_name: doc.name,
      section_type: "legal_article",
      article_number: articleRef,
      article_number_ar: toArabicIndicNumber(articleRef),
    },
  };
}

function documentToChunk(doc: { name: string; content?: string }): RagChunk {
  const text = doc.content || "";
  return {
    id: doc.name,
    text,
    normalizedText: normalizeNumerals(text).toLowerCase(),
    metadata: { document_name: doc.name, section_type: "document" },
  };
}

function searchRag(docs: {name:string; content?:string; indexed:boolean; chunks?: RagChunk[]}[], query: string): string {
  const normalizedQuery = normalizeNumerals(query).toLowerCase();
  const articleRef = extractArticleReference(query);
  const words = normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
  const chunks = docs
    .filter(d => d.indexed && (d.chunks?.length || d.content))
    .flatMap(d => d.chunks?.length ? d.chunks : [documentToChunk(d)]);

  if (articleRef) {
    const exact = [
      ...chunks.filter((chunk) => chunk.metadata.article_number === articleRef),
      ...docs.map((doc) => exactArticleChunkFromText(doc, articleRef)).filter((chunk): chunk is RagChunk => !!chunk),
    ];
    if (exact.length) {
      return exact.slice(0, 1).map((chunk) => {
        const meta = chunk.metadata;
        const chunkText = isLawArticleChunk(chunk)
          ? chunk.text
          : chunk.text.slice(0, 6000);
        return `[Exact Article Match: true]\n[Document: ${meta.document_name}]\n[Section Type: ${meta.section_type}]\n[Article: ${meta.article_number}${meta.article_number_ar ? ` / ${meta.article_number_ar}` : ""}${meta.title ? `]\n[Title: ${meta.title}` : ""}]\n${chunkText}`;
      }).join("\n\n");
    }
    return `[Requested Article: ${articleRef} / ${toArabicIndicNumber(articleRef)}]\nNo exact matching article was found in the uploaded documents. Do not use another article as a substitute.`;
  }

  const scored = chunks
    .map(chunk => {
      const content = chunk.normalizedText || normalizeNumerals(chunk.text).toLowerCase();
      const metadataBoost = articleRef && chunk.metadata.article_number === articleRef ? 50 : 0;
      const score = words.filter(w => content.includes(w)).length + (content.includes(normalizedQuery) ? 5 : 0) + metadataBoost;
      return { chunk, score };
    })
    .filter(s => s.score > 0)
    .sort((a,b) => b.score - a.score);
  if (!scored.length) return "";
  return scored.slice(0,3).map(s => {
    const meta = s.chunk.metadata;
    const chunkText = isLawArticleChunk(s.chunk)
      ? s.chunk.text
      : s.chunk.text.slice(0, 6000);
    return `[Document: ${meta.document_name}]\n[Section Type: ${meta.section_type}${meta.article_number ? `]\n[Article: ${meta.article_number}${meta.article_number_ar ? ` / ${meta.article_number_ar}` : ""}` : ""}${meta.title ? `]\n[Title: ${meta.title}` : ""}]\n${chunkText}`;
  }).join("\n\n");
}

function wantsRagOverride(query: string): boolean {
  return /use\s+(?:rag|the\s+rag|rag\s+document|uploaded\s+document|the\s+uploaded\s+document|document)/i.test(query);
}

function requestedModelOrder(query: string, isVision: boolean): AIModel[] | null {
  const q = query.toLowerCase();
  // Vision is restricted to Gemini only (key rotation handled inside Gemini caller).
  if (isVision) return null;
  let preferred: AIModel[] | null = null;
  if (/gpt[-\s]?oss|oss[-\s]?120b|grok|groq/.test(q)) preferred = ["groq-gpt-oss-120b"];
  else if (/hermes/.test(q)) preferred = ["openrouter-hermes-405b"];
  else if (/deepseek|qwen/.test(q)) preferred = isVision ? ["openrouter-qwen2.5-vl-72b"] : ["openrouter-qwen3-plus"];
  else if (/openrouter/.test(q)) preferred = isVision ? ["openrouter-gemini-2.5-flash", "openrouter-qwen2.5-vl-72b"] : ["openrouter-hermes-405b", "openrouter-llama-3.3-70b", "openrouter-qwen3-plus"];
  else if (/llama/.test(q)) preferred = isVision ? ["local-llama3.2-vision"] : ["openrouter-llama-3.3-70b", "local-llama3.1-8b"];
  if (!preferred) return null;
  const standard = isVision ? VISION_FALLBACK_ORDER : FALLBACK_ORDER;
  return [...preferred, ...standard.filter((model) => !preferred.includes(model))];
}

// ─── CONFIDENCE CHECK ─────────────────────────────────────────────────────────
const LOW_CONFIDENCE_PHRASES = [
  "i don't know", "i do not know",
  "i cannot answer", "i can't answer",
  "i'm not sure", "i am not sure",
  "i'm uncertain", "i am uncertain",
  "i don't have information", "i do not have information",
  "i don't have enough", "i do not have enough",
  "i'm not aware", "i am not aware",
  "no reliable information", "insufficient information",
  "cannot provide", "unable to find", "cannot determine",
  "not enough data", "i apologize, but i don't",
  "لا أعلم", "لا أعرف", "غير متأكد", "لا تتوفر لديّ",
];

function isModelResponseConfident(response: string): boolean {
  const lc = response.toLowerCase();
  return !LOW_CONFIDENCE_PHRASES.some((phrase) => lc.includes(phrase));
}

function buildWebSearchPrompt(
  userMessage: string,
  searchResults: string,
  searchSource: string
): string {
  return (
    `[WEB SEARCH RESULTS — Source: ${searchSource}]\n${searchResults}\n\n` +
    `[USER QUESTION]\n${userMessage}\n\n` +
    `Answer the user's question using the web search results above. ` +
    `Focus on health and safety guidance relevant to construction sites. ` +
    `Cite sources where helpful. If the search results do not contain relevant information, ` +
    `rely on your own expertise.`
  );
}

// ─── WEB SEARCH COMMAND DETECTOR ──────────────────────────────────────────────
const WEB_SEARCH_PREFIXES = [
  /^search\s+the\s+web\s+for\s*:\s*/i,
  /^search\s+the\s+web\s+for\s+/i,
  /^web\s+search\s*:\s*/i,
  /^web\s+search\s+/i,
  /^search\s*:\s*/i,
  /^\/search\s+/i,
  /^ابحث\s+في\s+الويب\s*:\s*/,
  /^ابحث\s+على\s+الويب\s*:\s*/,
  /^ابحث\s+الويب\s*:\s*/,
];

export function detectWebSearchCommand(text: string): { isWebSearch: boolean; query: string } {
  for (const pattern of WEB_SEARCH_PREFIXES) {
    if (pattern.test(text)) {
      const query = text.replace(pattern, "").trim();
      if (query.length > 0) return { isWebSearch: true, query };
    }
  }
  return { isWebSearch: false, query: text };
}

// ─── DOC-ONLY COMMAND ────────────────────────────────────────────────────────
const DOC_ONLY_PREFIXES = [
  /^@doc\s+/i,
  /^@document\s+/i,
  /^doc:\s*/i,
  /^from\s+doc(?:ument)?:\s*/i,
  /^من\s+الوثيقة:\s*/,
  /^من\s+المستند:\s*/,
];

export function detectDocCommand(text: string): { isDocOnly: boolean; query: string } {
  for (const pattern of DOC_ONLY_PREFIXES) {
    if (pattern.test(text)) {
      const query = text.replace(pattern, "").trim();
      if (query.length > 0) return { isDocOnly: true, query };
    }
  }
  return { isDocOnly: false, query: text };
}

// ─── LIVE DATA DETECTOR ───────────────────────────────────────────────────────
const LIVE_DATA_PATTERNS: RegExp[] = [
  /\bnews\b/i,
  /\bweather\b/i,
  /\bstock\s+(?:price|market|rate)/i,
  /\b(?:bitcoin|btc|ethereum|eth|crypto|cryptocurrency)\b/i,
  /\bbreaking\b/i,
  /\bcurrent\s+(?:weather|price|rate|updates?|status|stock)\b/i,
  /\blatest\s+(?:update|report|news|development|regulation|standard)/i,
  /\blive\s+(?:price|rate|update|score)\b/i,
  /\btoday['s]?\s+(?:price|rate|news|update|weather)\b/i,
  /\breal[-\s]time\b/i,
  /الأخبار|الطقس|أسعار.*اليوم|المستجدات/,
  // ── Regional labor / employment law lookups ──────────────────────────────
  /\bsaudi\s+(?:labor|labour|employment|work)\s+law\b/i,
  /\b(?:uae|qatar|kuwait|bahrain|oman|gcc)\s+(?:labor|labour|employment)\s+law\b/i,
  /\bnظام\s+العمل\b/,          // "نظام العمل" — Saudi Labor Law
  /\bقانون\s+(?:العمل|التوظيف)\b/,  // "قانون العمل" — labor law (Arabic)
  /\bلائحة\s+\S+/,             // "لائحة X" — specific regulation (Arabic)
  // ── Specific article / section number lookups in any law / regulation ────
  /\b(?:labor|labour|employment|safety|construction|building)\s+law\s+(?:article|section|chapter|no\.?|#)?\s*\d+/i,
  /\b(?:article|section|clause)\s+\d+\s+(?:of\s+)?(?:the\s+)?(?:labor|labour|employment|safety|construction|saudi|uae|gcc)/i,
  /\bمادة\s+[\d٠-٩]+/,         // "مادة X" — Arabic article number
  /\bالمادة\s+[\d٠-٩]+/,       // "المادة X" — Arabic article with definite article
];

export function requiresLiveData(query: string): boolean {
  const lower = query.toLowerCase();
  if (/\bcurrent\b/.test(lower) && /\bupdate/.test(lower)) return true;
  // Specific law + article/section number anywhere in query
  if (
    /\b(?:saudi|uae|qatar|gcc|kuwait|bahrain|oman)\b/i.test(query) &&
    /\b(?:law|regulation|code|act|decree|نظام|قانون|لائحة)\b/i.test(query)
  ) return true;
  return LIVE_DATA_PATTERNS.some((p) => p.test(query));
}

// ─── SOURCE ATTRIBUTION HELPERS ───────────────────────────────────────────────
function visionSourceName(model: AIModel): string {
  if (model === "gemini-2.5-flash") return "Gemini";
  if (model === "openrouter-gemini-2.5-flash") return "Gemini";
  if (model === "openrouter-qwen2.5-vl-72b") return "Qwen2.5 VL";
  if (model === "local-llama3.2-vision") return "Local Llama Vision";
  return MODEL_CONFIGS[model].label;
}

function buildModelLabel(
  model: AIModel,
  isVision: boolean,
  searchSource?: "tavily" | "duckduckgo" | "none",
  sttSource?: string
): string {
  const modelName = MODEL_CONFIGS[model].label;
  let label: string;

  if (searchSource && searchSource !== "none") {
    const srcDisplay = searchSource === "tavily" ? "Tavily" : "DuckDuckGo";
    label = `Web Search: ${srcDisplay} • Model: ${modelName}`;
  } else if (isVision) {
    label = `Vision Source: ${visionSourceName(model)} • Model: ${modelName}`;
  } else {
    label = `Model: ${modelName}`;
  }

  if (sttSource) {
    label = `Speech Source: ${sttSource} • ${label}`;
  }

  return label;
}

// ─── EXPLICIT COMMAND PARSER ──────────────────────────────────────────────────

export interface ExplicitCommand {
  webSource?: "tavily" | "duckduckgo";
  visionModel?: AIModel;
  answerModel?: AIModel;
}

function resolveModelName(fragment: string): AIModel | null {
  const t = fragment.toLowerCase().replace(/[.\-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (/gpt[\s-]?oss[\s-]?120/.test(t))                              return "groq-gpt-oss-120b";
  if (/groq/.test(t) && /3[.\s]?3|70b/.test(t))                     return "groq-llama-3.3-70b";
  if (/groq/.test(t) && /3[.\s]?1|8b/.test(t))                      return "groq-llama-3.1-8b";
  if (/groq/.test(t))                                                return "groq-gpt-oss-120b";
  if (/hermes/.test(t))                                              return "openrouter-hermes-405b";
  if (/qwen[\s-]?3|qwen[\s-]?235|qwen[\s-]?plus/.test(t))           return "openrouter-qwen3-plus";
  if (/qwen[\s\w]*(?:vl|2\.?5[\s\w]*vl|vision)/.test(t))            return "openrouter-qwen2.5-vl-72b";
  if (/openrouter[\s\w]*llama|llama[\s\w]*openrouter/.test(t))       return "openrouter-llama-3.3-70b";
  if (/openrouter[\s\w]*gemini|gemini[\s\w]*openrouter/.test(t))     return "openrouter-gemini-2.5-flash";
  if (/gemini/.test(t))                                              return "gemini-2.5-flash";
  if (/llama[\s\w]*3[.\s]?3|3[.\s]?3[\s\w]*llama/.test(t))          return "openrouter-llama-3.3-70b";
  if (/llama[\s\w]*3[.\s]?1|3[.\s]?1[\s\w]*llama/.test(t))          return "groq-llama-3.1-8b";
  if (/\bllama\b/.test(t))                                           return "groq-llama-3.3-70b";
  if (/nvidia/.test(t))                                              return "nvidia-free";
  if (/\b(?:local|ollama|ngrok)\b/.test(t))                         return "local-llama3.1-8b";
  return null;
}

function detectExplicitVisionModel(fragment: string): AIModel | null {
  const t = fragment.toLowerCase();
  if (/qwen[\s\w]*(?:vl|vision)/.test(t))         return "openrouter-qwen2.5-vl-72b";
  if (/openrouter[\s\w]*gemini/.test(t))            return "openrouter-gemini-2.5-flash";
  if (/gemini/.test(t))                             return "gemini-2.5-flash";
  if (/local[\s\w]*vision|llama[\s\w]*vision/.test(t)) return "local-llama3.2-vision";
  return null;
}

export function parseExplicitCommands(query: string): ExplicitCommand | null {
  if (!/\b(?:use|using|tavily|duckduckgo|duck\s*duck\s*go|gemini\s+vision|qwen\s+(?:vl|vision)|answer\s+(?:it\s+)?using|respond\s+using|analyze\s+(?:with|using)|analyse\s+(?:with|using))\b/i.test(query)) {
    return null;
  }

  const cmd: ExplicitCommand = {};

  // ── Web source ───────────────────────────────────────────────────────────
  if (/\b(?:use\s+tavily|tavily\s+(?:search|to\s+answer|to\s+find)|search\s+(?:with|using)\s+tavily)\b/i.test(query)) {
    cmd.webSource = "tavily";
  } else if (/\b(?:use\s+(?:duck\s*duck\s*go|ddg)|duck\s*duck\s*go\s+(?:search|to\s+answer|to\s+find)|search\s+(?:with|using)\s+duck\s*duck\s*go)\b/i.test(query)) {
    cmd.webSource = "duckduckgo";
  }

  // ── Vision source ────────────────────────────────────────────────────────
  const visionMatch =
    /\bgemini\s+vision\b/i.exec(query) ||
    /\buse\s+gemini\s+(?:to\s+(?:analyze|analyse)|for\s+(?:vision|image|analysis))\b/i.exec(query) ||
    /\b(?:analyze|analyse)\s+(?:with|using)\s+(gemini|qwen\s*vl|qwen\s*vision)\b/i.exec(query) ||
    /\bqwen\s*(?:vl|2\.5\s*vl|vision)\b/i.exec(query);
  if (visionMatch) {
    const fragment = visionMatch[1] || visionMatch[0] || "";
    const vm = detectExplicitVisionModel(fragment);
    if (vm) cmd.visionModel = vm;
  }

  // ── Answer model (for multi-step or simple explicit selection) ───────────
  const answerPatterns: RegExp[] = [
    /\banswer\s+(?:it\s+)?(?:this\s+)?(?:question\s+)?(?:in\s+\S+\s+)?using\s+([^,.;\n]+)/i,
    /\brespond\s+using\s+([^,.;\n]+)/i,
    /\b(?:and|then)\s+(?:answer|respond|reply)\s+(?:(?:it|this)\s+)?(?:using|with)\s+([^,.;\n]+)/i,
    /\bgenerate\s+(?:the\s+)?(?:final\s+)?(?:response|answer)\s+(?:using|with)\s+([^,.;\n]+)/i,
  ];
  for (const pat of answerPatterns) {
    const m = pat.exec(query);
    if (m?.[1]) {
      const r = resolveModelName(m[1]);
      if (r) { cmd.answerModel = r; break; }
    }
  }

  // ── Simple "Use X" when nothing else matched ─────────────────────────────
  if (!cmd.answerModel && !cmd.visionModel && !cmd.webSource) {
    const simpleUse: RegExp[] = [
      /\buse\s+([^,.;\n]+?)\s+(?:to\s+(?:answer|respond)|for\s+(?:this|the\s+answer))\b/i,
      /\buse\s+([^,.;\n]+)/i,
      /\b(?:answer|respond)\s+(?:this\s+)?(?:question\s+)?(?:using|with)\s+([^,.;\n]+)/i,
    ];
    for (const pat of simpleUse) {
      const m = pat.exec(query);
      if (m?.[1]) {
        const fragment = m[1]
          .trim()
          .replace(/\s+(?:to\s+answer|to\s+respond|for\s+this).*$/i, "")
          .trim();
        if (/^(?:tavily|duckduckgo|duck\s*duck\s*go|gemini\s+vision|qwen\s+vision)$/i.test(fragment)) continue;
        const r = resolveModelName(fragment);
        if (r) { cmd.answerModel = r; break; }
      }
    }
  }

  if (!cmd.webSource && !cmd.visionModel && !cmd.answerModel) return null;
  return cmd;
}

async function handleExplicitCommand(
  cmd: ExplicitCommand,
  apiKeys: ApiKeys,
  userMessage: string,
  messages: any[],
  history: { role: string; content: string }[],
  isVision: boolean,
  imageBase64?: string,
  visionMimeType?: string,
  sttSource?: string
): Promise<{ content: string; model: string; ragUsed: boolean; ragSource: string }> {
  const unavailable = (model: AIModel) =>
    new Error(`Requested model unavailable: ${MODEL_CONFIGS[model].label}. Available quota or provider access has been exhausted.`);
  const sttPrefix = sttSource ? `Speech Source: ${sttSource} • ` : "";

  // ── Explicit web source ──────────────────────────────────────────────────
  if (cmd.webSource && !isVision) {
    let searchResp;
    try {
      searchResp = await performWebSearchForced(userMessage, (apiKeys.tavilyApiKey || "").trim(), cmd.webSource);
    } catch {
      searchResp = { results: [], source: cmd.webSource as "tavily" | "duckduckgo" | "none", query: userMessage };
    }
    if (searchResp.results.length > 0) {
      const searchPrompt = buildWebSearchPrompt(
        userMessage,
        formatSearchResultsForPrompt(searchResp.results),
        searchResp.source
      );
      const searchMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.slice(-6),
        { role: "user", content: searchPrompt },
      ];
      const answerOrder = cmd.answerModel ? [cmd.answerModel] : FALLBACK_ORDER;
      for (const model of answerOrder) {
        try {
          const raw = await callModel(model, apiKeys, searchMessages);
          const srcDisplay = cmd.webSource === "tavily" ? "Tavily" : "DuckDuckGo";
          return {
            content: formatAIResponse(raw),
            model: `${sttPrefix}Source: ${srcDisplay} • Model: ${MODEL_CONFIGS[model].label}`,
            ragUsed: false, ragSource: "",
          };
        } catch {
          if (cmd.answerModel) throw unavailable(cmd.answerModel);
        }
      }
    }
    if (cmd.answerModel) {
      try {
        const raw = await callModel(cmd.answerModel, apiKeys, messages);
        return {
          content: formatAIResponse(raw),
          model: `${sttPrefix}Model: ${MODEL_CONFIGS[cmd.answerModel].label}`,
          ragUsed: false, ragSource: "",
        };
      } catch { throw unavailable(cmd.answerModel); }
    }
    throw new Error(`${cmd.webSource === "tavily" ? "Tavily" : "DuckDuckGo"} returned no results for this query.`);
  }

  // ── Explicit vision source ───────────────────────────────────────────────
  if (cmd.visionModel && isVision) {
    let visionText: string;
    try {
      visionText = await callModel(cmd.visionModel, apiKeys, messages, imageBase64, visionMimeType);
    } catch { throw unavailable(cmd.visionModel); }

    const vSrc = visionSourceName(cmd.visionModel);
    if (cmd.answerModel) {
      const stepMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.slice(-6),
        { role: "user", content: `[IMAGE ANALYSIS from ${vSrc}]\n${visionText}\n\n[USER QUESTION]\n${userMessage}\n\nAnswer the user's question based on the image analysis.` },
      ];
      try {
        const raw = await callModel(cmd.answerModel, apiKeys, stepMessages);
        return {
          content: formatAIResponse(raw),
          model: `${sttPrefix}Source: ${vSrc} • Model: ${MODEL_CONFIGS[cmd.answerModel].label}`,
          ragUsed: false, ragSource: "",
        };
      } catch { throw unavailable(cmd.answerModel); }
    }
    return {
      content: formatAIResponse(visionText),
      model: `${sttPrefix}Source: ${vSrc} • Model: ${MODEL_CONFIGS[cmd.visionModel].label}`,
      ragUsed: false, ragSource: "",
    };
  }

  // ── Explicit answer model only ───────────────────────────────────────────
  if (cmd.answerModel) {
    try {
      const raw = await callModel(cmd.answerModel, apiKeys, messages, imageBase64, visionMimeType);
      const baseLabel = isVision
        ? `Source: ${visionSourceName(cmd.answerModel)} • Model: ${MODEL_CONFIGS[cmd.answerModel].label}`
        : `Model: ${MODEL_CONFIGS[cmd.answerModel].label}`;
      return {
        content: formatAIResponse(raw),
        model: `${sttPrefix}${baseLabel}`,
        ragUsed: false, ragSource: "",
      };
    } catch { throw unavailable(cmd.answerModel); }
  }

  throw new Error("Explicit command could not be executed.");
}

// ─── MAIN callAI ──────────────────────────────────────────────────────────────
export async function callAI(
  apiKeys: ApiKeys,
  userMessage: string,
  history: { role: string; content: string }[] = [],
  imageBase64?: string,
  ragDocuments?: { name: string; content?: string; indexed: boolean; chunks?: RagChunk[] }[],
  options?: { forceWebSearch?: boolean; forceRagOnly?: boolean; visionMimeType?: string; sttSource?: string; geminiFileUri?: string; forceDirectModel?: string }
): Promise<{ content: string; model: string; ragUsed: boolean; ragSource: string; citationWarning?: string | null }> {

  const isVision = !!imageBase64 || !!options?.geminiFileUri;
  const forceRagOnlyMode = options?.forceRagOnly === true || options?.forceDirectModel === "rag";
  const forceWebSearch = options?.forceWebSearch === true;
  const requestedArticleNumber = getRequestedArticleNumber(userMessage);
  const isUploadedArticleQuery =
    requestedArticleNumber !== null &&
    !!ragDocuments?.length &&
    !isVision &&
    !forceWebSearch;
  const forceRag =
    forceRagOnlyMode || wantsRagOverride(userMessage) || isUploadedArticleQuery;
  const isComplex = !forceRag && isComplexOrUrgent(userMessage);
  const sttSource = options?.sttSource;
  // Auto-trigger web search when query clearly requires live/current data (never in doc-only mode)
  // A numbered article query uses the uploaded knowledge base when documents exist,
  // rather than silently switching to live web results.
  const autoWebSearch =
    !isVision &&
    !forceWebSearch &&
    !forceRagOnlyMode &&
    !isUploadedArticleQuery &&
    !forceRag &&
    requiresLiveData(userMessage);

  // ── Doc-only mode: RAG retrieval → return result directly, no model loop, no web fallback ──
  if (forceRagOnlyMode) {
    if (!ragDocuments || ragDocuments.length === 0) {
      return {
        content: "📄 **No documents uploaded.**\n\nPlease upload a document first from the Documents tab, then try again.\n\n---EN---\n📄 **No documents uploaded.**\n\nPlease upload a document first from the Documents tab, then try again.",
        model: "📄 Doc-Only",
        ragUsed: false,
        ragSource: "",
      };
    }
    const ragResult = smartRetrieve(userMessage, ragDocuments);
    if (requestedArticleNumber !== null) {
      const articleChunk = ragResult.chunks.find((chunk) =>
        matchesRequestedArticle(chunk, requestedArticleNumber)
      );
      if (!articleChunk) {
        return {
          content: articleNotFoundMessage(requestedArticleNumber),
          model: "📄 Doc-Only",
          ragUsed: false,
          ragSource: "",
          citationWarning: null,
        };
      }
      const source = articleChunk.metadata.document_name || "Uploaded Documents";
      return {
        content: articleChunk.text,
        model: "📄 Doc-Only",
        ragUsed: true,
        ragSource: source,
        citationWarning: null,
      };
    }
    if (ragResult.notFound || !ragResult.text || ragResult.text.trim().length === 0) {
      const notFoundMsg = ragResult.notFound && (ragResult as any).message
        ? (ragResult as any).message
        : "This article or topic was not found in the uploaded documents. Please check the document contains this content and try re-uploading if needed.";
      return {
        content: `📄 **Not found in uploaded documents.**\n\n${notFoundMsg}`,
        model: "📄 Doc-Only",
        ragUsed: false,
        ragSource: "",
      };
    }
    const usedDocs = ragDocuments
      .filter((d) => d.indexed && ragResult.text.includes(d.name))
      .map((d) => d.name);
    const src = usedDocs.length > 0 ? usedDocs.join(", ") : "Uploaded Documents";
    const cit = verifyCitations(ragResult.text, ragResult.chunks);
    return {
      content: `📄 **From your documents** *(${src})*\n\n${ragResult.text}`,
      model: "📄 Doc-Only",
      ragUsed: true,
      ragSource: src,
      citationWarning: cit.warning,
    };
  }

  // ── @-menu direct model routing — bypass fallback, specific error on failure ──
  if (options?.forceDirectModel && options.forceDirectModel !== "rag") {
    const target = options.forceDirectModel;
    const directMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-12),
      { role: "user", content: userMessage },
    ];

    // Online search targets: Tavily or DuckDuckGo
    if (target === "tavily" || target === "duckduckgo") {
      const sourceName = target === "duckduckgo" ? "DuckDuckGo" : "Tavily Search";
      let searchResp;
      try {
        searchResp = await performWebSearchForced(
          userMessage,
          ((apiKeys as any).tavilyApiKey || "").trim(),
          target === "duckduckgo" ? "duckduckgo" : undefined
        );
      } catch {
        throw new Error(`@${sourceName} search failed. Check your internet connection.`);
      }
      if (!searchResp || searchResp.results.length === 0) {
        return {
          content: `🔍 **@${sourceName}** returned no results for this query.\n\nTry rephrasing your question, or use the other search option.`,
          model: `🔍 @${sourceName}`,
          ragUsed: false,
          ragSource: "",
        };
      }
      const searchPrompt = buildWebSearchPrompt(
        userMessage,
        formatSearchResultsForPrompt(searchResp.results),
        searchResp.source
      );
      const searchMsgs = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.slice(-6),
        { role: "user", content: searchPrompt },
      ];
      for (const m of FALLBACK_ORDER) {
        try {
          const raw = await callModel(m, apiKeys, searchMsgs);
          return {
            content: formatAIResponse(raw),
            model: buildModelLabel(m, false, searchResp.source as "tavily" | "duckduckgo" | "none", undefined),
            ragUsed: false,
            ragSource: "",
          };
        } catch { /* try next */ }
      }
      return {
        content: formatSearchResultsForPrompt(searchResp.results),
        model: `🔍 @${sourceName}`,
        ragUsed: false,
        ragSource: "",
      };
    }

    // Direct AI model — no fallback; throw with model name if it fails
    const modelKey = target as AIModel;
    if (!MODEL_CONFIGS[modelKey]) {
      throw new Error(`Unknown model key: @${target}. This model is not configured.`);
    }
    const label = MODEL_CONFIGS[modelKey].label;
    try {
      const raw = await callModel(modelKey, apiKeys, directMessages, imageBase64, options?.visionMimeType, options?.geminiFileUri);
      return {
        content: formatAIResponse(raw),
        model: `@${label}`,
        ragUsed: false,
        ragSource: "",
      };
    } catch (e: any) {
      throw new Error(`@${label} failed: ${e?.message || "Unknown error"}. Check this provider's API key in Settings.`);
    }
  }

  // ── Explicit command routing (user specified a model/source directly) ──────
  const explicitCmd = parseExplicitCommands(userMessage);
  if (explicitCmd) {
    const explicitMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-12),
      { role: "user", content: userMessage },
    ];
    return handleExplicitCommand(
      explicitCmd, apiKeys, userMessage, explicitMessages, history,
      isVision, imageBase64, options?.visionMimeType, sttSource
    );
  }

  let finalMessage = userMessage;
  let ragUsed = false;
  let ragSource = "";
  let ragChunks: RagChunk[] = [];
  let ragNotFound = false;

  // ── RAG injection (skip when forcing web search or auto web search) ────────
  if (!forceWebSearch && !autoWebSearch && !isVision && (!isComplex || forceRag) && ragDocuments && ragDocuments.length > 0) {
    const ragResult = smartRetrieve(userMessage, ragDocuments);
    ragNotFound = ragResult.notFound === true;
    ragChunks = ragResult.chunks;

    if (isUploadedArticleQuery) {
      const articleChunk = ragResult.chunks.find((chunk) =>
        matchesRequestedArticle(chunk, requestedArticleNumber!)
      );
      if (!articleChunk) {
        return {
          content: articleNotFoundMessage(requestedArticleNumber!),
          model: "📄 Document RAG",
          ragUsed: false,
          ragSource: "",
          citationWarning: null,
        };
      }
    }

    if (!ragNotFound && ragResult.text) {
      ragUsed = true;
      const usedDocs = ragDocuments
        .filter((d) => d.indexed && ragResult.text.includes(d.name))
        .map((d) => d.name);
      ragSource = usedDocs.length > 0 ? usedDocs.join(", ") : "Knowledge Base";
      const hasMatchingArticle =
        requestedArticleNumber !== null &&
        ragChunks.some((chunk) =>
          matchesRequestedArticle(chunk, requestedArticleNumber!)
        );
      finalMessage =
        `[KNOWLEDGE BASE – Prioritise this content when answering]\n${ragResult.text}\n\n` +
        `[USER QUESTION]\n${userMessage}\n\n` +
        (hasMatchingArticle
          ? `The user asked for Article ${requestedArticleNumber}. Return only the complete text of that exact article from the knowledge base above, exactly as provided. Do not summarize, shorten, translate, add commentary, or include another article. Do not use your training knowledge. If the exact article text is not present, respond with exactly: "${articleNotFoundMessage(requestedArticleNumber!)}".`
          : `Answer from the knowledge base above if the information is present. If this is an exact article match or the requested article was not found, use only that article status and do not guess from other articles. If no relevant knowledge base information is present, answer from your own expertise.`);
    }
  }

  // If RAG returned notFound for a structural/law query → skip models, go to web search
  const effectiveForceWebSearch = forceWebSearch || autoWebSearch || ragNotFound;

  const retrievedRequestedArticle =
    requestedArticleNumber === null
      ? undefined
      : ragChunks.find((chunk) =>
          matchesRequestedArticle(chunk, requestedArticleNumber!)
        );
  const hasRetrievedRequestedArticle = ragUsed && !!retrievedRequestedArticle;
  const activeSystemPrompt = hasRetrievedRequestedArticle
    ? `${SYSTEM_PROMPT}\n\n${buildStrictArticleRules(requestedArticleNumber!)}`
    : buildSystemPromptForQuery(userMessage, ragUsed);

  const messages = [
    { role: "system", content: activeSystemPrompt },
    ...history.slice(-12),
    { role: "user", content: finalMessage },
  ];

  const order = requestedModelOrder(userMessage, isVision) || (isVision ? VISION_FALLBACK_ORDER : FALLBACK_ORDER);

  let lowConfidenceResponse: { content: string; model: string } | null = null;

  // ── Model loop (skipped for forced/auto/notFound web search) ─────────────
  if (!effectiveForceWebSearch) {
    for (const model of order) {
      if (isVision && !MODEL_CONFIGS[model].supportsVision) continue;
      const attempts = 2; // reliability retry within same model before switching model
      for (let a = 0; a < attempts; a++) {
        try {
          const raw = await callModel(model, apiKeys, messages, imageBase64, options?.visionMimeType, options?.geminiFileUri);
          const formatted = hasRetrievedRequestedArticle
            ? raw.trim()
            : formatAIResponse(raw);
          if (isModelResponseConfident(raw)) {
            const cit =
              ragUsed && !hasRetrievedRequestedArticle
                ? verifyCitations(formatted, ragChunks)
                : { warning: null };
            return {
              content: formatted,
              model: buildModelLabel(model, isVision, undefined, sttSource),
              ragUsed,
              ragSource,
              citationWarning: cit.warning,
            };
          }
          if (!lowConfidenceResponse) {
            lowConfidenceResponse = { content: formatted, model: buildModelLabel(model, isVision, undefined, sttSource) };
          }
          console.log(`[CONFIDENCE] Low-confidence response from ${MODEL_CONFIGS[model].label} — triggering web search`);
          a = attempts; // exit retries
          break;
        } catch (e) {
          // Silent retry: provider layer rotates keys; if still failing, switch model.
          if (a === attempts - 1) {
            /* try next model */
          }
        }
      }
    }
  }

  // If all models fail or return low confidence, preserve the retrieved article
  // verbatim instead of falling through to web search or another source.
  if (hasRetrievedRequestedArticle && retrievedRequestedArticle) {
    return {
      content: retrievedRequestedArticle.text,
      model: "📄 Document RAG",
      ragUsed: true,
      ragSource: retrievedRequestedArticle.metadata.document_name || ragSource,
      citationWarning: null,
    };
  }

  // ── WEB SEARCH (forced/auto/low-confidence/notFound fallback, text only) ──
  if (!isVision) {
    try {
      // When RAG couldn't find the article, build a more targeted legal query
      const searchQuery = ragNotFound
        ? buildLegalSearchQuery(userMessage)
        : userMessage;
      const searchResp = await performWebSearch(searchQuery, (apiKeys.tavilyApiKey || "").trim());
      if (searchResp.results.length > 0) {
        console.log(`[WEB SEARCH] Using ${searchResp.source} results to re-generate answer${ragNotFound ? " (law article fallback)" : ""}`);
        const searchPrompt = buildWebSearchPrompt(
          userMessage,
          formatSearchResultsForPrompt(searchResp.results),
          searchResp.source
        );
        const searchMessages = [
          { role: "system", content: activeSystemPrompt },
          ...history.slice(-6),
          { role: "user", content: searchPrompt },
        ];
        for (const model of order) {
          try {
            const raw = await callModel(model, apiKeys, searchMessages);
            return {
              content: formatAIResponse(raw),
              model: buildModelLabel(model, false, searchResp.source, sttSource),
              ragUsed,
              ragSource,
              citationWarning: null,
            };
          } catch { /* try next model */ }
        }
      }
    } catch (e) {
      console.log("[WEB SEARCH] Web search fallback failed:", e);
    }

    // If ragNotFound AND web search also failed — return safety fallback
    if (ragNotFound) {
      return {
        content:
          "I could not find this in the provided document. Please check the source document directly.",
        model: "Safety Fallback",
        ragUsed: false,
        ragSource: "",
        citationWarning:
          "⚠️ Could not verify this from uploaded documents or web search.\n" +
          "Consult the source document or a qualified safety professional before acting on this.",
      };
    }
  }

  // Return the low-confidence response as last resort before throwing
  if (lowConfidenceResponse) {
    const cit = ragUsed ? verifyCitations(lowConfidenceResponse.content, ragChunks) : { warning: null };
    return {
      content: lowConfidenceResponse.content,
      model: lowConfidenceResponse.model,
      ragUsed,
      ragSource,
      citationWarning: cit.warning,
    };
  }

  throw new Error(
    "All AI models unavailable. Check Settings for API keys or ensure your home laptop is running."
  );
}

function sttFilenameForBlob(audioBlob: Blob): string {
  const t = (audioBlob.type || "").toLowerCase();
  if (t.includes("m4a") || t.includes("mp4") || t.includes("aac")) return "audio.m4a";
  if (t.includes("wav")) return "audio.wav";
  return "audio.webm";
}

// ─── STT – Groq Whisper → local fallback ─────────────────────────────────────
export async function transcribeAudio(apiKeys: ApiKeys, audioBlob: Blob): Promise<{ text: string; language: "en" | "ar" }> {
  const fname = sttFilenameForBlob(audioBlob);
  if (shouldUseServerProxy()) {
    const fd = new FormData();
    fd.append("file", audioBlob, fname);
    fd.append("model", "whisper-large-v3");
    fd.append("response_format", "verbose_json");
    const base = proxyBaseUrl();
    const url = `${base}/api/transcribe`;
    const res = await fetch(url, { method: "POST", body: fd, signal: timeoutSignal(30000) });
    if (!res.ok) {
      const e = await res.text().catch(() => "");
      throw new Error(`Proxy ${res.status}: ${e.slice(0, 200)}`);
    }
    const d: any = await res.json();
    const text = String(d?.text || "").trim();
    return { text, language: d?.language === "ar" ? "ar" : detectLanguage(text) };
  }

  const pool = getProviderKeyPool("groq", apiKeys);
  let lastErr: any = null;
  for (const key of pool) {
    try {
      const fd = new FormData();
      fd.append("file", audioBlob, fname);
      fd.append("model", "whisper-large-v3");
      fd.append("response_format", "verbose_json");
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: timeoutSignal(20000),
      });
      if (!res.ok) {
        const e = await res.text().catch(() => "");
        throw new Error(`Groq ${res.status}: ${e.slice(0, 200)}`);
      }
      const d: any = await res.json();
      const text = String(d?.text || "").trim();
      return { text, language: d?.language === "ar" ? "ar" : detectLanguage(text) };
    } catch (e) {
      lastErr = e;
      if (!isRetryableProviderError(e)) break;
    }
  }
  throw lastErr || new Error("Speech-to-text unavailable.");
}

export {
  splitTextForSpeech,
  speakText,
  speakEnglish,
  speakArabic,
  pauseSpeech,
  resumeSpeech,
  stopSpeech,
  isTtsSpeaking,
  isTtsPaused,
  subscribeTts,
  getActiveTtsMessageId,
  getLastTtsEngine,
} from "./ttsService";
export type { TtsUiState, TtsListenerPayload } from "./ttsService";

// ─── MODEL STATUS CHECK ───────────────────────────────────────────────────────
export async function checkModelStatus(apiKeys: ApiKeys): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const ngrok = cleanUrl(apiKeys.ngrokUrl);
  const probeMessages = [
    { role: "system", content: "Reply with OK only." },
    { role: "user", content: "OK?" },
  ];
  const probe = async (model: AIModel) => {
    try {
      const result = await callModel(model, apiKeys, probeMessages);
      return /\S/.test(result);
    } catch {
      return false;
    }
  };

  // Fetch server key status + counts (web only).
  // /api/status returns { groq: bool, groq_count: N, gemini: bool, gemini_count: N, ... }
  let serverHasKey: Record<string, any> = {};
  if (Platform.OS === 'web') {
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const sr = await fetch(`${origin}/api/status`, { signal: timeoutSignal(5000) });
      if (sr.ok) serverHasKey = await sr.json();
    } catch { /* ignore */ }
  }

  // Returns the server-reported key count for a provider (or 1 if keys exist but no count field)
  function srvCount(name: string): number {
    const cnt = serverHasKey[`${name}_count`];
    if (typeof cnt === "number") return cnt;
    return serverHasKey[name] ? 1 : 0;
  }

  await Promise.allSettled([
    // ── Groq ──────────────────────────────────────────────────────────────
    (async () => {
      const groqPool = getProviderKeyPool("groq", apiKeys);
      const groqKey1 = groqPool[0] || "";
      const serverGroqCount = srvCount("groq");
      const totalGroqCount = Math.max(groqPool.length, serverGroqCount);
      const GROQ_MODELS = ["groq-gpt-oss-120b","groq-llama-3.3-70b","groq-llama-3.1-8b","groq-whisper","groq-orpheus"];

      function setGroqKeys(online: boolean) {
        for (let i = 1; i <= Math.max(totalGroqCount, 1); i++) results[`groq-key-${i}`] = online;
      }

      if (!groqKey1 && serverGroqCount === 0) {
        GROQ_MODELS.forEach(k => results[k] = false);
        setGroqKeys(false);
        return;
      }
      if (!groqKey1 && serverGroqCount > 0) {
        // Keys are server-side — probe via proxy; all N keys share the result
        const ok = await probe("groq-llama-3.3-70b" as AIModel);
        GROQ_MODELS.forEach(k => results[k] = ok);
        setGroqKeys(ok);
        return;
      }
      // Has a client key — probe the Groq models endpoint directly
      let key1Online = false;
      try {
        const r = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${groqKey1}` },
          signal: timeoutSignal(10000),
        });
        key1Online = r.ok;
      } catch { key1Online = false; }
      GROQ_MODELS.forEach(k => results[k] = key1Online);
      results["groq-key-1"] = key1Online;
      // Check each additional client key individually
      for (let i = 1; i < groqPool.length; i++) {
        try {
          const r = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { Authorization: `Bearer ${groqPool[i]}` },
            signal: timeoutSignal(10000),
          });
          results[`groq-key-${i + 1}`] = r.ok;
        } catch { results[`groq-key-${i + 1}`] = false; }
      }
    })(),

    // ── OpenRouter ─────────────────────────────────────────────────────────
    (async () => {
      const orPool = getProviderKeyPool("openrouter", apiKeys);
      const serverORCount = srvCount("openrouter");
      if (orPool.length === 0 && serverORCount === 0) {
        ["openrouter-hermes","openrouter-llama","openrouter-qwen3","openrouter-gemini","openrouter-qwen-vl","openrouter-deepseek"].forEach(k => results[k]=false);
        results["openrouter-key-1"] = false;
        return;
      }
      results["openrouter-hermes"]   = await probe("openrouter-hermes-405b");
      results["openrouter-llama"]    = await probe("openrouter-llama-3.3-70b");
      results["openrouter-qwen3"]    = await probe("openrouter-qwen3-plus");
      results["openrouter-gemini"]   = await probe("openrouter-gemini-2.5-flash");
      results["openrouter-qwen-vl"]  = await probe("openrouter-qwen2.5-vl-72b");
      results["openrouter-deepseek"] = await probe("openrouter-deepseek-r1");
      // Derive per-key status from model probes
      const totalORCount = Math.max(orPool.length, serverORCount, 1);
      const anyOROnline = ["openrouter-hermes","openrouter-llama","openrouter-qwen3","openrouter-deepseek"].some(m => results[m] === true);
      for (let i = 1; i <= totalORCount; i++) results[`openrouter-key-${i}`] = anyOROnline;
    })(),

    // ── Gemini ─────────────────────────────────────────────────────────────
    (async () => {
      const geminiPool = getProviderKeyPool("gemini", apiKeys);
      const geminiKey1 = geminiPool[0] || "";
      const serverGeminiCount = srvCount("gemini");
      const totalGeminiCount = Math.max(geminiPool.length, serverGeminiCount);

      function setGeminiKeys(online: boolean) {
        for (let i = 1; i <= Math.max(totalGeminiCount, 1); i++) results[`gemini-key-${i}`] = online;
      }

      if (!geminiKey1 && serverGeminiCount === 0) {
        results["gemini-2.5-flash"] = false;
        setGeminiKeys(false);
        return;
      }
      if (!geminiKey1 && serverGeminiCount > 0) {
        const ok = await probe("gemini-2.5-flash" as AIModel);
        results["gemini-2.5-flash"] = ok;
        setGeminiKeys(ok);
        return;
      }
      // Has a client key — probe
      const ok = await probe("gemini-2.5-flash");
      results["gemini-2.5-flash"] = ok;
      results["gemini-key-1"] = ok;
      // Check each additional client key individually
      for (let i = 1; i < geminiPool.length; i++) {
        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiPool[i])}`,
            { signal: timeoutSignal(10000) }
          );
          results[`gemini-key-${i + 1}`] = r.ok;
        } catch { results[`gemini-key-${i + 1}`] = false; }
      }
    })(),

    // ── Local Ollama ────────────────────────────────────────────────────────
    (async () => {
      try {
        let models: string[] = [];
        let online = false;
        if (shouldUseServerProxy()) {
          const base = typeof window !== "undefined" ? window.location.origin : "";
          const r = await fetch(`${base}/api/local`, { signal: timeoutSignal(10000) });
          if (r.ok) { const d = await r.json(); online = d.online ?? false; models = d.models ?? []; }
        } else {
          if (!ngrok) { results["local-llama3.2-vision"]=false; results["local-llama3.1-8b"]=false; results["local-whisper"]=false; return; }
          const r = await fetch(`${ngrok}/api/tags`, { signal: timeoutSignal(5000), headers: { "ngrok-skip-browser-warning": "1" } });
          if (r.ok) { const d = await r.json(); online = true; models = d?.models?.map((m: any) => m.name) || []; }
        }
        if (!online && models.length === 0) { results["local-llama3.2-vision"]=false; results["local-llama3.1-8b"]=false; results["local-whisper"]=false; return; }
        results["local-llama3.2-vision"] = models.some(m => m.includes("llama3.2") || m.includes("vision"));
        results["local-llama3.1-8b"]     = models.some(m => m.includes("llama3.1") || m.includes("llama"));
        results["local-whisper"]          = models.some(m => m.toLowerCase().includes("whisper"));
      } catch { results["local-llama3.2-vision"]=false; results["local-llama3.1-8b"]=false; results["local-whisper"]=false; }
    })(),

    // ── Cerebras ────────────────────────────────────────────────────────────
    (async () => {
      const cerebrasPool = getProviderKeyPool("cerebras", apiKeys);
      const cerebrasKey1 = cerebrasPool[0] || "";
      const serverCerebrasCount = srvCount("cerebras");
      const totalCerebrasCount = Math.max(cerebrasPool.length, serverCerebrasCount);
      const CEREBRAS_MODELS = ["cerebras-gpt-oss-120b"];

      function setCerebrasKeys(online: boolean) {
        for (let i = 1; i <= Math.max(totalCerebrasCount, 1); i++) results[`cerebras-key-${i}`] = online;
      }

      if (!cerebrasKey1 && serverCerebrasCount === 0) {
        CEREBRAS_MODELS.forEach(k => results[k] = false);
        setCerebrasKeys(false);
        return;
      }
      if (!cerebrasKey1 && serverCerebrasCount > 0) {
        const ok = await probe("cerebras-gpt-oss-120b" as AIModel);
        CEREBRAS_MODELS.forEach(k => results[k] = ok);
        setCerebrasKeys(ok);
        return;
      }
      // Has a client key — probe Cerebras models endpoint directly
      let key1Online = false;
      try {
        const r = await fetch("https://api.cerebras.ai/v1/models", {
          headers: { Authorization: `Bearer ${cerebrasKey1}` },
          signal: timeoutSignal(10000),
        });
        key1Online = r.ok;
      } catch { key1Online = false; }
      CEREBRAS_MODELS.forEach(k => results[k] = key1Online);
      results["cerebras-key-1"] = key1Online;
      for (let i = 1; i < cerebrasPool.length; i++) {
        try {
          const r = await fetch("https://api.cerebras.ai/v1/models", {
            headers: { Authorization: `Bearer ${cerebrasPool[i]}` },
            signal: timeoutSignal(10000),
          });
          results[`cerebras-key-${i + 1}`] = r.ok;
        } catch { results[`cerebras-key-${i + 1}`] = false; }
      }
    })(),

    // ── NVIDIA ─────────────────────────────────────────────────────────────
    (async () => {
      const nvidiaPool = getProviderKeyPool("nvidia", apiKeys);
      const nvidiaKey1 = nvidiaPool[0] || "";
      const serverNvidiaCount = srvCount("nvidia");
      const totalNvidiaCount = Math.max(nvidiaPool.length, serverNvidiaCount);
      if (!nvidiaKey1 && serverNvidiaCount === 0) {
        results["nvidia-free"] = false;
        results["nvidia-key-1"] = false;
        return;
      }
      if (!nvidiaKey1 && serverNvidiaCount > 0) {
        const ok = await probe("nvidia-free" as AIModel);
        results["nvidia-free"] = ok;
        for (let i = 1; i <= Math.max(totalNvidiaCount, 1); i++) results[`nvidia-key-${i}`] = ok;
        return;
      }
      let nvidiaOnline = false;
      try {
        const r = await fetch("https://integrate.api.nvidia.com/v1/models", {
          headers: { Authorization: `Bearer ${cleanKey(nvidiaKey1)}` },
          signal: timeoutSignal(10000),
        });
        nvidiaOnline = r.ok;
      } catch { nvidiaOnline = true; }
      results["nvidia-free"] = nvidiaOnline;
      for (let i = 1; i <= Math.max(totalNvidiaCount, 1); i++) results[`nvidia-key-${i}`] = nvidiaOnline;
    })(),
  ]);

  if (Platform.OS === "web") {
    results["web-speech-tts"] = typeof window !== "undefined" && "speechSynthesis" in window;
    results["puter-tts"] = typeof window !== "undefined" && !!(window as any).puter;
  } else {
    results["web-speech-tts"] = true;
    results["puter-tts"] = false;
  }
  results["rag-knowledge-base"] = true;

  // ── Tavily: presence check only (not probed — /api/tavily-status handles detail) ──
  const tavilyPool = getProviderKeyPool("tavily", apiKeys);
  const serverTavilyCount = srvCount("tavily");
  const totalTavilyCount = Math.max(tavilyPool.length, serverTavilyCount);
  for (let i = 0; i < Math.max(totalTavilyCount, 1); i++) {
    const configured = i === 0
      ? (Boolean(tavilyPool[0]) || serverTavilyCount > 0)
      : Boolean(tavilyPool[i]);
    results[`tavily-key-${i + 1}`] = configured;
  }
  results["duckduckgo"] = true;
  results["tavily"] = Boolean(tavilyPool[0]) || serverTavilyCount > 0;

  return results;
}
