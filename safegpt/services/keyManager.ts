/**
 * SafeGPT — Key Manager
 *
 * Centralized API-key resolution & validation.
 *
 * Priority (highest first):
 *   1. Environment variables  (GROQ_API_KEYS / _KEY_1 / _KEY_2 / ...)
 *   2. Config file            (`config/apiKeys.ts`)
 *   3. Manual user input from Settings (AsyncStorage) — Key 1 → Key 2 → Key 3
 *
 * Unlimited-key rotation:
 *   Add any number of keys via GROQ_API_KEYS=key1,key2,...  OR individual
 *   GROQ_API_KEY_1, GROQ_API_KEY_2, GROQ_API_KEY_3, GROQ_API_KEY_4 … env
 *   vars (scanned until the first gap). All keys in the pool are exhausted
 *   for the current model before the fallback chain moves to the next model.
 *
 * Empty strings in user input do NOT override env/config keys.
 */

import type { ApiKeys } from "@/context/AppContext";
import { getConfigApiKeys } from "@/config/apiKeys";
import { Platform } from "react-native";

// ── Helpers ──────────────────────────────────────────────────────────────────
function envValue(name: string): string {
  try {
    const g: any = globalThis as any;
    const v = g.process?.env?.[name];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function parseKeyList(raw: string): string[] {
  return raw
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqNonEmpty(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const s = (v || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function firstNonEmpty(list: string[]): string {
  return list.find((s) => typeof s === "string" && s.trim().length > 0)?.trim() || "";
}

export type KeyPoolProvider = "groq" | "gemini" | "tavily" | "openrouter" | "nvidia" | "cerebras";

/**
 * Scans for GROQ_API_KEY_1, GROQ_API_KEY_2, …, GROQ_API_KEY_N env vars,
 * stopping at the first gap. Supports unlimited individual numbered keys.
 */
function readNumberedEnvKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const val = envValue(`${prefix}_API_KEY_${i}`);
    if (!val) break;
    keys.push(val);
  }
  return keys;
}

function parseTavilyEnvKeys(): string[] {
  // Support TAVILY_API_KEY (comma-separated, as documented), TAVILY_API_KEYS, and numbered keys
  const single = parseKeyList(envValue("TAVILY_API_KEY"));
  if (single.length > 0) return single;
  return parseKeyList(envValue("TAVILY_API_KEYS"));
}

/**
 * Returns an ordered, deduplicated key pool for a provider.
 *
 * Pool order:
 *   1. GROQ_API_KEYS      (comma-separated multi-key list env var — unlimited)
 *   2. GROQ_API_KEY_1…N   (individual numbered env vars — unlimited, scanned dynamically)
 *   3. Config file keys
 *   4. User Settings Key 1 (groqApiKey)
 *   5. User Settings Key 2 (groqApiKey2)
 *   6. User Settings Key 3 (groqApiKey3)
 */
export function getProviderKeyPool(
  provider: KeyPoolProvider,
  userKeys?: Partial<ApiKeys> | null
): string[] {
  const cfg = getConfigApiKeys();

  const envLists: Record<KeyPoolProvider, string[]> = {
    groq:       parseKeyList(envValue("GROQ_API_KEYS")),
    gemini:     parseKeyList(envValue("GEMINI_API_KEYS")),
    tavily:     parseTavilyEnvKeys(),
    openrouter: parseKeyList(envValue("OPENROUTER_API_KEYS")),
    nvidia:     parseKeyList(envValue("NVIDIA_API_KEYS")),
    cerebras:   parseKeyList(envValue("CEREBRAS_API_KEYS")),
  };

  const envNumbered: Record<KeyPoolProvider, string[]> = {
    groq:       readNumberedEnvKeys("GROQ"),
    gemini:     readNumberedEnvKeys("GEMINI"),
    tavily:     readNumberedEnvKeys("TAVILY"),
    openrouter: readNumberedEnvKeys("OPENROUTER"),
    nvidia:     readNumberedEnvKeys("NVIDIA"),
    cerebras:   readNumberedEnvKeys("CEREBRAS"),
  };

  const configLists: Record<KeyPoolProvider, string[]> = {
    groq:       cfg.groq       || [],
    gemini:     cfg.gemini     || [],
    tavily:     cfg.tavily     || [],
    openrouter: cfg.openrouter || [],
    nvidia:     cfg.nvidia     || [],
    cerebras:   [],
  };

  let settingsKey  = "";
  let settingsKey2 = "";
  let settingsKey3 = "";
  try {
    const k  = provider + "ApiKey";
    const k2 = provider + "ApiKey2";
    const k3 = provider + "ApiKey3";
    const v  = (userKeys as any)?.[k];
    const v2 = (userKeys as any)?.[k2];
    const v3 = (userKeys as any)?.[k3];
    if (typeof v  === "string") settingsKey  = v.trim();
    if (typeof v2 === "string") settingsKey2 = v2.trim();
    if (typeof v3 === "string") settingsKey3 = v3.trim();
  } catch {
    settingsKey  = "";
    settingsKey2 = "";
    settingsKey3 = "";
  }

  return uniqNonEmpty([
    ...envLists[provider],
    ...envNumbered[provider],
    ...configLists[provider],
    ...(settingsKey  ? [settingsKey]  : []),
    ...(settingsKey2 ? [settingsKey2] : []),
    ...(settingsKey3 ? [settingsKey3] : []),
  ]);
}

function resolveFromEnv(): Partial<ApiKeys> {
  const groq       = getProviderKeyPool("groq",       null);
  const gemini     = getProviderKeyPool("gemini",     null);
  const tavily     = getProviderKeyPool("tavily",     null);
  const openrouter = getProviderKeyPool("openrouter", null);
  const nvidia     = getProviderKeyPool("nvidia",     null);
  const cerebras   = getProviderKeyPool("cerebras",   null);
  const ngrokUrl   = envValue("NGROK_URL");

  return {
    groqApiKey:       firstNonEmpty(groq),
    groqApiKey2:      groq.length > 1 ? groq[1] : "",
    groqApiKey3:      groq.length > 2 ? groq[2] : "",
    geminiApiKey:     firstNonEmpty(gemini),
    geminiApiKey2:    gemini.length > 1 ? gemini[1] : "",
    geminiApiKey3:    gemini.length > 2 ? gemini[2] : "",
    tavilyApiKey:     firstNonEmpty(tavily),
    tavilyApiKey2:    tavily.length > 1 ? tavily[1] : "",
    tavilyApiKey3:    tavily.length > 2 ? tavily[2] : "",
    openrouterApiKey: firstNonEmpty(openrouter),
    nvidiaApiKey:     firstNonEmpty(nvidia),
    cerebrasApiKey:   firstNonEmpty(cerebras),
    cerebrasApiKey2:  cerebras.length > 1 ? cerebras[1] : "",
    cerebrasApiKey3:  cerebras.length > 2 ? cerebras[2] : "",
    ngrokUrl:         ngrokUrl?.trim() || "",
  } as Partial<ApiKeys>;
}

/** Resolve final ApiKeys from env + config + optional user-entered values. */
export function resolveApiKeys(userKeys?: Partial<ApiKeys> | null): ApiKeys {
  const cfg = getConfigApiKeys();
  const env = resolveFromEnv();

  const result: ApiKeys = {
    groqApiKey:         "",
    groqApiKey2:        "",
    groqApiKey3:        "",
    openrouterApiKey:   "",
    geminiApiKey:       "",
    geminiApiKey2:      "",
    geminiApiKey3:      "",
    nvidiaApiKey:       "",
    nvidiaVisionApiKey: "",
    nvidiaTtsApiKey:    "",
    nvidiaSttApiKey:    "",
    ngrokUrl:           "",
    tavilyApiKey:       "",
    tavilyApiKey2:      "",
    tavilyApiKey3:      "",
    cerebrasApiKey:     "",
    cerebrasApiKey2:    "",
    cerebrasApiKey3:    "",
  };

  // 1) env
  Object.assign(result, env);
  // 2) config file (only fill gaps)
  if (!result.groqApiKey)       result.groqApiKey       = firstNonEmpty(cfg.groq);
  if (!result.geminiApiKey)     result.geminiApiKey     = firstNonEmpty(cfg.gemini);
  if (!result.tavilyApiKey)     result.tavilyApiKey     = firstNonEmpty(cfg.tavily);
  if (!result.openrouterApiKey) result.openrouterApiKey = firstNonEmpty(cfg.openrouter);
  if (!result.ngrokUrl)         result.ngrokUrl         = (cfg.ngrokUrl || "").trim();
  if (!result.nvidiaApiKey)     result.nvidiaApiKey     = firstNonEmpty(cfg.nvidia);

  // 3) user settings (only fill gaps — never let empty string wipe a real key)
  if (userKeys && typeof userKeys === "object") {
    for (const k of Object.keys(userKeys) as (keyof ApiKeys)[]) {
      const v = (userKeys as any)[k];
      if (!result[k] && typeof v === "string" && v.trim().length > 0) {
        result[k] = v.trim();
      }
    }
  }

  return result;
}

// ── Validation helpers ────────────────────────────────────────────────────────
function withTimeout(ms: number): AbortSignal | undefined {
  const a: any = AbortSignal as any;
  return typeof a?.timeout === "function" ? a.timeout(ms) : undefined;
}

export async function validateGroqKey(key: string): Promise<boolean> {
  if (!key || !key.trim()) return false;
  if (Platform.OS === "web") return true;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: withTimeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function validateGeminiKey(key: string): Promise<boolean> {
  if (!key || !key.trim()) return false;
  if (Platform.OS === "web") return true;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key.trim())}`,
      { signal: withTimeout(10000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function validateOpenRouterKey(key: string): Promise<boolean> {
  if (!key || !key.trim()) return false;
  if (Platform.OS === "web") return true;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: withTimeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function validateNvidiaKey(key: string): Promise<boolean> {
  if (!key || !key.trim()) return false;
  if (Platform.OS === "web") return true;
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: withTimeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface KeyValidationReport {
  groq: boolean;
  groq2: boolean;
  groq3: boolean;
  gemini: boolean;
  gemini2: boolean;
  gemini3: boolean;
  openrouter: boolean;
  nvidia: boolean;
  tavilyConfigured: boolean;
  tavily2Configured: boolean;
  tavily3Configured: boolean;
}

/**
 * Validate every key in parallel. Safe to call on app start.
 * Never logs the key value.
 */
export async function validateAllKeys(keys: ApiKeys): Promise<KeyValidationReport> {
  const groqPool   = getProviderKeyPool("groq",   keys);
  const geminiPool = getProviderKeyPool("gemini", keys);
  const tavilyPool = getProviderKeyPool("tavily", keys);

  const [groq, groq2, groq3, gemini, gemini2, gemini3, openrouter, nvidia] = await Promise.all([
    validateGroqKey(groqPool[0]   || ""),
    validateGroqKey(groqPool[1]   || ""),
    validateGroqKey(groqPool[2]   || ""),
    validateGeminiKey(geminiPool[0] || ""),
    validateGeminiKey(geminiPool[1] || ""),
    validateGeminiKey(geminiPool[2] || ""),
    validateOpenRouterKey(keys.openrouterApiKey),
    validateNvidiaKey(keys.nvidiaApiKey),
  ]);

  return {
    groq,
    groq2,
    groq3,
    gemini,
    gemini2,
    gemini3,
    openrouter,
    nvidia,
    tavilyConfigured:  Boolean(tavilyPool[0]),
    tavily2Configured: Boolean(tavilyPool[1]),
    tavily3Configured: Boolean(tavilyPool[2]),
  };
}
