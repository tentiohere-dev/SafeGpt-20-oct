import { normalizeNumerals } from "./ragService";

export type QueryClassification =
  | { type: "structural"; target: "article"; number: number }
  | { type: "structural"; target: "chapter"; number: number }
  | { type: "structural"; target: "section"; number: string }
  | { type: "semantic" };

const WRITTEN_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  "twenty one": 21, "twenty-one": 21, "twenty two": 22, "twenty-two": 22,
  "twenty three": 23, "twenty-three": 23, "twenty four": 24, "twenty-four": 24,
  "twenty five": 25, "twenty-five": 25, "twenty six": 26, "twenty-six": 26,
  "twenty seven": 27, "twenty-seven": 27, "twenty eight": 28, "twenty-eight": 28,
  "twenty nine": 29, "twenty-nine": 29,
  "thirty one": 31, "thirty-one": 31, "thirty two": 32, "thirty-two": 32,
  "thirty three": 33, "thirty-three": 33, "thirty four": 34, "thirty-four": 34,
  "thirty five": 35, "thirty-five": 35, "thirty six": 36, "thirty-six": 36,
  "thirty seven": 37, "thirty-seven": 37, "thirty eight": 38, "thirty-eight": 38,
  "thirty nine": 39, "thirty-nine": 39,
  "forty one": 41, "forty-one": 41, "forty two": 42, "forty-two": 42,
  "forty three": 43, "forty-three": 43, "forty four": 44, "forty-four": 44,
  "forty five": 45, "forty-five": 45, "forty six": 46, "forty-six": 46,
  "forty seven": 47, "forty-seven": 47, "forty eight": 48, "forty-eight": 48,
  "forty nine": 49, "forty-nine": 49,
  "fifty one": 51, "fifty-one": 51, "fifty two": 52, "fifty-two": 52,
  "fifty three": 53, "fifty-three": 53, "fifty four": 54, "fifty-four": 54,
  "fifty five": 55, "fifty-five": 55,
  "one hundred": 100,
};

function parseNumberToken(token: string): number | null {
  const normalized = normalizeNumerals(token.trim()).toLowerCase();
  const asInt = parseInt(normalized, 10);
  if (!isNaN(asInt)) return asInt;
  if (WRITTEN_NUMBERS[normalized] !== undefined) return WRITTEN_NUMBERS[normalized];
  // Try compound written numbers like "forty" inside a phrase
  for (const [word, val] of Object.entries(WRITTEN_NUMBERS)) {
    if (normalized === word) return val;
  }
  return null;
}

export function classifyQuery(userQuery: string): QueryClassification {
  const normalized = normalizeNumerals(userQuery);
  const lower = normalized.toLowerCase().trim();

  // Article patterns (Arabic + English, with and without ال prefix)
  // Handles: "Article 40", "Article (40)", "Article (٣٨)", "ARTICLE 40", "مادة ٤٠", "المادة 40", "what is article forty"
  const articleRegex =
    /(?:article|مادة|المادة)\s*(?:number|no\.?)?\s*[\(\[]?\s*([0-9٠-٩۰-۹]+|[a-z]+(?:[\s\-][a-z]+)?)\s*[\)\]]?/i;
  const articleMatch = lower.match(articleRegex);
  if (articleMatch) {
    const num = parseNumberToken(articleMatch[1]);
    if (num !== null) {
      return { type: "structural", target: "article", number: num };
    }
  }

  // Section patterns with dotted numbers: "Section 2.1", "what does Section 3.2 say"
  const sectionDotRegex = /\b(?:section|unit)\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i;
  const sectionDotMatch = lower.match(sectionDotRegex);
  if (sectionDotMatch) {
    return { type: "structural", target: "section", number: sectionDotMatch[1] };
  }

  // Bare dotted numbers like "1.1" or "3.2"
  const bareDotRegex = /\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/;
  const bareDotMatch = lower.match(bareDotRegex);
  if (bareDotMatch) {
    return { type: "structural", target: "section", number: bareDotMatch[1] };
  }

  // Chapter patterns: "Chapter 3", "Explain Chapter Five", "Summarise Chapter 3", "Unit 4"
  const chapterRegex = /(?:chapter|unit)\s+([0-9]+|[a-z]+(?:[\s\-][a-z]+)?)/i;
  const chapterMatch = lower.match(chapterRegex);
  if (chapterMatch) {
    const num = parseNumberToken(chapterMatch[1]);
    if (num !== null) {
      return { type: "structural", target: "chapter", number: num };
    }
  }

  return { type: "semantic" };
}
