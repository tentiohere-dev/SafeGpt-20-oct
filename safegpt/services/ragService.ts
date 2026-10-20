export type DocType = "law" | "book" | "general";

export type RagChunkMetadata = {
  article_number?: string;
  article_number_ar?: string;
  article_number_int?: number;
  title?: string;
  document_name: string;
  section_type: "legal_article" | "section" | "document";
  index_version?: number;
  // Extended metadata for smart retrieval
  doc_type?: DocType;
  chunk_type?: "structural" | "semantic";
  chapter_number?: number;
  section_number?: string;
  heading_text?: string;
};

export type ParseStats = {
  docType: DocType;
  articleCount: number;
  chapterCount: number;
  sectionCount: number;
};

export type RagChunk = {
  id: string;
  text: string;
  normalizedText: string;
  metadata: RagChunkMetadata;
};

type RagAsset = {
  name?: string;
  mimeType?: string;
  type?: string;
  size?: number;
  uri: string;
};

export const RAG_INDEX_VERSION = 2;

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

const WESTERN_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

export function normalizeNumerals(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] || d);
}

export function toArabicIndicNumber(value: string): string {
  return normalizeNumerals(value).replace(/[0-9]/g, (d) => WESTERN_DIGITS[Number(d)] || d);
}

// ─── TEXT UTILITIES ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","and","for","are","was","with","this","that","from","have","will",
  "been","they","their","said","each","which","them","then","than","also",
  "not","but","all","can","had","her","his","him","its","our","out","who",
  "get","may","use","any","two",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[،,.。!?؟\-_:;()\[\]{}'"«»\/]/g, " ")
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - "٠".charCodeAt(0) + 48))
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function getArticleSnippet(text: string, maxLength = 600): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastPeriod = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("؟"),
    truncated.lastIndexOf("،")
  );
  if (lastPeriod > 300) {
    return (
      truncated.slice(0, lastPeriod + 1) +
      "\n[Article continues — view full text in source document]"
    );
  }
  return truncated + "...\n[Article continues — view full text in source document]";
}

// ─── SCANNED PDF & DATE DETECTION ─────────────────────────────────────────────

export function detectScannedPDF(
  extractedText: string,
  filename: string
): string | null {
  const meaningful = extractedText.replace(/\s+/g, " ").trim();
  if (meaningful.length < 200) {
    return (
      `"${filename}" appears to be a scanned or image-based PDF. ` +
      `Very little text was extracted (${meaningful.length} characters). ` +
      `Regulation lookup and article matching may not work correctly. ` +
      `For best results, use a searchable (text-based) PDF.`
    );
  }
  return null;
}

const DOCUMENT_DATE_REGEX =
  /(?:issued|effective|dated?|published|version\s*date|last\s*updated?|revision\s*date)[^\d]*(\d{4})/i;
const STALE_CUTOFF_YEAR = 2017;

export function detectDocumentDate(
  extractedText: string,
  filename: string
): string | null {
  const sample = extractedText.slice(0, 8000);
  const match = DOCUMENT_DATE_REGEX.exec(sample);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  if (year < STALE_CUTOFF_YEAR) {
    return (
      `"${filename}" appears to contain a document dated ${year}. ` +
      `This regulation or procedure may have been updated since then. ` +
      `Verify that this is the current version before relying on it for compliance decisions.`
    );
  }
  return null;
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 120000);
}

function fallbackDocumentText(asset: RagAsset, reason?: string): string {
  const name = asset.name || "Document";
  const type = asset.mimeType || asset.type || "unknown";
  const size = asset.size ? `${Math.round(asset.size / 1024)} KB` : "Unknown";
  return cleanExtractedText(
    `Document: ${name}\nType: ${type}\nSize: ${size}\n${reason ? `Indexing note: ${reason}\n` : ""}`
  );
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function decodePdfEscapes(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3}|.)/g, (_, esc: string) => {
    if (esc === "n") return "\n";
    if (esc === "r") return "\r";
    if (esc === "t") return "\t";
    if (esc === "b") return "\b";
    if (esc === "f") return "\f";
    if (esc === "(") return "(";
    if (esc === ")") return ")";
    if (esc === "\\") return "\\";
    if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return esc;
  });
}

function decodePdfHex(hex: string): string {
  const compact = hex.replace(/\s+/g, "");
  if (compact.length < 2) return "";
  const bytes: number[] = [];
  for (let i = 0; i < compact.length - 1; i += 2) {
    bytes.push(parseInt(compact.slice(i, i + 2), 16));
  }
  // Explicit UTF-16 BE BOM (0xFE 0xFF)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  // Heuristic: if ≥50% of even-indexed bytes are 0x00 and length is even,
  // treat as big-endian UTF-16 without BOM (common in CIDFont PDFs)
  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    const nullEvenCount = bytes.filter((b, i) => i % 2 === 0 && b === 0).length;
    if (nullEvenCount / (bytes.length / 2) >= 0.5) {
      let out = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const cp = (bytes[i] << 8) | bytes[i + 1];
        if (cp >= 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) {
          out += String.fromCharCode(cp);
        }
      }
      return out;
    }
  }
  // Default: single-byte — filter out non-printable control chars
  return String.fromCharCode(
    ...bytes.filter((b) => b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d)
  );
}

function extractTextOperators(pdfText: string): string {
  const parts: string[] = [];
  const literalTj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  const hexTj = /<([0-9a-fA-F\s]{4,})>\s*Tj/g;
  const arrayTj = /\[((?:.|\n|\r)*?)\]\s*TJ/g;
  let match: RegExpExecArray | null;

  while ((match = literalTj.exec(pdfText))) parts.push(decodePdfEscapes(match[1]));
  while ((match = hexTj.exec(pdfText))) parts.push(decodePdfHex(match[1]));
  while ((match = arrayTj.exec(pdfText))) {
    const body = match[1];
    const literal = /\(((?:\\.|[^\\)])*)\)/g;
    const hex = /<([0-9a-fA-F\s]{4,})>/g;
    let inner: RegExpExecArray | null;
    while ((inner = literal.exec(body))) parts.push(decodePdfEscapes(inner[1]));
    while ((inner = hex.exec(body))) parts.push(decodePdfHex(inner[1]));
  }

  return cleanExtractedText(parts.join(" ").replace(/[^\S\n]+/g, " "));
}

async function inflateStream(bytes: Uint8Array): Promise<string> {
  const g: any = globalThis as any;
  if (!g.DecompressionStream) return "";
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const stream = new Blob([buffer]).stream().pipeThrough(new g.DecompressionStream("deflate"));
    const inflated = await new Response(stream).arrayBuffer();
    return bytesToBinary(new Uint8Array(inflated));
  } catch {
    return "";
  }
}

// Legacy hand-written PDF parser — used as fallback if pdfjs-dist fails.
// Handles ToUnicode-unaware extraction (may garble subset-encoded fonts).
async function extractPdfTextFallback(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const binary = bytesToBinary(bytes);
  const snippets = [binary];
  let cursor = 0;

  while (cursor < binary.length) {
    const streamStart = binary.indexOf("stream", cursor);
    if (streamStart === -1) break;
    const dataStart = streamStart + 6 + (binary[streamStart + 6] === "\r" && binary[streamStart + 7] === "\n" ? 2 : binary[streamStart + 6] === "\n" ? 1 : 0);
    const end = binary.indexOf("endstream", dataStart);
    if (end === -1) break;
    const header = binary.slice(Math.max(0, streamStart - 1500), streamStart);
    const rawEnd = binary[end - 2] === "\r" && binary[end - 1] === "\n" ? end - 2 : binary[end - 1] === "\n" ? end - 1 : end;
    const streamBytes = bytes.subarray(dataStart, Math.max(dataStart, rawEnd));
    if (/\/FlateDecode/.test(header)) {
      const inflated = await inflateStream(streamBytes);
      if (inflated) snippets.push(inflated);
    } else {
      snippets.push(bytesToBinary(streamBytes));
    }
    cursor = end + 9;
  }

  return cleanExtractedText(snippets.map(extractTextOperators).filter(Boolean).join("\n\n"));
}

// Primary PDF extractor — uses pdfjs-dist which correctly resolves
// ToUnicode CMap tables, handling subset-encoded and CIDFont PDFs.
// Falls back to the legacy parser if pdfjs-dist throws.
async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist");
    // Point the worker at the exact version we installed so the API contract matches
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;
    let fullText = "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items as any[]).map((item) => item.str).join(" ");
      fullText += pageText + "\n\n";
    }

    return cleanExtractedText(fullText);
  } catch (err: any) {
    console.warn("[PDF EXTRACTION] pdfjs-dist failed, falling back to legacy parser:", err?.message);
    return extractPdfTextFallback(buffer);
  }
}

function looksLikePlainText(type: string, name: string): boolean {
  const lower = `${type} ${name}`.toLowerCase();
  return lower.includes("text/") || lower.endsWith(".txt") || lower.endsWith(".csv") || lower.endsWith(".md");
}

function looksLikePdf(type: string, name: string): boolean {
  const lower = `${type} ${name}`.toLowerCase();
  return lower.includes("pdf") || lower.endsWith(".pdf");
}

function titleFromHeading(heading: string): string | undefined {
  const cleaned = heading.replace(/^(article|المادة)\s*(?:number|no\.?)?\s*[\(\[]?\s*[0-9٠-٩۰-۹]+\s*[\)\]]?\s*[:：.\-–—]?\s*/i, "").trim();
  return cleaned || undefined;
}

function chunkId(name: string, index: number, article?: string): string {
  return `${name}:${article || "chunk"}:${index}`.replace(/\s+/g, "-").slice(0, 120);
}

function createChunk(documentName: string, text: string, index: number, metadata: Omit<RagChunkMetadata, "document_name">): RagChunk {
  const article = metadata.article_number ? normalizeNumerals(metadata.article_number) : undefined;
  return {
    id: chunkId(documentName, index, article),
    text: cleanExtractedText(text),
    normalizedText: normalizeNumerals(cleanExtractedText(text)).toLowerCase(),
    metadata: {
      ...metadata,
      article_number: article,
      article_number_ar: article ? toArabicIndicNumber(article) : metadata.article_number_ar,
      document_name: documentName,
      index_version: RAG_INDEX_VERSION,
    },
  };
}

// ─── DOCUMENT TYPE DETECTION ──────────────────────────────────────────────────

export function detectDocumentType(text: string): DocType {
  const sample = text.slice(0, 30000);
  // Count law-style article headings — also explicitly catches Article (38): and Article (٣٨): formats
  const lawMatches =
    (sample.match(/(?:Article|ARTICLE|مادة|المادة)\s*[\(\[]?\s*[0-9٠-٩۰-۹]/g) || []).length +
    (sample.match(/(?:Article|ARTICLE)\s*\(\s*[0-9٠-٩۰-۹]/g) || []).length;
  // Count book-style chapter/section headings
  const bookMatches = (sample.match(/\b(?:Chapter|CHAPTER|Section|SECTION|Unit|UNIT)\s+[0-9]/gi) || []).length;

  console.log(`[PARSE] doc type detection — law headings: ${lawMatches}, book headings: ${bookMatches}`);

  if (lawMatches >= 2 || (lawMatches >= 1 && bookMatches === 0)) return "law";
  if (bookMatches >= 2 || (bookMatches >= 1 && lawMatches === 0)) return "book";
  return "general";
}

// ─── LAW PARSER ───────────────────────────────────────────────────────────────

function createLawChunks(clean: string, documentName: string): RagChunk[] {
  // Detects: Article 40, ARTICLE 40, Article (٤٠), مادة ٤٠, المادة 40, مادة (40)
  const articleRegex =
    /(?:^|\n|[.;:])\s*((?:Article|ARTICLE|Art\.|مادة|المادة(?:\s*رقم)?)\s*(?:number|no\.?)?\s*[\(\[]?\s*([0-9٠-٩۰-۹]+)\s*[\)\]]?\s*[:：.\-–—]?)/g;

  // Explicit patterns for Article (38): and Article (٣٨): — uses ^m so every line start is checked
  const articleRegexParenWestern =
    /^((?:Article|ARTICLE)\s*\(\s*(\d+)\s*\)\s*[:\-–—]?)/gm;
  const articleRegexParenArabic =
    /^((?:Article|ARTICLE)\s*\(\s*([٠-٩]+)\s*\)\s*[:\-–—]?)/gm;

  // Stage 3 — log each pattern and whether it matched anything

  // Merge all matches and sort by position, removing duplicates (keep first match per index)
  const seen = new Set<number>();
  const allMatches = [
    ...Array.from(clean.matchAll(articleRegex)),
    ...Array.from(clean.matchAll(articleRegexParenWestern)),
    ...Array.from(clean.matchAll(articleRegexParenArabic)),
  ]
    .filter((m) => {
      const idx = m.index ?? 0;
      if (seen.has(idx)) return false;
      seen.add(idx);
      return true;
    })
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const matches = allMatches;

  if (matches.length === 0) return [];

  console.log(`[PARSE] LAW — found ${matches.length} articles in "${documentName}"`);

  return matches
    .map((match, index) => {
      const start = match.index || 0;
      const end =
        index + 1 < matches.length
          ? matches[index + 1].index || clean.length
          : clean.length;
      const section = clean.slice(start, end).trim();
      const heading = match[1].trim();
      const article = normalizeNumerals(match[2]);
      const articleInt = parseInt(article, 10);
      return createChunk(documentName, section, index, {
        article_number: article,
        article_number_ar: toArabicIndicNumber(article),
        article_number_int: isNaN(articleInt) ? undefined : articleInt,
        title: titleFromHeading(heading),
        section_type: "legal_article",
        doc_type: "law",
        chunk_type: "structural",
        heading_text: heading,
      });
    })
    .filter((chunk) => chunk.text.length > 0);
}

// ─── BOOK PARSER ──────────────────────────────────────────────────────────────

const WRITTEN_TO_INT: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};

function parseChapterNumber(token: string): number | null {
  const normalized = normalizeNumerals(token.trim().toLowerCase());
  const asInt = parseInt(normalized, 10);
  if (!isNaN(asInt)) return asInt;
  if (WRITTEN_TO_INT[normalized] !== undefined) return WRITTEN_TO_INT[normalized];
  return null;
}

function createBookChunks(clean: string, documentName: string): RagChunk[] {
  // Chapter headings: Chapter 1, Chapter One, CHAPTER 1, Unit 2
  const chapterRegex =
    /(?:^|\n)\s*((?:Chapter|CHAPTER|Unit|UNIT)\s+([0-9٠-٩۰-۹]+|[a-zA-Z]+)(?:\s*[:：.\-–—][^\n]*)?)/gm;
  // Section headings: 1.1 Title, Section 1.2, 2.3.1
  const sectionRegex =
    /(?:^|\n)\s*((?:Section|SECTION)?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)(?:\s*[:：.\-–—][^\n]*)?)/gm;

  const chapterMatches = Array.from(clean.matchAll(chapterRegex));
  const sectionMatches = Array.from(clean.matchAll(sectionRegex));

  if (chapterMatches.length === 0 && sectionMatches.length === 0) return [];

  console.log(
    `[PARSE] BOOK — found ${chapterMatches.length} chapters, ${sectionMatches.length} sections in "${documentName}"`
  );

  const chunks: RagChunk[] = [];
  let chunkIndex = 0;

  // Extract chapter-level chunks
  for (let i = 0; i < chapterMatches.length; i++) {
    const match = chapterMatches[i];
    const start = match.index || 0;
    const end =
      i + 1 < chapterMatches.length
        ? chapterMatches[i + 1].index || clean.length
        : clean.length;
    const section = clean.slice(start, end).trim();
    const heading = match[1].trim();
    const chapterNum = parseChapterNumber(match[2]);
    chunks.push(
      createChunk(documentName, section, chunkIndex++, {
        section_type: "section",
        doc_type: "book",
        chunk_type: "structural",
        chapter_number: chapterNum ?? undefined,
        heading_text: heading,
        title: heading,
      })
    );
  }

  // Extract section-level chunks (numbered like 1.1, 2.3)
  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    const start = match.index || 0;
    const end =
      i + 1 < sectionMatches.length
        ? sectionMatches[i + 1].index || clean.length
        : clean.length;
    const section = clean.slice(start, end).trim();
    const heading = match[1].trim();
    const sectionNum = match[2];
    chunks.push(
      createChunk(documentName, section, chunkIndex++, {
        section_type: "section",
        doc_type: "book",
        chunk_type: "structural",
        section_number: sectionNum,
        heading_text: heading,
        title: heading,
      })
    );
  }

  return chunks.filter((c) => c.text.length > 0);
}

// ─── GENERAL PARSER (paragraph chunking) ─────────────────────────────────────

function createGeneralChunks(clean: string, documentName: string): RagChunk[] {
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: RagChunk[] = [];
  let current = "";
  const CHUNK_SIZE = 2500;
  const OVERLAP_WORDS = 50;

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > CHUNK_SIZE && current) {
      chunks.push(
        createChunk(documentName, current, chunks.length, {
          section_type: "section",
          doc_type: "general",
          chunk_type: "semantic",
        })
      );
      // Overlap: carry last ~50 words into next chunk
      const words = current.split(/\s+/);
      current = words.slice(Math.max(0, words.length - OVERLAP_WORDS)).join(" ") + "\n\n" + paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) {
    chunks.push(
      createChunk(documentName, current, chunks.length, {
        section_type: chunks.length ? "section" : "document",
        doc_type: "general",
        chunk_type: "semantic",
      })
    );
  }

  console.log(`[PARSE] GENERAL — created ${chunks.length} semantic chunks for "${documentName}"`);
  return chunks;
}

// ─── CHUNK VALIDATION ─────────────────────────────────────────────────────────

function validateChunks(chunks: RagChunk[], documentName: string): void {
  const empty = chunks.filter((c) => !c.text || c.text.trim().length < 10);
  const lawChunks = chunks.filter((c) => c.metadata.section_type === "legal_article");
  const withArticleInt = lawChunks.filter((c) => c.metadata.article_number_int !== undefined);
  if (empty.length > 0) {
    console.warn(`[VALIDATE] "${documentName}": ${empty.length} near-empty chunks found`);
  }
  if (lawChunks.length > 0) {
    console.log(
      `[VALIDATE] "${documentName}": ${lawChunks.length} legal articles, ` +
      `${withArticleInt.length} with integer article_number_int`
    );
    if (withArticleInt.length === 0) {
      console.warn(`[VALIDATE] "${documentName}": no article_number_int values — article lookup may be slower`);
    }
  }
}

// ─── PUBLIC ENTRY POINT ───────────────────────────────────────────────────────

export function createRagChunks(
  text: string,
  documentName: string
): { chunks: RagChunk[]; stats: ParseStats } {
  const clean = cleanExtractedText(text);
  if (!clean) return { chunks: [], stats: { docType: "general", articleCount: 0, chapterCount: 0, sectionCount: 0 } };


  const docType = detectDocumentType(clean);
  console.log(`[PARSE] "${documentName}" detected as: ${docType.toUpperCase()}`);

  if (docType === "law") {
    const chunks = createLawChunks(clean, documentName);
    console.log('STAGE 4 - CHUNKS CREATED:', chunks.length);
    if (chunks.length > 0) {
      validateChunks(chunks, documentName);
      const articleCount = chunks.filter((c) => c.metadata.article_number).length;
      return { chunks, stats: { docType, articleCount, chapterCount: 0, sectionCount: 0 } };
    }
    // Fall through to general if no articles parsed
  }

  if (docType === "book") {
    const chunks = createBookChunks(clean, documentName);
    console.log('STAGE 4 - CHUNKS CREATED:', chunks.length);
    if (chunks.length > 0) {
      const chapterCount = chunks.filter((c) => c.metadata.chapter_number !== undefined).length;
      const sectionCount = chunks.filter((c) => (c.metadata as any).section_number !== undefined).length;
      return { chunks, stats: { docType, articleCount: 0, chapterCount, sectionCount } };
    }
    // Fall through to general if no structure parsed
  }

  const chunks = createGeneralChunks(clean, documentName);
  console.log('STAGE 4 - CHUNKS CREATED:', chunks.length);
  return { chunks, stats: { docType: "general", articleCount: 0, chapterCount: 0, sectionCount: chunks.length } };
}

// ─── DOCX EXTRACTOR (ZIP + XML, no external dependencies) ────────────────────
// A .docx file is a ZIP archive. The paragraph text lives in word/document.xml
// inside <w:t> elements. We parse the ZIP local-file headers, locate that entry,
// decompress it with DecompressionStream (already used by the PDF extractor), and
// regex-extract the text nodes — returning clean plain text.

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let offset = 0;

  while (offset + 30 < bytes.length) {
    // Local file header signature: PK\x03\x04 (0x04034b50 little-endian)
    if (dv.getUint32(offset, true) !== 0x04034b50) break;

    const flags          = dv.getUint16(offset + 6,  true);
    const compression    = dv.getUint16(offset + 8,  true);
    const compressedSize = dv.getUint32(offset + 18, true);
    const fileNameLen    = dv.getUint16(offset + 26, true);
    const extraLen       = dv.getUint16(offset + 28, true);
    const fileName       = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + fileNameLen));
    const dataStart      = offset + 30 + fileNameLen + extraLen;

    if (fileName === "word/document.xml") {
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let xml: string;

      if (compression === 0) {
        // Stored — no compression
        xml = new TextDecoder().decode(compressed);
      } else if (compression === 8) {
        // Deflate-raw (standard ZIP deflate)
        const g: any = globalThis as any;
        if (!g.DecompressionStream) throw new Error("DecompressionStream not available");
        const stream = new Blob([compressed]).stream()
          .pipeThrough(new g.DecompressionStream("deflate-raw"));
        const decompressed = await new Response(stream).arrayBuffer();
        xml = new TextDecoder().decode(new Uint8Array(decompressed));
      } else {
        throw new Error(`Unsupported ZIP compression method: ${compression}`);
      }

      // Insert newlines at paragraph and line-break boundaries before extracting text
      const xmlWithBreaks = xml
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:br[^>]*\/?>/g, "\n");

      // Extract all <w:t> text node contents
      const parts: string[] = [];
      const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xmlWithBreaks)) !== null) parts.push(m[1]);

      return parts
        .join("")
        .replace(/&amp;/g,  "&")
        .replace(/&lt;/g,   "<")
        .replace(/&gt;/g,   ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }

    // Advance past this entry's data
    offset = dataStart + compressedSize;
    // If bit 3 of flags is set, a data descriptor follows (optional PK\x07\x08 signature + 12 bytes)
    if (flags & 0x08) {
      if (dv.getUint32(offset, true) === 0x08074b50) offset += 4;
      offset += 12;
    }
  }

  throw new Error("word/document.xml not found in DOCX archive");
}

export async function extractRagDocumentContent(
  asset: RagAsset
): Promise<{ content: string; indexed: boolean; chunks: RagChunk[]; parseStats?: ParseStats }> {
  const name = asset.name || "Document";
  const type = asset.mimeType || asset.type || "";
  try {
    const res = await fetch(asset.uri);
    if (!res.ok) throw new Error(`Could not read file (${res.status})`);

    if (looksLikePlainText(type, name)) {
      const extractedText = cleanExtractedText(await res.text());
      const { chunks, stats } = createRagChunks(extractedText, name);
      console.log(`[PARSE] "${name}" → ${JSON.stringify(stats)}`);
      const text = extractedText;
      return {
        content: text || fallbackDocumentText(asset, "No readable text found."),
        indexed: chunks.length > 0,
        chunks,
        parseStats: stats,
      };
    }

    const buffer = await res.arrayBuffer();
    if (looksLikePdf(type, name)) {
      const text = await extractPdfText(buffer);

      // Warn if the PDF appears to be scanned/image-based (near-zero text yield)
      const scannedWarning = detectScannedPDF(text, name);
      if (scannedWarning) console.warn('[PDF EXTRACTION]', scannedWarning);

      const { chunks, stats } = createRagChunks(text, name);
      console.log(`[PARSE] "${name}" → ${JSON.stringify(stats)}, text_len=${text.length}, chunks=${chunks.length}`);
      if (chunks.length > 0) {
        return { content: text || fallbackDocumentText(asset), indexed: true, chunks, parseStats: stats };
      }
      // Text extracted but couldn't be chunked — still index as a single chunk
      if (text.length > 0) {
        const singleChunk = createRagChunks(text + " ", name);
        if (singleChunk.chunks.length > 0) {
          return { content: text, indexed: true, chunks: singleChunk.chunks, parseStats: singleChunk.stats };
        }
      }
      return {
        content: fallbackDocumentText(asset, scannedWarning || "PDF text could not be extracted. The file may be scanned or image-based."),
        indexed: false,
        chunks: [],
      };
    }

    // DOCX — parse as ZIP archive and extract text from word/document.xml
    const isDocx = /\.docx$/i.test(name) || type.includes("wordprocessingml");
    if (isDocx) {
      try {
        const text = cleanExtractedText(await extractDocxText(buffer));
        if (text.length > 10) {
          const { chunks, stats } = createRagChunks(text, name);
          if (chunks.length > 0) {
            return { content: text, indexed: true, chunks, parseStats: stats };
          }
        }
      } catch (docxErr: any) {
        console.error('[DOCX EXTRACTION] Failed:', docxErr?.message);
      }
    }

    // Legacy .doc — attempt basic text extraction from binary (not ZIP-based)
    const isLegacyDoc = /\.doc$/i.test(name) || type.includes("msword");
    if (isLegacyDoc) {
      try {
        const rawText = bytesToBinary(new Uint8Array(buffer));
        const runs = rawText.match(/[ -~\t\r\n]{4,}/g) || [];
        const text = cleanExtractedText(runs.join(" "));
        if (text.length > 10) {
          const { chunks, stats } = createRagChunks(text, name);
          if (chunks.length > 0) {
            return { content: text, indexed: true, chunks, parseStats: stats };
          }
        }
      } catch { /* fall through */ }
    }

    return {
      content: fallbackDocumentText(asset, "This file type is stored but not text-indexed."),
      indexed: false,
      chunks: [],
    };
  } catch (error: any) {
    return {
      content: fallbackDocumentText(asset, error?.message || "Document could not be indexed."),
      indexed: false,
      chunks: [],
    };
  }
}
