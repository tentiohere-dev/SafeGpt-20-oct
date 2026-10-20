import { RagChunk, normalizeNumerals, toArabicIndicNumber, tokenize } from "./ragService";
import { classifyQuery } from "./queryClassifier";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type DocInput = {
  name: string;
  content?: string;
  indexed: boolean;
  chunks?: RagChunk[];
};

export type SmartRetrieveResult = {
  text: string;
  chunks: RagChunk[];
  notFound?: boolean;
  notFoundMessage?: string;
};

// ─── HSE SYNONYM EXPANSION ────────────────────────────────────────────────────

const HSE_SYNONYMS: Record<string, string[]> = {
  ppe: ["personal protective equipment", "hard hat", "safety helmet", "gloves", "goggles", "harness", "respirator", "معدات الوقاية الشخصية", "خوذة", "قفازات"],
  harness: ["fall arrest", "safety harness", "full body harness", "حارنس", "حزام أمان"],
  permit: ["work permit", "hot work permit", "permit to work", "تصريح عمل", "تصريح"],
  "confined space": ["enclosed space", "مكان مغلق", "فضاء محصور"],
  "fall protection": ["fall arrest", "fall prevention", "guardrail", "safety net", "الحماية من السقوط"],
  lockout: ["loto", "lockout tagout", "energy isolation", "عزل الطاقة"],
  excavation: ["trench", "pit", "earthwork", "حفر", "خندق"],
  hazard: ["danger", "risk", "unsafe condition", "خطر", "مخاطر"],
  incident: ["accident", "near miss", "injury", "حادث", "إصابة"],
  fire: ["flame", "combustion", "ignition", "حريق", "نار"],
  chemical: ["hazardous substance", "toxic", "مادة كيميائية", "مواد خطرة"],
  "working at height": ["elevated work", "roof work", "scaffold", "العمل في الارتفاع"],
  scaffold: ["scaffolding", "platform", "سقالة", "منصة"],
  electrical: ["live wire", "electrocution", "كهرباء", "صعق كهربائي"],
  respirator: ["scba", "breathing apparatus", "جهاز تنفس", "قناع تنفس"],
  osha: ["occupational safety", "workplace safety", "سلامة المهنية"],
  nebosh: ["health and safety", "hse", "الصحة والسلامة المهنية"],
};

export function expandQueryWithSynonyms(query: string): string {
  const lower = query.toLowerCase();
  const additions: string[] = [];
  for (const [term, synonyms] of Object.entries(HSE_SYNONYMS)) {
    if (lower.includes(term)) {
      additions.push(...synonyms);
    }
  }
  if (additions.length === 0) return query;
  return query + " " + additions.join(" ");
}

// ─── BM25 SCORER ──────────────────────────────────────────────────────────────

export function bm25Score(
  queryTerms: string[],
  chunks: RagChunk[],
  k1 = 1.5,
  b = 0.75
): Array<RagChunk & { bm25Score: number; source?: string }> {
  if (chunks.length === 0 || queryTerms.length === 0) return [];
  const tokenized = chunks.map((c) => tokenize(c.normalizedText || c.text));
  const avgDocLen =
    tokenized.reduce((s, t) => s + t.length, 0) / tokenized.length;
  return chunks
    .map((chunk, idx) => {
      const docTerms = tokenized[idx];
      const docLen = docTerms.length;
      const tf: Record<string, number> = {};
      docTerms.forEach((t) => { tf[t] = (tf[t] || 0) + 1; });
      let score = 0;
      queryTerms.forEach((term) => {
        const f = tf[term] || 0;
        if (f === 0) return;
        const docsWithTerm = tokenized.filter((dt) => dt.includes(term)).length;
        const idf = Math.log(
          (chunks.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1
        );
        score +=
          idf * (f * (k1 + 1)) /
          (f + k1 * (1 - b + (b * docLen) / avgDocLen));
      });
      return { ...chunk, bm25Score: score };
    })
    .filter((c) => c.bm25Score > 0)
    .sort((a, b_) => b_.bm25Score - a.bm25Score);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function documentToChunk(doc: DocInput): RagChunk {
  const text = doc.content || "";
  return {
    id: doc.name,
    text,
    normalizedText: normalizeNumerals(text).toLowerCase(),
    metadata: { document_name: doc.name, section_type: "document" },
  };
}

function formatChunkContext(chunk: RagChunk, matchLabel?: string): string {
  const meta = chunk.metadata as any;
  const parts: string[] = [];
  if (matchLabel) parts.push(matchLabel);
  parts.push(`[Document: ${meta.document_name}]`);
  if (meta.doc_type) parts.push(`[Type: ${meta.doc_type}]`);
  parts.push(`[Section Type: ${meta.section_type}]`);
  if (meta.article_number)
    parts.push(
      `[Article: ${meta.article_number}${meta.article_number_ar ? ` / ${meta.article_number_ar}` : ""}]`
    );
  if (meta.chapter_number) parts.push(`[Chapter: ${meta.chapter_number}]`);
  if (meta.section_number) parts.push(`[Section: ${meta.section_number}]`);
  if (meta.heading_text) parts.push(`[Heading: ${meta.heading_text}]`);
  if (meta.title) parts.push(`[Title: ${meta.title}]`);
  const isLawChunk =
    meta?.doc_type === "law" || meta?.section_type === "legal_article";
  const chunkText = isLawChunk ? chunk.text : chunk.text.slice(0, 6000);
  return parts.join("\n") + "\n" + chunkText;
}

function writtenNumber(n: number): string {
  const map: Record<number, string> = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
    13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen",
    17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty",
    30: "thirty", 40: "forty", 50: "fifty", 60: "sixty",
    70: "seventy", 80: "eighty", 90: "ninety", 100: "one hundred",
  };
  return map[n] || String(n);
}

function scanArticleFromText(
  doc: DocInput,
  numStr: string,
  arNum: string
): RagChunk | null {
  if (!doc.content) return null;
  const text = doc.content;
  const escNum = numStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escAr = arNum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(
    `(?:^|\\n|[.;:])\\s*((?:Article|ARTICLE|Art\\.|مادة|المادة)\\s*(?:number|no\\.?)?\\s*[\\(\\[]?\\s*(?:${escNum}|${escAr})(?![0-9٠-٩۰-۹])\\s*[\\)\\]]?\\s*[:：.\\-–—]?)`,
    "i"
  );
  const match = headingRe.exec(text);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const nextRe =
    /(?:^|\n|[.;:])\s*((?:Article|ARTICLE|Art\.|مادة|المادة)\s*(?:number|no\.?)?\s*[\(\[]?\s*[0-9٠-٩۰-۹]+\s*[\)\]]?\s*[:：.\-–—]?)/gi;
  const nextMatch = nextRe.exec(rest);
  const end =
    nextMatch?.index !== undefined
      ? start + match[0].length + nextMatch.index
      : Math.min(start + 5000, text.length);
  const section = text.slice(start, end).trim();
  if (!section) return null;
  return {
    id: `${doc.name}:article:${numStr}:scan`,
    text: section,
    normalizedText: normalizeNumerals(section).toLowerCase(),
    metadata: {
      document_name: doc.name,
      section_type: "legal_article",
      article_number: numStr,
      article_number_ar: arNum,
    },
  };
}

function scanChapterFromText(doc: DocInput, number: number): string | null {
  if (!doc.content) return null;
  const escWritten = writtenNumber(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chapterRe = new RegExp(
    `(?:^|\\n)\\s*((?:Chapter|CHAPTER)\\s+(?:${number}|${escWritten})(?:\\s*[:：.\\-–—])?[^\\n]*)`,
    "i"
  );
  const match = chapterRe.exec(doc.content);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const rest = doc.content.slice(start + match[0].length);
  const nextRe = /(?:^|\n)\s*(?:Chapter|CHAPTER)\s+[0-9]/gi;
  const nextMatch = nextRe.exec(rest);
  const end =
    nextMatch?.index !== undefined
      ? start + match[0].length + nextMatch.index
      : Math.min(start + 5000, doc.content.length);
  return doc.content.slice(start, end).trim() || null;
}

function scanSectionFromText(doc: DocInput, numStr: string): string | null {
  if (!doc.content) return null;
  const escNum = numStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `(?:^|\\n)\\s*((?:Section|Unit)\\s+${escNum}|${escNum}\\s*[:：.\\-–—])`,
    "i"
  );
  const match = sectionRe.exec(doc.content);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const section = doc.content
    .slice(start, Math.min(start + 3000, doc.content.length))
    .trim();
  return section || null;
}

// ─── MAIN RETRIEVAL ───────────────────────────────────────────────────────────

export function smartRetrieve(
  query: string,
  docs: DocInput[]
): SmartRetrieveResult {
  console.log('STAGE 6 - USER QUERY:', JSON.stringify(query));

  const expandedQuery = expandQueryWithSynonyms(query);

  const allChunksWithFallback = docs
    .filter((d) => d.indexed || d.content)
    .flatMap((d) => (d.chunks?.length ? d.chunks : d.content ? [documentToChunk(d)] : []));

  console.log('STAGE 7 - @doc handler called. Using retrieval function: smartRetrieve');
  console.log('STAGE 7 - Documents being searched:', docs.map(d => d.name));
  console.log('STAGE 7 - Total chunks across all docs:', allChunksWithFallback.length);
  docs.forEach(d => {
    console.log(`STAGE 7 - Document "${d.name}": indexed=${d.indexed}, chunks=${d.chunks?.length ?? 0}, has_content=${!!d.content}`);
    console.log(`STAGE 7 - Available chunks for "${d.name}":`, JSON.stringify(d.chunks?.map(c => c.metadata)));
  });

  if (allChunksWithFallback.length === 0 && docs.every((d) => !d.content)) {
    return { text: "", chunks: [] };
  }

  const classification = classifyQuery(query);
  console.log('STAGE 6 - QUERY CLASSIFICATION:', JSON.stringify(classification));

  // ── STRUCTURAL PATH ──────────────────────────────────────────────────────────
  if (classification.type === "structural") {
    const { target, number } = classification;

    if (target === "article") {
      const numStr = String(number);
      const arNum = toArabicIndicNumber(numStr);

      // 1. Exact metadata match from pre-parsed chunks
      const metaMatches = allChunksWithFallback.filter((c) => {
        const art = (c.metadata as any).article_number;
        if (!art) return false;
        const normalized = normalizeNumerals(String(art));
        return (
          normalized === numStr ||
          normalized === arNum ||
          art === numStr ||
          art === arNum
        );
      });

      if (metaMatches.length > 0) {
        const docName = metaMatches[0].metadata.document_name;
        console.log(`[STRUCTURAL MATCH] Article ${number} from ${docName}`);
        const found = metaMatches.slice(0, 1);
        return {
          text: found
            .map((c) => formatChunkContext(c, "[Exact Article Match: true]"))
            .join("\n\n"),
          chunks: found,
        };
      }

      // 2. Scan raw content if metadata not available
      for (const doc of docs) {
        if (!doc.content) continue;
        const chunk = scanArticleFromText(doc, numStr, arNum);
        if (chunk) {
          console.log(`[STRUCTURAL MATCH] Article ${number} (text scan) from ${doc.name}`);
          return {
            text: formatChunkContext(chunk, "[Exact Article Match: true]"),
            chunks: [chunk],
          };
        }
      }

      // 3. Article not found — check if any law docs were uploaded
      const hasLawDocs = allChunksWithFallback.some(
        (c) =>
          c.metadata.section_type === "legal_article" ||
          (c.metadata as any).doc_type === "law"
      );
      console.log(
        `[STRUCTURAL MATCH] Article ${number} — not found in any document` +
        (hasLawDocs ? " (law docs present)" : " (no law docs)")
      );
      console.log('STAGE 8 - Returning NOT FOUND. Reason: article number not matched in metadata or text scan');
      console.log('STAGE 8 - Chunks searched:', allChunksWithFallback.length);
      console.log('STAGE 8 - Query number sought:', number);
      console.log('STAGE 8 - All article_number values in chunks:', JSON.stringify(allChunksWithFallback.map(c => (c.metadata as any).article_number).filter(Boolean)));
      // Return notFound to let callAI trigger web search instead of hallucinating
      return {
        text: "",
        chunks: [],
        notFound: true,
        notFoundMessage:
          `Article ${number} (المادة ${arNum}) was not found in any uploaded document. ` +
          `Do not substitute a different article. The document may not contain this article, ` +
          `or the article may be numbered differently.`,
      };
    }

    if (target === "chapter") {
      const numStr = String(number);

      // 1. Exact metadata match
      const metaMatches = allChunksWithFallback.filter(
        (c) => String((c.metadata as any).chapter_number) === numStr
      );
      if (metaMatches.length > 0) {
        const docName = metaMatches[0].metadata.document_name;
        console.log(`[STRUCTURAL MATCH] Chapter ${number} from ${docName}`);
        const found = metaMatches.slice(0, 2);
        return {
          text: found
            .map((c) => formatChunkContext(c, "[Exact Chapter Match: true]"))
            .join("\n\n"),
          chunks: found,
        };
      }

      // 2. Scan raw content
      for (const doc of docs) {
        const section = scanChapterFromText(doc, number);
        if (section) {
          console.log(`[STRUCTURAL MATCH] Chapter ${number} (text scan) from ${doc.name}`);
          const fakeChunk: RagChunk = {
            id: `${doc.name}:chapter:${numStr}`,
            text: section,
            normalizedText: normalizeNumerals(section).toLowerCase(),
            metadata: {
              document_name: doc.name,
              section_type: "section",
              chapter_number: number,
            },
          };
          return {
            text: `[Exact Chapter Match: true]\n[Document: ${doc.name}]\n[Chapter: ${number}]\n${section.slice(0, 3000)}`,
            chunks: [fakeChunk],
          };
        }
      }

      console.log(`[STRUCTURAL MATCH] Chapter ${number} — not found in any document`);
      return {
        text: `[Requested Chapter: ${number}]\nNo exact matching chapter was found in the uploaded documents. Do not use another chapter as a substitute.`,
        chunks: [],
      };
    }

    if (target === "section") {
      const numStr = String(number);

      // 1. Exact metadata match
      const metaMatches = allChunksWithFallback.filter(
        (c) => (c.metadata as any).section_number === numStr
      );
      if (metaMatches.length > 0) {
        const docName = metaMatches[0].metadata.document_name;
        console.log(`[STRUCTURAL MATCH] Section ${number} from ${docName}`);
        const found = metaMatches.slice(0, 2);
        return {
          text: found
            .map((c) => formatChunkContext(c, "[Exact Section Match: true]"))
            .join("\n\n"),
          chunks: found,
        };
      }

      // 2. Scan raw content
      for (const doc of docs) {
        const section = scanSectionFromText(doc, numStr);
        if (section) {
          console.log(`[STRUCTURAL MATCH] Section ${number} (text scan) from ${doc.name}`);
          const fakeChunk: RagChunk = {
            id: `${doc.name}:section:${numStr}`,
            text: section,
            normalizedText: normalizeNumerals(section).toLowerCase(),
            metadata: {
              document_name: doc.name,
              section_type: "section",
            },
          };
          return {
            text: `[Exact Section Match: true]\n[Document: ${doc.name}]\n[Section: ${number}]\n${section.slice(0, 3000)}`,
            chunks: [fakeChunk],
          };
        }
      }

      console.log(`[STRUCTURAL MATCH] Section ${number} — not found in any document`);
      return {
        text: `[Requested Section: ${number}]\nNo exact matching section was found in the uploaded documents. Do not use another section as a substitute.`,
        chunks: [],
      };
    }
  }

  // ── SEMANTIC PATH (BM25 with synonym expansion) ───────────────────────────────
  const queryTerms = tokenize(expandedQuery);

  if (queryTerms.length === 0) {
    return { text: "", chunks: [] };
  }

  const scored = bm25Score(queryTerms, allChunksWithFallback);

  if (scored.length === 0) {
    console.log(
      `[SEMANTIC SEARCH] No relevant chunks found for: "${query.slice(0, 80)}"`
    );
    return { text: "", chunks: [] };
  }

  console.log(
    `[SEMANTIC SEARCH] query: "${query.slice(0, 80)}" → ${scored.length} chunks scored, ` +
    `top BM25: ${scored[0].bm25Score.toFixed(2)}`
  );

  const top5 = scored.slice(0, 5);
  return {
    text: top5.map((s) => formatChunkContext(s)).join("\n\n"),
    chunks: top5,
  };
}
