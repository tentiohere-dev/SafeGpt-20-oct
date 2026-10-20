/**
 * SafeGPT — Gemini Server-side Proxy
 *
 * Proxies Gemini vision/chat requests.
 * Keys read from GEMINI_API_KEYS env var — never exposed to the browser.
 *
 * Vercel setup:
 *   GEMINI_API_KEYS = AIzaKey1,AIzaKey2,AIzaKey3
 *   EXPO_PUBLIC_USE_SERVER_PROXY = 1
 */

import { secureJson, secureHeaders, sanitizeString } from '../../server/security';

function parseEnvKeys(): string[] {
  const multi = (process.env['GEMINI_API_KEYS'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (multi.length > 0) return multi;
  return [
    process.env['GEMINI_API_KEY_1'] ?? '',
    process.env['GEMINI_API_KEY_2'] ?? '',
    process.env['GEMINI_API_KEY_3'] ?? '',
  ].filter(Boolean);
}

export async function POST(request: Request): Promise<Response> {
  try {
    // ── Parse body ──────────────────────────────────────────────────────────
    let body: any;
    try {
      body = await request.json();
    } catch {
      return secureJson({ error: 'Invalid JSON body.' }, 400);
    }

    const { modelId, contents, systemInstruction, imageBase64, mimeType } = body;

    // ── Validate required fields ────────────────────────────────────────────
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return secureJson({ error: 'Missing required field: modelId' }, 400);
    }
    if (!Array.isArray(contents) || contents.length === 0) {
      return secureJson({ error: 'Missing required field: contents (must be a non-empty array)' }, 400);
    }
    // Validate each content turn has a valid role and parts
    for (let i = 0; i < contents.length; i++) {
      const c = contents[i];
      if (typeof c !== 'object' || c === null) {
        return secureJson({ error: `contents[${i}] must be an object` }, 400);
      }
      if (!['user', 'model'].includes(c.role)) {
        return secureJson({ error: `contents[${i}] has invalid role: ${String(c.role)}` }, 400);
      }
      if (!Array.isArray(c.parts)) {
        return secureJson({ error: `contents[${i}].parts must be an array` }, 400);
      }
    }

    const cleanModelId = sanitizeString(modelId.trim());

    const keys = parseEnvKeys();
    if (keys.length === 0) {
      return secureJson({ error: 'No server-side Gemini key. Add GEMINI_API_KEYS to Vercel env vars.' }, 503);
    }

    let lastStatus = 503;

    for (const key of keys) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModelId)}:generateContent?key=${encodeURIComponent(key)}`;

        let finalContents = contents;
        if (imageBase64 && mimeType) {
          const last = contents[contents.length - 1];
          const parts = Array.isArray(last?.parts) ? [...last.parts] : [];
          parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
          finalContents = [...contents.slice(0, -1), { ...last, parts }];
        }

        const geminiBody: Record<string, unknown> = { contents: finalContents };
        if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody),
        });

        lastStatus = res.status;

        if (res.ok) {
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...secureHeaders() },
          });
        }

        if (res.status !== 429 && res.status !== 503) {
          return secureJson(await res.json().catch(() => ({})), res.status);
        }
      } catch {
        // network error — try next key
      }
    }

    return secureJson({ error: 'All Gemini keys exhausted or rate-limited.' }, lastStatus);
  } catch (err: any) {
    return secureJson({ error: 'Internal Gemini proxy error' }, 500);
  }
}
