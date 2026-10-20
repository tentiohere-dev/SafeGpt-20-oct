import {
  clearedSessionCookieForRequest,
  createSessionToken,
  getAuthConfigError,
  readSessionCookie,
  sessionCookieForRequest,
  verifyAdminCredentials,
  verifyRequestSession,
} from "../../../api/_auth";

const attempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private", ...headers },
  });
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function getClientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function recordFailedLogin(request: Request): boolean {
  const now = Date.now();
  for (const [address, attempt] of attempts) {
    if (attempt.resetAt <= now) attempts.delete(address);
  }
  const address = getClientAddress(request);
  const current = attempts.get(address);
  if (current && current.resetAt > now && current.count >= LOGIN_LIMIT) return false;
  const active = current && current.resetAt > now;
  attempts.set(address, {
    count: active ? current.count + 1 : 1,
    resetAt: active ? current.resetAt : now + LOGIN_WINDOW_MS,
  });
  return true;
}

export async function GET(request: Request): Promise<Response> {
  const configError = getAuthConfigError();
  if (configError) return json({ authenticated: false, error: configError }, 503);
  const username = await verifyRequestSession(request);
  return json({ authenticated: !!username, username: username ?? null });
}

export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request)) return json({ error: "Request origin is not allowed." }, 403);
  const configError = getAuthConfigError();
  if (configError) return json({ error: configError }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const username = typeof body?.username === "string" ? body.username.trim().slice(0, 80) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password || password.length > 1024) {
    return json({ error: "Enter a valid username and password." }, 400);
  }

  if (!(await verifyAdminCredentials(username, password))) {
    if (!recordFailedLogin(request)) {
      return json({ error: "Too many failed sign-in attempts. Try again in 15 minutes." }, 429);
    }
    return json({ error: "Invalid username or password." }, 401);
  }

  attempts.delete(getClientAddress(request));
  const token = await createSessionToken(username);
  return json(
    { authenticated: true, username: username.trim() },
    200,
    { "Set-Cookie": sessionCookieForRequest(token, request) },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  return json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookieForRequest(request) });
}
