/**
 * SafeGPT — Server-side Chat Proxy
 *
 * Proxies requests to Groq, OpenRouter, NVIDIA, and Gemini.
 * API keys are read ONLY from server-side environment variables.
 * They are NEVER sent to or from the browser.
 *
 * Vercel setup — add these in Vercel Dashboard > Settings > Environment Variables:
 *   GROQ_API_KEYS        = gsk_key1,gsk_key2,gsk_key3
 *   OPENROUTER_API_KEYS  = sk-or-key1,sk-or-key2
 *   NVIDIA_API_KEYS      = nvapi-key1
 *   GEMINI_API_KEYS      = AIzaKey1,AIzaKey2,AIzaKey3
 *   EXPO_PUBLIC_USE_SERVER_PROXY = 1
 */

import { secureJson, secureHeaders, validateMessages, sanitizeString, ALLOWED_PROVIDERS } from '../../server/security';

function parseEnvKeys(base: string): string[] {
  const multi = (process.env[`${base}_API_KEYS`] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (multi.length > 0) return multi;
  const keys: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const val = (process.env[`${base}_API_KEY_${i}`] ?? '').trim();
    if (!val) break;
    keys.push(val);
  }
  return keys;
}

function getKeyPool(provider: string): string[] {
  return parseEnvKeys(provider.toUpperCase());
}

function getProviderUrl(provider: string): string {
  switch (provider) {
    case 'groq':       return 'https://api.groq.com/openai/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    case 'nvidia':     return 'https://integrate.api.nvidia.com/v1/chat/completions';
    case 'cerebras':   return 'https://api.cerebras.ai/v1/chat/completions';
    default:           return '';
  }
}

function buildHeaders(provider: string, key: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (provider === 'openrouter') {
    h['HTTP-Referer'] = 'https://safegpt.app';
    h['X-Title'] = 'SafeGPT';
  }
  return h;
}

// ─── Convert OpenAI-style messages → Gemini `contents` format ─────────────────
function toGeminiContents(messages: any[], imageBase64?: string, visionMimeType?: string, geminiFileUri?: string) {
  const systemParts: string[] = [];
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : '');
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    contents.push({ role, parts: [{ text }] });
  }

  if (geminiFileUri && visionMimeType && contents.length > 0) {
    // Prefer file URI (direct upload) — no inline base64, supports large files
    const last = contents[contents.length - 1];
    if (last.role === 'user') {
      last.parts.push({ file_data: { mime_type: visionMimeType, file_uri: geminiFileUri } });
    }
  } else if (imageBase64 && visionMimeType && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') {
      last.parts.push({ inline_data: { mime_type: visionMimeType, data: imageBase64 } });
    }
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n') }] } : undefined,
  };
}

// ─── Gemini proxy (key rotation) ──────────────────────────────────────────────
async function handleGemini(
  modelId: string,
  messages: any[],
  imageBase64?: string,
  visionMimeType?: string,
  geminiFileUri?: string
): Promise<Response> {
  const keys = getKeyPool('gemini');
  if (keys.length === 0) {
    return secureJson({ error: 'No server-side Gemini key. Add GEMINI_API_KEYS to Vercel env vars.' }, 503);
  }

  const { contents, systemInstruction } = toGeminiContents(messages, imageBase64, visionMimeType, geminiFileUri);
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  let lastStatus = 503;
  for (const key of keys) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', ...secureHeaders() } });
      }
      if (res.status !== 429 && res.status !== 503) {
        return secureJson(await res.json().catch(() => ({})), res.status);
      }
    } catch { /* try next key */ }
  }
  return secureJson({ error: 'All Gemini keys exhausted.' }, lastStatus);
}

// ─── Main handler ──────────────────────────────────────────────────────────────
export async function POST(request: Request): Promise<Response> {
  try {
    // ── Parse body ──────────────────────────────────────────────────────────
    let body: any;
    try {
      body = await request.json();
    } catch {
      return secureJson({ error: 'Invalid JSON body.' }, 400);
    }

    const { provider, modelId, messages, imageBase64, visionMimeType, geminiFileUri } = body;

    // ── Validate required fields ────────────────────────────────────────────
    if (typeof provider !== 'string' || !provider.trim()) {
      return secureJson({ error: 'Missing required field: provider' }, 400);
    }
    if (!ALLOWED_PROVIDERS.has(provider.trim())) {
      return secureJson({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return secureJson({ error: 'Missing required field: modelId' }, 400);
    }
    const msgError = validateMessages(messages);
    if (msgError) {
      return secureJson({ error: `Invalid messages: ${msgError}` }, 400);
    }

    // Sanitize modelId (no control chars or injection)
    const cleanModelId = sanitizeString(modelId.trim());

    // ── Gemini uses a different API format ─────────────────────────────────
    if (provider.trim() === 'gemini') {
      return handleGemini(cleanModelId, messages, imageBase64, visionMimeType, typeof geminiFileUri === 'string' ? geminiFileUri : undefined);
    }

    // ── OpenAI-compatible providers (Groq, OpenRouter, NVIDIA) ─────────────
    const url = getProviderUrl(provider.trim());
    if (!url) {
      return secureJson({ error: `Unsupported provider: ${provider}` }, 400);
    }

    const keys = getKeyPool(provider.trim());
    if (keys.length === 0) {
      return secureJson({
        error: `No server-side key for ${provider}. Add ${provider.toUpperCase()}_API_KEYS to Vercel env vars.`,
      }, 503);
    }

    let finalMessages = messages;
    if (imageBase64 && visionMimeType) {
      const last = messages[messages.length - 1];
      finalMessages = [
        ...messages.slice(0, -1),
        {
          ...last,
          content: [
            { type: 'image_url', image_url: { url: `data:${visionMimeType};base64,${imageBase64}` } },
            { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
          ],
        },
      ];
    }

    const providerBody = { model: cleanModelId, messages: finalMessages, max_tokens: 2048, temperature: 0.7 };

    let lastStatus = 503;
    for (const key of keys) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(provider.trim(), key),
          body: JSON.stringify(providerBody),
        });
        lastStatus = res.status;
        if (res.ok) {
          const data = await res.json();
          return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', ...secureHeaders() } });
        }
        if (res.status !== 429 && res.status !== 503) {
          return secureJson(await res.json().catch(() => ({})), res.status);
        }
      } catch { /* try next */ }
    }
    return secureJson({ error: `All ${provider} keys exhausted.` }, lastStatus);

  } catch (err: any) {
    return secureJson({ error: 'Internal proxy error' }, 500);
  }
}
