/**
 * SafeGPT — Web Search Proxy
 *
 * Proxies Tavily search requests (with DuckDuckGo fallback).
 * Keys read from TAVILY_API_KEY env var — never exposed to the browser.
 *
 * Setup:
 *   TAVILY_API_KEY = key1,key2,key3   (comma-separated for multiple keys)
 *   EXPO_PUBLIC_USE_SERVER_PROXY = 1
 */

import { secureJson, sanitizeString } from '../../server/security';

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

type SearchResult = { title: string; snippet: string; link: string };

async function tavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return (data?.results ?? []).slice(0, 5).map((r: any) => ({
    title:   String(r.title   ?? '').trim(),
    snippet: String(r.content ?? '').trim(),
    link:    String(r.url     ?? '').trim(),
  })).filter((r: any) => r.snippet || r.title);
}

// ── DDG Lite HTML — handles any web query (prices, news, real-time data) ────
async function duckduckgoLiteSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SafeGPT/1.0; +https://safegpt.app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }
  );
  if (!res.ok) throw new Error(`DDG Lite ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  // href pattern: class="result-link" href="//duckduckgo.com/l/?uddg=URL_ENCODED_URL&..."
  const urlRe     = /class="result-link"[^>]*href="[^"]*uddg=([^&"]+)/g;
  const titleRe   = /class="result-link"[^>]*>([^<]+)<\/a>/g;
  const snippetRe = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(html)) !== null && urls.length < 6) {
    try { urls.push(decodeURIComponent(m[1])); } catch { urls.push(m[1]); }
  }
  const titles: string[] = [];
  while ((m = titleRe.exec(html)) !== null && titles.length < 6) {
    titles.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 6) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }

  for (let i = 0; i < Math.min(urls.length, 5); i++) {
    if (!urls[i]) continue;
    results.push({
      title:   titles[i]   || `Result ${i + 1}`,
      snippet: snippets[i] || titles[i] || '',
      link:    urls[i],
    });
  }
  return results.slice(0, 5);
}

// ── DuckDuckGo: Instant Answer API → Lite HTML fallback ─────────────────────
async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  // 1) Try Instant Answer API (fast, good for structured/Wikipedia queries)
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const instant: SearchResult[] = [];
      if (data.AbstractText) {
        instant.push({ title: data.Heading ?? query, snippet: data.AbstractText, link: data.AbstractURL ?? '' });
      }
      for (const t of (data.RelatedTopics ?? []).slice(0, 4)) {
        if (t.Text && t.FirstURL) {
          instant.push({ title: t.Text.slice(0, 100), snippet: t.Text, link: t.FirstURL });
        }
      }
      if (instant.length > 0) return instant.slice(0, 5);
    }
  } catch { /* fall through */ }

  // 2) Lite HTML web search — works for any query including prices, news, real-time data
  return duckduckgoLiteSearch(query);
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

    const rawQuery = body?.query;
    if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
      return secureJson({ results: [], source: 'none', query: '' });
    }

    // Sanitize: strip null bytes and control chars, then trim
    const query = sanitizeString(rawQuery).trim();
    if (!query) {
      return secureJson({ results: [], source: 'none', query: '' });
    }

    const forceSource = typeof body.forceSource === 'string' ? body.forceSource : null;

    // ── Force DuckDuckGo only ────────────────────────────────────────────────
    if (forceSource === 'duckduckgo') {
      try {
        const results = await duckduckgoSearch(query);
        if (results.length > 0) return secureJson({ results, source: 'duckduckgo', query });
      } catch { /* no results */ }
      return secureJson({ results: [], source: 'none', query });
    }

    const keys = parseEnvKeys();

    // ── Force Tavily only (no DDG fallback) ──────────────────────────────────
    if (forceSource === 'tavily') {
      for (const key of keys) {
        try {
          const results = await tavilySearch(query, key);
          if (results.length > 0) return secureJson({ results, source: 'tavily', query });
        } catch { /* try next key */ }
      }
      return secureJson({ results: [], source: 'none', query });
    }

    // ── Default: Tavily → DuckDuckGo fallback ───────────────────────────────
    for (const key of keys) {
      try {
        const results = await tavilySearch(query, key);
        if (results.length > 0) return secureJson({ results, source: 'tavily', query });
      } catch { /* try next key */ }
    }

    try {
      const results = await duckduckgoSearch(query);
      if (results.length > 0) return secureJson({ results, source: 'duckduckgo', query });
    } catch { /* exhausted */ }

    return secureJson({ results: [], source: 'none', query });
  } catch (err: any) {
    return secureJson({ error: 'Internal search proxy error' }, 500);
  }
}
