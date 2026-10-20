import type { ApiKeys } from "@/context/AppContext";
import { getProviderKeyPool, type KeyPoolProvider } from "@/services/keyManager";
import { Platform } from "react-native";

type Provider = Exclude<KeyPoolProvider, "cerebras">;

type ProviderState = {
  nextIndex: number;
  lastOkAt: number;
  lastFailAt: number;
};

const PROVIDERS: Provider[] = ["groq", "gemini", "openrouter", "nvidia", "tavily"];

const state: Record<Provider, ProviderState> = {
  groq:       { nextIndex: 0, lastOkAt: 0, lastFailAt: 0 },
  gemini:     { nextIndex: 0, lastOkAt: 0, lastFailAt: 0 },
  openrouter: { nextIndex: 0, lastOkAt: 0, lastFailAt: 0 },
  nvidia:     { nextIndex: 0, lastOkAt: 0, lastFailAt: 0 },
  tavily:     { nextIndex: 0, lastOkAt: 0, lastFailAt: 0 },
};

let _timer: any = null;
let _getKeys: (() => ApiKeys) | null = null;

function now() {
  return Date.now();
}

function rotate<T>(arr: T[], startIndex: number): T[] {
  if (!arr.length) return arr;
  const i = ((startIndex % arr.length) + arr.length) % arr.length;
  return [...arr.slice(i), ...arr.slice(0, i)];
}

export function getRotatedKeyPool(provider: KeyPoolProvider, keys: ApiKeys): string[] {
  const pool = getProviderKeyPool(provider, keys);
  const idx = state[provider as Provider]?.nextIndex || 0;
  return rotate(pool, idx);
}

export function reportProviderFailure(provider: Provider) {
  const s = state[provider];
  s.lastFailAt = now();
  s.nextIndex = s.nextIndex + 1;
}

export function reportProviderSuccess(provider: Provider) {
  const s = state[provider];
  s.lastOkAt = now();
}

export function configureReliabilityMonitor(getKeys: () => ApiKeys) {
  _getKeys = getKeys;
}

export function startReliabilityMonitor() {
  if (_timer) return;
  _timer = setInterval(() => {
    tick().catch(() => {});
  }, 10_000);
  // Run once immediately for faster recovery.
  tick().catch(() => {});
}

export function stopReliabilityMonitor() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

async function tick() {
  if (!_getKeys) return;
  const keys = _getKeys();
  // Probe providers in the background; never throw.
  await Promise.allSettled(PROVIDERS.map((p) => probeProvider(p, keys)));
}

async function probeProvider(provider: Provider, keys: ApiKeys) {
  // This is intentionally lightweight and silent. It only advances the key index
  // if the current key fails, enabling automatic recovery without UI changes.
  const pool =
    provider === "tavily"
      ? getProviderKeyPool("tavily", keys)
      : getRotatedKeyPool(provider as KeyPoolProvider, keys);

  if (!pool.length) return;

  for (let i = 0; i < Math.min(pool.length, 2); i++) {
    const key = pool[i];
    const ok = await ping(provider, key);
    if (ok) {
      reportProviderSuccess(provider);
      return;
    }
    reportProviderFailure(provider);
  }
}

async function ping(provider: Provider, key: string): Promise<boolean> {
  // On web all calls go through the server proxy — never ping AI providers directly from the browser.
  if (Platform.OS === "web") return true;
  try {
    const signal = typeof (AbortSignal as any)?.timeout === "function" ? (AbortSignal as any).timeout(6000) : undefined;
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal });
      return r.ok;
    }
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${key}` }, signal });
      return r.ok;
    }
    if (provider === "gemini") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, { signal });
      return r.ok;
    }
    if (provider === "nvidia") {
      const r = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal });
      return r.ok;
    }
    if (provider === "tavily") {
      // A minimal POST to confirm the key is valid. DDG fallback remains in app flow.
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query: "construction site safety", max_results: 1 }),
        signal,
      });
      return r.ok;
    }
    return false;
  } catch {
    return false;
  }
}
