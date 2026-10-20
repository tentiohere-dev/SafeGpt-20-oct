/**
 * SafeGPT — Shared API Security Utilities
 *
 * Used by all server-side API route handlers.
 * Provides: secure response headers, input validation, sanitization.
 *
 * Lives outside app/ so Expo Router does not attempt to treat it as a route.
 */

// ─── Security response headers ────────────────────────────────────────────────
export function secureHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  };
}

/** Respond with JSON and full security headers. */
export function secureJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...secureHeaders() },
  });
}

// ─── Input sanitization ───────────────────────────────────────────────────────

/**
 * Strip null bytes and non-printable control characters.
 * Preserves newlines (\n), carriage returns (\r), and tabs (\t)
 * which are valid in multi-line AI prompts and transcripts.
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/\0/g, '')                               // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // dangerous control chars
}

/** Returns true if value is a non-empty string. */
export function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ─── Chat message validation ──────────────────────────────────────────────────

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

/**
 * Validate a messages array for chat APIs.
 *
 * NOTE: No size limits are applied to individual message content — the app
 * supports long-form prompts, STT transcripts, and document analysis.
 * Security controls focus on structure/type, not content length.
 *
 * @param messages  The value from the request body
 * @param maxTurns  Max conversation depth (default 200)
 * @returns null if valid, error string if invalid
 */
export function validateMessages(messages: unknown, maxTurns = 200): string | null {
  if (!Array.isArray(messages)) return 'messages must be an array';
  if (messages.length === 0)    return 'messages array is empty';
  if (messages.length > maxTurns) return `too many messages (max ${maxTurns})`;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) return `message[${i}] must be an object`;
    const m = msg as Record<string, unknown>;
    if (!VALID_ROLES.has(m.role as string)) return `message[${i}] has invalid role: ${String(m.role)}`;
    // Content may be a string (text) or an array (vision payloads)
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      return `message[${i}] content must be a string or array`;
    }
  }
  return null;
}

// ─── Known-safe provider whitelist ───────────────────────────────────────────
export const ALLOWED_PROVIDERS = new Set(['groq', 'openrouter', 'nvidia', 'gemini', 'cerebras']);
