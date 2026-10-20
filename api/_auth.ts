const SESSION_COOKIE = "safegpt_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PASSWORD_HASH_PREFIX = "pbkdf2-sha256";

type VercelRequest = {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function getAuthConfigError(): string | null {
  const username = env("SAFEGPT_ADMIN_USERNAME");
  const passwordHash = env("SAFEGPT_ADMIN_PASSWORD_HASH");
  const sessionSecret = env("SESSION_SECRET");
  if (!username || !passwordHash || !sessionSecret) {
    return "Server sign-in is not configured. Set SAFEGPT_ADMIN_USERNAME, SAFEGPT_ADMIN_PASSWORD_HASH, and SESSION_SECRET on the server.";
  }
  if (sessionSecret.length < 32) {
    return "Server sign-in is misconfigured: SESSION_SECRET must be at least 32 characters.";
  }
  if (!parsePasswordHash(passwordHash)) {
    return "Server sign-in is misconfigured: SAFEGPT_ADMIN_PASSWORD_HASH must be a PBKDF2-SHA256 hash.";
  }
  return null;
}

type PasswordHash = { iterations: number; salt: Uint8Array; digest: Uint8Array };

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function parsePasswordHash(raw: string): PasswordHash | null {
  const parts = raw.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_PREFIX) return null;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const digest = fromHex(parts[3]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return null;
  if (!salt || salt.length < 16 || !digest || digest.length !== 32) return null;
  return { iterations, salt, digest };
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (left[i % Math.max(1, left.length)] ?? 0) ^ (right[i % Math.max(1, right.length)] ?? 0);
  }
  return difference === 0;
}

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const configuredUsername = env("SAFEGPT_ADMIN_USERNAME");
  const parsed = parsePasswordHash(env("SAFEGPT_ADMIN_PASSWORD_HASH"));
  if (!configuredUsername || !parsed) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(parsed.salt).buffer as ArrayBuffer, iterations: parsed.iterations },
    key,
    parsed.digest.length * 8,
  ));
  const correctPassword = constantTimeEqual(derived, parsed.digest);
  return username.trim().toLowerCase() === configuredUsername.toLowerCase() && correctPassword;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function signature(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function createSessionToken(username: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({
    sub: username.trim(),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${await signature(payload)}`;
}

export async function verifySessionToken(token: string): Promise<string | null> {
  if (!token || token.length > 4096) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) return null;

  const expectedSignature = await signature(payload);
  const expectedBytes = new TextEncoder().encode(expectedSignature);
  const suppliedBytes = new TextEncoder().encode(suppliedSignature);
  if (!constantTimeEqual(expectedBytes, suppliedBytes)) return null;

  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;
  try {
    const claims = JSON.parse(decoded);
    if (
      typeof claims?.sub !== "string" ||
      !claims.sub ||
      typeof claims?.exp !== "number" ||
      claims.exp <= Math.floor(Date.now() / 1000)
    ) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export async function verifyRequestSession(request: Request): Promise<string | null> {
  const configError = getAuthConfigError();
  if (configError) return null;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return null;
    } catch {
      return null;
    }
  }
  return verifySessionToken(readSessionCookie(request.headers.get("cookie") ?? undefined));
}

export async function requireRequestSession(request: Request): Promise<Response | null> {
  const configError = getAuthConfigError();
  if (configError) return configErrorResponse(configError);
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return new Response(JSON.stringify({ error: "Request origin is not allowed." }), {
          status: 403,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Request origin is not allowed." }), {
        status: 403,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }
  const username = await verifySessionToken(readSessionCookie(request.headers.get("cookie") ?? undefined));
  return username ? null : unauthorizedResponse();
}

export function sessionCookieForRequest(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
  return sessionCookie(token, secure);
}

export function clearedSessionCookieForRequest(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
  return clearedSessionCookie(secure);
}

export function readSessionCookie(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}

export function setApiNoStoreHeaders(headers: Headers): void {
  headers.set("Cache-Control", "no-store, private");
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Sign in to SafeGPT to continue." }), {
    status: 401,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function configErrorResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function isSameOriginRequest(req: VercelRequest): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader || Array.isArray(originHeader)) return !originHeader;
  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) return false;
  try {
    return new URL(originHeader).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export async function requireSession(req: VercelRequest, res: any): Promise<boolean> {
  const configError = getAuthConfigError();
  if (configError) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: configError }));
    return false;
  }
  if (!isSameOriginRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Request origin is not allowed." }));
    return false;
  }
  const cookieHeader = req.headers.cookie;
  const username = await verifySessionToken(readSessionCookie(
    Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader,
  ));
  if (!username) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Sign in to SafeGPT to continue." }));
    return false;
  }
  return true;
}
