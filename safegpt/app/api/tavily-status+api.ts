/**
 * SafeGPT — Tavily Diagnostic Probe
 *
 * Server-side Tavily key probe for the Model Status screen.
 * Pings each configured key and returns Online / Offline / Rate Limited / Invalid Key.
 *
 * SAFE: Never returns actual key values — only status strings and key index numbers.
 */

import { secureJson } from '../../server/security';

type TavilyKeyStatus = "Online" | "Offline" | "Rate Limited" | "Invalid Key" | "Not Set";

function parseEnvKeys(): string[] {
  // Support TAVILY_API_KEY (comma-separated), TAVILY_API_KEYS, and TAVILY_API_KEY_1...N
  const single = (process.env['TAVILY_API_KEY'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (single.length > 0) return single;
  const multi = (process.env['TAVILY_API_KEYS'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (multi.length > 0) return multi;
  const keys: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const val = (process.env[`TAVILY_API_KEY_${i}`] ?? '').trim();
    if (!val) break;
    keys.push(val);
  }
  return keys;
}

async function probeTavilyKey(key: string): Promise<TavilyKeyStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: 'ping', max_results: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) return 'Online';
    if (r.status === 429) return 'Rate Limited';
    if (r.status === 401 || r.status === 403) return 'Invalid Key';
    return 'Offline';
  } catch {
    return 'Offline';
  }
}

export async function GET(_request: Request): Promise<Response> {
  const keys = parseEnvKeys();
  if (keys.length === 0) {
    return secureJson({ keys: [] });
  }
  const results = await Promise.all(
    keys.map(async (key, i) => ({
      index: i + 1,
      status: await probeTavilyKey(key),
    }))
  );
  return secureJson({ keys: results });
}
