import { RagChunk, tokenize, getArticleSnippet } from "./ragService";

// ─── VIOLATION RESULT TYPE ────────────────────────────────────────────────────
export type ViolationResult = {
  category: "LABOR_LAW" | "COMPANY_POLICY" | "REGULATION";
  label: string;
  documentName: string;
  articleNumber: string | null;
  articleText: string;
  confidence: "HIGH" | "LOW";
  severity: "CRITICAL" | "HIGH" | "LOW";
  bm25Score: number;
};

// ─── SITUATION SIGNALS ─────────────────────────────────────────────────────────
const SITUATION_SIGNALS = [
  "worker","employee","person","someone","staff","operator","contractor",
  "supervisor","team","crew","technician","engineer",
  "not wearing","without","refused","ignoring","violating","bypassing",
  "found","observed","reported","witnessed","noticed",
  "incident","accident","near miss","injury","hazard","unsafe act",
  "working without","no permit","no ppe","unsafe","hazardous",
  "did not","does not","is not","was not","failed to","not following",
  "violation","breach","non compliance","non-compliance",
  "عامل","موظف","شخص","مشرف","زميل","فريق","مقاول","مشغل","مهندس",
  "لا يرتدي","بدون","رفض","يتجاهل","مخالفة","تجاوز",
  "لاحظت","وجدت","شاهدت","تم الإبلاغ",
  "حادث","إصابة","موقف خطير","تصرف غير آمن","إهمال",
  "يعمل بدون","بدون تصريح","بدون معدات","غير آمن","خطر",
  "لم يرتدِ","لا يستخدم","تجاهل","أخطأ","مخالف",
];

export function isSituationQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return SITUATION_SIGNALS.some((signal) => lower.includes(signal.toLowerCase()));
}

// ─── SEVERITY CLASSIFICATION ──────────────────────────────────────────────────
const LIFE_THREATENING_KEYWORDS = [
  "confined space without","no harness","without harness",
  "no fall protection","without fall protection",
  "working at height without","electrical live work","live electrical",
  "explosive","no atmospheric test","oxygen deficiency",
  "no permit confined","lockout not applied","no isolation",
  "without breathing apparatus","no scba","no air supply",
  "working near excavation without","unsupported trench",
  "بدون حارنس","مكان مغلق بدون","صعق كهربائي",
  "انفجار","بدون عزل","بدون اختبار الغلاف الجوي",
  "نقص الأكسجين بدون","بدون تصريح مكان مغلق",
];

export function getSeverityLevel(
  situationText: string,
  articleText: string
): "CRITICAL" | "HIGH" | "LOW" {
  const combined = (situationText + " " + articleText).toLowerCase();
  if (LIFE_THREATENING_KEYWORDS.some((k) => combined.includes(k.toLowerCase()))) {
    return "CRITICAL";
  }
  if (
    articleText.toLowerCase().includes("penalty") ||
    articleText.toLowerCase().includes("fine") ||
    articleText.includes("عقوبة") ||
    articleText.includes("غرامة") ||
    articleText.includes("جزاء")
  ) {
    return "HIGH";
  }
  return "LOW";
}

// ─── CONFLICT DETECTION ────────────────────────────────────────────────────────
export function detectConflicts(violations: ViolationResult[]): string | null {
  const laborLaw = violations.filter((v) => v.category === "LABOR_LAW");
  const companyPolicy = violations.filter((v) => v.category === "COMPANY_POLICY");
  if (laborLaw.length > 0 && companyPolicy.length > 0) {
    return (
      "⚠️ Note: References found in both labor law and company policy documents. " +
      "Where they differ, Saudi Labor Law takes legal precedence over internal company policy. " +
      "Consult your legal or HSE team to clarify which applies to this specific situation."
    );
  }
  return null;
}

// ─── LOCAL BM25 SCORER ────────────────────────────────────────────────────────
function bm25Local(
  queryTerms: string[],
  chunks: RagChunk[],
  k1 = 1.5,
  b = 0.75
): Array<RagChunk & { bm25Score: number }> {
  if (chunks.length === 0 || queryTerms.length === 0) return [];
  const tokenized = chunks.map((c) => tokenize(c.normalizedText || c.text));
  const avgDocLen = tokenized.reduce((s, t) => s + t.length, 0) / tokenized.length;
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

// ─── MAIN VIOLATION DETECTION ──────────────────────────────────────────────────
type DocInput = {
  name: string;
  chunks?: RagChunk[];
};

export async function detectViolations(
  situationDescription: string,
  allUploadedDocuments: DocInput[]
): Promise<ViolationResult[]> {
  const violations: ViolationResult[] = [];

  const laborLawDocs = allUploadedDocuments.filter((d) =>
    /labor law|labour law|نظام العمل|نظام العمل السعودي/i.test(d.name)
  );
  const companyPolicyDocs = allUploadedDocuments.filter((d) =>
    /policy|procedure|hse|safety|sop|manual|سياسة|إجراء/i.test(d.name)
  );
  const regulationDocs = allUploadedDocuments.filter((d) =>
    /regulation|standard|code|iso|osha|civil defense|لائحة|معيار/i.test(d.name)
  );

  const allCategories: Array<{
    docs: DocInput[];
    category: "LABOR_LAW" | "COMPANY_POLICY" | "REGULATION";
    label: string;
  }> = [
    { docs: laborLawDocs, category: "LABOR_LAW", label: "Labor Law" },
    { docs: companyPolicyDocs, category: "COMPANY_POLICY", label: "Company Policy" },
    { docs: regulationDocs, category: "REGULATION", label: "Regulation / Standard" },
  ];

  const queryTerms = tokenize(situationDescription);

  for (const { docs, category, label } of allCategories) {
    for (const doc of docs) {
      const chunks = doc.chunks || [];
      if (chunks.length === 0) continue;
      const scored = bm25Local(queryTerms, chunks);
      if (scored.length === 0) continue;
      const topChunk = scored[0];
      const isMediumConfidence = topChunk.bm25Score > 0.8;
      const isHighConfidence = topChunk.bm25Score > 2.0;
      if (!isMediumConfidence) continue;
      const severity = getSeverityLevel(situationDescription, topChunk.text);
      violations.push({
        category,
        label,
        documentName: doc.name,
        articleNumber: (topChunk.metadata as any)?.article_number || null,
        articleText: getArticleSnippet(topChunk.text),
        confidence: isHighConfidence ? "HIGH" : "LOW",
        severity,
        bm25Score: topChunk.bm25Score,
      });
    }
  }

  return violations;
}
