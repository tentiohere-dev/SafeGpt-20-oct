/**
 * SafeGPT — Local Ollama / ngrok Server-side Proxy
 *
 * Routes all Ollama requests through this server function.
 * The ngrok URL lives ONLY in NGROK_URL env var — never sent to the browser.
 *
 * Vercel setup:
 *   NGROK_URL = https://xxxx.ngrok-free.app   (your ngrok tunnel URL)
 *   EXPO_PUBLIC_USE_SERVER_PROXY = 1
 *
 * Security controls applied:
 * - ngrok URL is server-side only — completely hidden from browser
 * - Message structure validation (rejects malformed payloads)
 * - 35-second Ollama timeout
 * - Security response headers on all responses
 *
 * NOTE: No rate limiting applied — this is an AI proxy endpoint.
 * Rate limiting applies only to authentication routes per policy.
 */

import { secureJson, secureHeaders, validateMessages, sanitizeString } from '../../server/security';

const REQUEST_TIMEOUT = 35_000; // 35s — generous for slow local models

// ─── GET — Ollama status / available models ───────────────────────────────────
export async function GET(request: Request): Promise<Response> {
  const ngrok = (process.env.NGROK_URL ?? '').trim().replace(/\/+$/, '');
  if (!ngrok) {
    return secureJson({ online: false, models: [], error: 'NGROK_URL not configured.' });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${ngrok}/api/tags`, {
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return secureJson({ online: false, models: [], error: `Ollama ${res.status}` });
    const data = await res.json();
    const models: string[] = (data?.models ?? []).map((m: any) => String(m.name ?? ''));
    return secureJson({ online: true, models });
  } catch (err: any) {
    return secureJson({ online: false, models: [], error: err?.message ?? 'Unreachable' });
  }
}

// ─── POST — proxy chat to Ollama ──────────────────────────────────────────────
export async function POST(request: Request): Promise<Response> {
  // ── ngrok URL (server-side only) ──────────────────────────────────────────
  const ngrok = (process.env.NGROK_URL ?? '').trim().replace(/\/+$/, '');
  if (!ngrok) {
    return secureJson({
      error: 'Local model not configured. Add NGROK_URL to Vercel environment variables.',
    }, 503);
  }

  // ── Parse and validate body ───────────────────────────────────────────────
  let body: any;
  try {
    body = await request.json();
  } catch {
    return secureJson({ error: 'Invalid JSON body.' }, 400);
  }

  const { modelId, messages, imageBase64 } = body;

  if (typeof modelId !== 'string' || !modelId.trim()) {
    return secureJson({ error: 'Missing required field: modelId.' }, 400);
  }

  // Validate message structure — important for security (prevents injection)
  // No size limits applied — supports long document analysis conversations
  const msgError = validateMessages(messages);
  if (msgError) {
    return secureJson({ error: `Invalid messages: ${msgError}` }, 400);
  }

  const cleanModelId = sanitizeString(modelId.trim());

  // ── Build Ollama payload ──────────────────────────────────────────────────
  const ollamaMessages = messages.filter((m: any) => m.role !== 'system');
  if (imageBase64 && ollamaMessages.length > 0) {
    const last = ollamaMessages[ollamaMessages.length - 1];
    ollamaMessages[ollamaMessages.length - 1] = { ...last, images: [imageBase64] };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const res = await fetch(`${ngrok}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '1',
      },
      body: JSON.stringify({ model: cleanModelId, messages: ollamaMessages, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return secureJson({ error: `Ollama ${res.status}: ${text.slice(0, 200)}` }, res.status);
    }

    const data = await res.json();
    const content = data?.message?.content || data?.response || '';
    if (!content) {
      return secureJson({ error: 'Local model returned no content.' }, 502);
    }

    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...secureHeaders() },
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return secureJson({ error: 'Local model request timed out (35s).' }, 504);
    }
    return secureJson({ error: 'Could not reach local Ollama instance.' }, 502);
  }
}
