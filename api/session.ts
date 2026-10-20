import { clearRateLimit, enforceRateLimit, json, methodNotAllowed, readJson } from "./_utils";
import {
  clearedSessionCookie,
  createSessionToken,
  getAuthConfigError,
  isSameOriginRequest,
  readSessionCookie,
  sessionCookie,
  verifyAdminCredentials,
  verifySessionToken,
} from "./_auth";

function isSecureRequest(req: any): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return proto === "https" || process.env.NODE_ENV === "production";
}

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store, private");

  if (req.method === "GET") {
    const configError = getAuthConfigError();
    if (configError) return json(res, 503, { authenticated: false, error: configError });
    const cookie = req.headers.cookie;
    const token = readSessionCookie(Array.isArray(cookie) ? cookie[0] : cookie);
    const username = await verifySessionToken(token);
    return json(res, 200, { authenticated: !!username, username: username ?? null });
  }

  if (req.method === "DELETE") {
    if (!isSameOriginRequest(req)) return json(res, 403, { error: "Request origin is not allowed." });
    res.setHeader("Set-Cookie", clearedSessionCookie(isSecureRequest(req)));
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
  if (!isSameOriginRequest(req)) return json(res, 403, { error: "Request origin is not allowed." });

  const configError = getAuthConfigError();
  if (configError) return json(res, 503, { error: configError });

  const body = await readJson(req);
  const username = typeof body?.username === "string" ? body.username.trim().slice(0, 80) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password || password.length > 1024) {
    return json(res, 400, { error: "Enter a valid username and password." });
  }

  if (!(await verifyAdminCredentials(username, password))) {
    if (!enforceRateLimit(req, res, {
      name: "login",
      limit: 8,
      windowMs: 15 * 60 * 1000,
      identity: username,
      message: "Too many failed sign-in attempts. Try again in 15 minutes.",
    })) return;
    return json(res, 401, { error: "Invalid username or password." });
  }

  clearRateLimit("login", req, username);
  const token = await createSessionToken(username);
  res.setHeader("Set-Cookie", sessionCookie(token, isSecureRequest(req)));
  return json(res, 200, { authenticated: true, username: username.trim() });
}
