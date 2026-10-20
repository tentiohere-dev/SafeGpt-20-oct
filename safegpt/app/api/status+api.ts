/**
 * SafeGPT — Server Key Status
 *
 * Returns which providers have server-side keys configured, plus the exact key count.
 * SAFE: Never returns actual key values — only booleans and counts.
 *
 * Used by:
 *  - checkModelStatus (aiService.ts) to know if server has keys and how many
 *  - models.tsx to render the correct number of key rows in Model Status screen
 */

import { secureJson } from '../../server/security';

function parseEnvKeys(base: string): string[] {
  const multi = (process.env[`${base}_API_KEYS`] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (multi.length > 0) return multi;
  const keys: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const val = (process.env[`${base}_API_KEY_${i}`] ?? '').trim();
    if (!val) break;
    keys.push(val);
  }
  return keys;
}

function parseTavilyKeys(): string[] {
  // Support TAVILY_API_KEY (comma-separated), TAVILY_API_KEYS, and TAVILY_API_KEY_1...N
  const single = (process.env['TAVILY_API_KEY'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (single.length > 0) return single;
  return parseEnvKeys('TAVILY');
}

export async function GET(_request: Request): Promise<Response> {
  const groq       = parseEnvKeys('GROQ');
  const gemini     = parseEnvKeys('GEMINI');
  const openrouter = parseEnvKeys('OPENROUTER');
  const nvidia     = parseEnvKeys('NVIDIA');
  const tavily     = parseTavilyKeys();
  const cerebras   = parseEnvKeys('CEREBRAS');
  const ngrokUrl   = (process.env['NGROK_URL'] ?? '').trim();

  return secureJson({
    groq:             groq.length > 0,
    groq_count:       groq.length,
    gemini:           gemini.length > 0,
    gemini_count:     gemini.length,
    openrouter:       openrouter.length > 0,
    openrouter_count: openrouter.length,
    nvidia:           nvidia.length > 0,
    nvidia_count:     nvidia.length,
    tavily:           tavily.length > 0,
    tavily_count:     tavily.length,
    cerebras:         cerebras.length > 0,
    cerebras_count:   cerebras.length,
    local:            ngrokUrl.length > 0,
  });
}
