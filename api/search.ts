import { getKeyPool, json, methodNotAllowed, readJson, rotateIndexFromError } from "./_utils";
import { requireSession } from "./_auth";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireSession(req, res))) return;
  const body = await readJson(req);
  const query = typeof body?.query === "string" ? body.query : "";
  if (!query.trim()) return json(res, 400, { error: "Missing query" });

  const serverSerperKeys = getKeyPool("serper");
  const keys = serverSerperKeys;
  // Serper is optional; allow empty pool and fall back to DuckDuckGo.
  if (keys.length) {
    let lastErr = "";
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        const results = await searchSerper(query, key);
        if (results.length) return json(res, 200, { source: "serper", results });
      } catch (e: any) {
        lastErr = typeof e?.message === "string" ? e.message : "Serper error";
        const m = lastErr.match(/^Serper\s+(\d+):\s*([\s\S]*)$/i);
        const status = m ? Number(m[1]) : 0;
        const errText = m ? m[2] : lastErr;
        if (!rotateIndexFromError(errText, status)) break;
      }
    }
  }

  try {
    const results = await searchDuckDuckGo(query);
    return json(res, 200, { source: "duckduckgo", results });
  } catch (e: any) {
    return json(res, 502, { error: "Web search is temporarily unavailable." });
  }
}

async function searchSerper(query: string, apiKey: string) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query + " health safety", num: 5 }),
  });
  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Serper ${res.status}: ${e.slice(0, 500)}`);
  }
  const data: any = await res.json();
  const organic: any[] = data?.organic || [];
  return organic.slice(0, 5).map((r) => ({ title: r.title, snippet: r.snippet, link: r.link }));
}

async function searchDuckDuckGo(query: string) {
  const encoded = encodeURIComponent(query);
  const res = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`);
  if (!res.ok) {
    const e = await res.text();
    throw new Error(`DuckDuckGo ${res.status}: ${e.slice(0, 500)}`);
  }
  const data: any = await res.json();
  const results: any[] = [];
  if (data?.AbstractText) {
    results.push({ title: data.Heading || "DuckDuckGo", snippet: data.AbstractText, link: data.AbstractURL || "" });
  }
  const related: any[] = data?.RelatedTopics || [];
  for (const rt of related) {
    if (rt?.Text) results.push({ title: rt?.FirstURL ? "DuckDuckGo Result" : "DuckDuckGo", snippet: rt.Text, link: rt.FirstURL || "" });
    if (rt?.Topics && Array.isArray(rt.Topics)) {
      for (const t of rt.Topics) {
        if (t?.Text) results.push({ title: t?.FirstURL ? "DuckDuckGo Result" : "DuckDuckGo", snippet: t.Text, link: t.FirstURL || "" });
      }
    }
    if (results.length >= 5) break;
  }
  return results.slice(0, 5);
}

