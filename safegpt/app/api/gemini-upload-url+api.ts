/**
 * SafeGPT — Gemini Resumable Upload Session Initiator
 *
 * Returns a short-lived Gemini resumable-upload URL so the browser / device
 * can stream a file directly to Gemini — the API key never leaves the server.
 *
 * Flow:
 *   1. Client POSTs { mimeType, fileName } to this endpoint.
 *   2. Server calls Gemini with the API key and receives an upload session URL.
 *   3. Server returns { uploadUrl } — no key in the URL.
 *   4. Client PUTs the raw file bytes to uploadUrl directly (no Vercel relay).
 *   5. Gemini responds with the file URI (e.g. https://…/v1beta/files/abc).
 *   6. Client passes that URI to /api/chat as geminiFileUri.
 */

import { secureJson, secureHeaders } from '../../server/security';

function parseEnvKeys(): string[] {
  const multi = (process.env['GEMINI_API_KEYS'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (multi.length > 0) return multi;
  const keys: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const val = (process.env[`GEMINI_API_KEY_${i}`] ?? '').trim();
    if (!val) break;
    keys.push(val);
  }
  return keys;
}

export async function POST(request: Request): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch {
    return secureJson({ error: 'Invalid JSON body.' }, 400);
  }

  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim() : '';
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : 'upload';

  if (!mimeType) return secureJson({ error: 'Missing mimeType' }, 400);

  const keys = parseEnvKeys();
  if (keys.length === 0) {
    return secureJson({ error: 'No Gemini API key configured on server.' }, 503);
  }

  for (const key of keys) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file: { displayName: fileName } }),
        }
      );

      if (!res.ok) {
        if (res.status === 429 || res.status === 403 || res.status === 401) continue;
        const errText = await res.text().catch(() => '');
        return secureJson({ error: `Gemini error ${res.status}` }, res.status);
      }

      const uploadUrl = res.headers.get('X-Goog-Upload-URL') || res.headers.get('location') || '';
      if (!uploadUrl) return secureJson({ error: 'Gemini did not return an upload URL' }, 500);

      return new Response(JSON.stringify({ uploadUrl }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...secureHeaders() },
      });
    } catch {
      continue;
    }
  }

  return secureJson({ error: 'All Gemini keys exhausted when creating upload session.' }, 503);
}
