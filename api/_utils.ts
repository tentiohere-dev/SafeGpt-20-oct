type Provider = "groq" | "openrouter" | "gemini" | "nvidia" | "serper" | "cerebras";

export function json(res: any, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function methodNotAllowed(res: any, allow: string[]) {
  res.statusCode = 405;
  res.setHeader("Allow", allow.join(", "));
  json(res, 405, { error: "Method not allowed" });
}

export function readEnv(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

export function parseKeyList(raw: string): string[] {
  return (raw || "")
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getNumberedKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 1; index <= 50; index += 1) {
    const key = readEnv(`${prefix}_API_KEY_${index}`);
    if (!key) break;
    keys.push(key);
  }
  return keys;
}

export function getKeyPool(provider: Provider): string[] {
  const prefix = provider.toUpperCase();
  switch (provider) {
    case "groq":
    case "openrouter":
    case "gemini":
    case "nvidia":
    case "serper":
    case "cerebras": {
      const keys = [
        ...parseKeyList(readEnv(`${prefix}_API_KEY`)),
        ...parseKeyList(readEnv(`${prefix}_API_KEYS`)),
        ...getNumberedKeys(prefix),
      ];
      return [...new Set(keys)];
    }
    default:
      return [];
  }
}

type RateBucket = { count: number; resetAt: number };
type RateLimitOptions = {
  name: string;
  limit: number;
  windowMs: number;
  message: string;
  identity?: string;
};

// Best-effort in-memory guard. On Vercel this is per warm function instance;
// a shared store is required for limits that span instances/cold starts.
const rateBuckets = new Map<string, RateBucket>();
let rateLimitChecks = 0;
const MAX_RATE_BUCKETS = 20_000;

export function getClientAddress(req: any): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof forwardedValue === "string" && forwardedValue.trim()) {
    return forwardedValue.split(",")[0].trim().slice(0, 100);
  }
  const realIp = req.headers?.["x-real-ip"];
  const realIpValue = Array.isArray(realIp) ? realIp[0] : realIp;
  if (typeof realIpValue === "string" && realIpValue.trim()) return realIpValue.trim().slice(0, 100);
  return String(req.socket?.remoteAddress || "unknown").slice(0, 100);
}

function pruneRateBuckets(now: number) {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  while (rateBuckets.size > MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value;
    if (oldest === undefined) break;
    rateBuckets.delete(oldest);
  }
}

export function clearRateLimit(name: string, req: any, identity?: string) {
  const address = getClientAddress(req);
  rateBuckets.delete(`${name}:ip:${address}`);
  if (identity) rateBuckets.delete(`${name}:identity:${identity.trim().toLowerCase().slice(0, 80)}`);
}

export function enforceRateLimit(req: any, res: any, options: RateLimitOptions): boolean {
  const now = Date.now();
  rateLimitChecks += 1;
  if (rateLimitChecks % 128 === 0 || rateBuckets.size >= MAX_RATE_BUCKETS) {
    pruneRateBuckets(now);
  }

  const keys = [`${options.name}:ip:${getClientAddress(req)}`];
  if (options.identity) {
    keys.push(`${options.name}:identity:${options.identity.trim().toLowerCase().slice(0, 80)}`);
  }
  const buckets = keys.map((key) => rateBuckets.get(key));
  const blocked = buckets.find((bucket) => bucket && bucket.resetAt > now && bucket.count >= options.limit);
  if (blocked) {
    const retryAfter = Math.max(1, Math.ceil((blocked.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("Cache-Control", "no-store");
    json(res, 429, { error: options.message });
    return false;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const bucket = buckets[index];
    rateBuckets.set(
      keys[index],
      bucket && bucket.resetAt > now
        ? { ...bucket, count: bucket.count + 1 }
        : { count: 1, resetAt: now + options.windowMs },
    );
  }
  return true;
}

// Leave room below Vercel's 4.5 MB request-body limit for multipart/JSON overhead.
const MAX_JSON_BODY = 4 * 1024 * 1024;

export async function readJson(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX_JSON_BODY) return null; // reject oversized body
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function rotateIndexFromError(errText: string, status: number): boolean {
  // Retry another key on common auth/quota/rate-limits.
  if (status === 401 || status === 403 || status === 429) return true;
  const t = (errText || "").toLowerCase();
  return t.includes("quota") || t.includes("rate") || t.includes("limit") || t.includes("insufficient");
}
