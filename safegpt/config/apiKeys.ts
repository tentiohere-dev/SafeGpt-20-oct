/**
 * Central API key configuration (NO hardcoded secrets).
 *
 * - Leave arrays empty for production.
 * - For local development, you may add keys here, but DO NOT commit them.
 * - Prefer environment variables (highest priority). See `services/keyManager.ts`.
 */

export interface ApiKeyConfig {
  groq: string[];
  gemini: string[];
  tavily: string[];
  openrouter: string[]; // optional
  nvidia: string[];
  ngrokUrl: string; // optional
}

export function getConfigApiKeys(): ApiKeyConfig {
  const base: ApiKeyConfig = {
    groq: [],
    gemini: [],
    tavily: [],
    openrouter: [],
    nvidia: [],
    ngrokUrl: "",
  };

  // Optional local override file (kept out of git).
  // Create `safegpt/config/apiKeys.local.ts` exporting either:
  // - `default` ApiKeyConfig, or
  // - `getLocalApiKeys(): Partial<ApiKeyConfig>`
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("./apiKeys.local");
    const local: any =
      (mod && mod.default) ||
      (typeof mod?.getLocalApiKeys === "function" ? mod.getLocalApiKeys() : null) ||
      null;
    if (local && typeof local === "object") {
      return {
        groq: Array.isArray(local.groq) ? local.groq : base.groq,
        gemini: Array.isArray(local.gemini) ? local.gemini : base.gemini,
        tavily: Array.isArray(local.tavily) ? local.tavily : base.tavily,
        openrouter: Array.isArray(local.openrouter) ? local.openrouter : base.openrouter,
        nvidia: Array.isArray(local.nvidia) ? local.nvidia : base.nvidia,
        ngrokUrl: typeof local.ngrokUrl === "string" ? local.ngrokUrl : base.ngrokUrl,
      };
    }
  } catch {
    // no local override
  }

  return base;
}
