/**
 * Web Search Service
 *
 * Primary:  Tavily API (api.tavily.com) — requires TAVILY_API_KEY in settings
 * Fallback: DuckDuckGo Instant Answer API (no key required, JSON, no scraping).
 *
 * Optional: server proxy mode for web/Vercel so keys never ship to frontend
 * bundles. Enable by setting `EXPO_PUBLIC_USE_SERVER_PROXY=1`.
 */

import { getConfigApiKeys } from "@/config/apiKeys";
import { Platform } from "react-native";

export type SearchResult = {
  title: string;
  snippet: string;
  link: string;
};

export type SearchSource = "tavily" | "duckduckgo" | "none";

export type WebSearchResponse = {
  results: SearchResult[];
  source: SearchSource;
  query: string;
};

function envValue(name: string): string {
  try {
    const g: any = globalThis as any;
    const v = g.process?.env?.[name];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function shouldUseServerProxy(): boolean {
  return envValue("EXPO_PUBLIC_USE_SERVER_PROXY") === "1" || Platform.OS === "web";
}

function proxyBaseUrl(): string {
  const base = envValue("EXPO_PUBLIC_PROXY_BASE_URL");
  return base ? base.replace(/\/+$/, "") : "";
}

async function searchViaProxy(query: string, clientTavilyKey?: string, forceSource?: "tavily" | "duckduckgo"): Promise<WebSearchResponse> {
  const base = proxyBaseUrl();
  const url = `${base}/api/search`;
  const bodyObj: Record<string, unknown> = { query };
  // Search keys stay server-side when using the web proxy.
  if (forceSource) bodyObj.forceSource = forceSource;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Proxy ${res.status}: ${err.slice(0, 120)}`);
  }
  const data: any = await res.json();
  const results: SearchResult[] = Array.isArray(data?.results) ? data.results : [];
  const source: SearchSource = data?.source === "tavily" || data?.source === "duckduckgo" ? data.source : "none";
  return { results, source, query };
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Tavily ${res.status}: ${err.slice(0, 120)}`);
  }
  const data = await res.json();
  const organic: any[] = data?.results || [];
  return organic
    .slice(0, 5)
    .map((r: any) => ({
      title: String(r.title || "").trim(),
      snippet: String(r.content || "").trim(),
      link: String(r.url || "").trim(),
    }))
    .filter((r) => r.snippet.length > 0 || r.title.length > 0);
}

// ── DDG Lite HTML — handles any web query (prices, news, real-time data) ────
async function searchDuckDuckGoLite(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SafeGPT/1.0; +https://safegpt.app)",
        "Accept": "text/html,application/xhtml+xml",
      },
    }
  );
  if (!res.ok) throw new Error(`DDG Lite ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
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
    titles.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim());
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 6) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  }

  for (let i = 0; i < Math.min(urls.length, 5); i++) {
    if (!urls[i]) continue;
    results.push({
      title:   titles[i]   || `Result ${i + 1}`,
      snippet: snippets[i] || titles[i] || "",
      link:    urls[i],
    });
  }
  return results.slice(0, 5);
}

// ── DuckDuckGo: Instant Answer API → Lite HTML fallback ─────────────────────
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  // 1) Instant Answer API (fast for structured/Wikipedia queries)
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { Accept: "application/json" } }
    );
    if (res.ok) {
      const data = await res.json();
      const instant: SearchResult[] = [];
      if (data.AbstractText) {
        instant.push({
          title:   String(data.Heading || query).trim(),
          snippet: String(data.AbstractText).trim(),
          link:    String(data.AbstractURL || "").trim(),
        });
      }
      const related: any[] = data.RelatedTopics || [];
      for (const topic of related) {
        if (instant.length >= 5) break;
        const addTopic = (t: any) => {
          if (instant.length < 5 && t?.Text && t?.FirstURL) {
            instant.push({
              title:   String(t.Text).slice(0, 100).trim(),
              snippet: String(t.Text).trim(),
              link:    String(t.FirstURL).trim(),
            });
          }
        };
        if (Array.isArray(topic.Topics)) topic.Topics.forEach(addTopic);
        else addTopic(topic);
      }
      if (instant.length > 0) return instant;
    }
  } catch { /* fall through */ }

  // 2) Lite HTML web search — works for any query including real-time data
  return searchDuckDuckGoLite(query);
}

/**
 * Perform a web search. Tries Tavily first, then DuckDuckGo.
 * @param query     The search query
 * @param apiKey    User-supplied Tavily API key (from settings)
 */
export async function performWebSearch(
  query: string,
  apiKey?: string
): Promise<WebSearchResponse> {
  if (shouldUseServerProxy()) {
    return searchViaProxy(query, apiKey);
  }

  function ev(name: string): string {
    try { const g: any = globalThis as any; const v = g.process?.env?.[name]; return typeof v === "string" ? v.trim() : ""; } catch { return ""; }
  }
  const cfg = getConfigApiKeys();
  // Support TAVILY_API_KEY (comma-separated), TAVILY_API_KEYS, and numbered keys
  const multiRaw = ev("TAVILY_API_KEY") || ev("TAVILY_API_KEYS");
  const multiKeys = multiRaw.split(/[,\n]/g).map((s) => s.trim()).filter(Boolean);
  const key1 = ev("TAVILY_API_KEY_1");
  const key2 = ev("TAVILY_API_KEY_2");
  const key3 = ev("TAVILY_API_KEY_3");
  const configKeys = Array.isArray(cfg.tavily) ? cfg.tavily.map((s) => String(s || "").trim()).filter(Boolean) : [];
  const keyPool = Array.from(new Set(
    [...multiKeys, key1, key2, key3, ...configKeys, (apiKey || "").trim()].filter(Boolean)
  ));

  for (const key of keyPool) {
    try {
      const results = await searchTavily(query, key);
      if (results.length > 0) {
        console.log(`[WEB SEARCH] Tavily returned ${results.length} results`);
        return { results, source: "tavily", query };
      }
    } catch {
      // silent fallback to next key
    }
  }

  try {
    const results = await searchDuckDuckGo(query);
    if (results.length > 0) {
      console.log(`[WEB SEARCH] DuckDuckGo returned ${results.length} results`);
      return { results, source: "duckduckgo", query };
    }
  } catch (e) {
    console.log("[WEB SEARCH] DuckDuckGo error:", e);
  }

  console.log("[WEB SEARCH] All search sources exhausted, no results");
  return { results: [], source: "none", query };
}

/**
 * Perform a web search with an optional forced source.
 * forceSource="tavily"      → Tavily only, no DDG fallback
 * forceSource="duckduckgo"  → DuckDuckGo only, no Tavily
 * undefined                 → same as performWebSearch (Tavily → DDG)
 */
export async function performWebSearchForced(
  query: string,
  apiKey?: string,
  forceSource?: "tavily" | "duckduckgo"
): Promise<WebSearchResponse> {
  if (shouldUseServerProxy()) {
    return searchViaProxy(query, apiKey, forceSource);
  }
  if (forceSource === "duckduckgo") {
    try {
      const results = await searchDuckDuckGo(query);
      return { results, source: results.length > 0 ? "duckduckgo" : "none", query };
    } catch {
      return { results: [], source: "none", query };
    }
  }
  return performWebSearch(query, apiKey);
}

export function formatSearchResultsForPrompt(results: SearchResult[]): string {
  if (results.length === 0) return "No search results available.";
  return results
    .map(
      (r, i) =>
        `[Result ${i + 1}]\nTitle: ${r.title}\nInfo: ${r.snippet}\nSource: ${r.link}`
    )
    .join("\n\n");
}
