import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Platform, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/context/AppContext";
import { checkModelStatus } from "@/services/aiService";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useColors } from "@/hooks/useColors";
import { moderateScale, useLayoutConfig } from "@/hooks/useResponsive";
import { authenticateWithBiometric, verifySettingsPassword } from "@/services/authService";
import { verifyEmergencyCode } from "@/services/emergencyCodeService";

// ─── Models lock gate: 5 attempts per 15 minutes ─────────────────────────────
const MODELS_MAX_ATTEMPTS = 5;
const MODELS_LOCKOUT_MS   = 15 * 60 * 1000;
const MODELS_LOCKOUT_KEY  = "safegpt_models_lockout";

function readModelsLockout(): { count: number; lockedUntil: number } {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(MODELS_LOCKOUT_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return { count: 0, lockedUntil: 0 };
}

function saveModelsLockout(data: { count: number; lockedUntil: number }) {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      if (data.count === 0 && data.lockedUntil === 0) {
        localStorage.removeItem(MODELS_LOCKOUT_KEY);
      } else {
        localStorage.setItem(MODELS_LOCKOUT_KEY, JSON.stringify(data));
      }
    }
  } catch {}
}

// ─── Types ────────────────────────────────────────────────────────────────────
type TavilyKeyStatus = "Online" | "Offline" | "Rate Limited" | "Invalid Key" | "Not Set" | "…";

// ─── Provider / Model definitions ────────────────────────────────────────────
interface ModelDef {
  id: string;
  label: string;
  icon: string;
}
interface ProviderDef {
  id: string;
  label: string;
  priority: string;
  color: string;
  icon: string;
  models: ModelDef[];
  isTavily?: boolean;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "groq", label: "Groq", priority: "Priority 1  ·  Chat · STT · TTS",
    color: "#f59e0b", icon: "zap",
    models: [
      { id: "groq-gpt-oss-120b",  label: "GPT-OSS 120B",            icon: "zap"      },
      { id: "groq-llama-3.3-70b", label: "Llama 3.3 70B Versatile", icon: "zap"      },
      { id: "groq-llama-3.1-8b",  label: "Llama 3.1 8B Instant",    icon: "zap"      },
      { id: "groq-whisper",        label: "Whisper Large v3 (STT)",   icon: "mic"      },
      { id: "groq-orpheus",        label: "Orpheus Arabic TTS",        icon: "volume-2" },
    ],
  },
  {
    id: "openrouter", label: "OpenRouter", priority: "Priority 2  ·  Free Tier",
    color: "#8b5cf6", icon: "cpu",
    models: [
      { id: "openrouter-hermes",  label: "Hermes 3 405B",             icon: "cpu" },
      { id: "openrouter-llama",   label: "Llama 3.3 70B Instruct",    icon: "cpu" },
      { id: "openrouter-qwen3",   label: "Qwen3 Plus 235B",           icon: "cpu" },
      { id: "openrouter-gemini",  label: "Gemini 2.5 Flash (Vision)", icon: "eye" },
      { id: "openrouter-qwen-vl", label: "Qwen2.5 VL 72B (Vision)",   icon: "eye" },
    ],
  },
  {
    id: "gemini", label: "Gemini", priority: "Priority 3  ·  Vision",
    color: "#3b82f6", icon: "eye",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", icon: "eye" },
    ],
  },
  {
    id: "local", label: "Local (Ollama)", priority: "Priority 4  ·  Home Laptop Required",
    color: "#10b981", icon: "monitor",
    models: [
      { id: "local-llama3.2-vision", label: "Llama 3.2 Vision", icon: "monitor" },
      { id: "local-llama3.1-8b",     label: "Llama 3.1 8B",      icon: "monitor" },
      { id: "local-whisper",          label: "Whisper (local)",    icon: "mic"     },
    ],
  },
  {
    id: "nvidia", label: "NVIDIA", priority: "Priority 5  ·  Last Fallback",
    color: "#06b6d4", icon: "server",
    models: [
      { id: "nvidia-free", label: "Llama 3.3 70B", icon: "server" },
    ],
  },
  {
    id: "tavily", label: "Tavily", priority: "Web Search",
    color: "#f97316", icon: "search",
    isTavily: true,
    models: [
      { id: "duckduckgo", label: "DuckDuckGo (Free Fallback)", icon: "search" },
    ],
  },
  {
    id: "system", label: "System", priority: "Always Available",
    color: "#64748b", icon: "settings",
    models: [
      { id: "web-speech-tts",     label: "Web Speech TTS",     icon: "volume-2" },
      { id: "puter-tts",          label: "Puter.js TTS",        icon: "volume-2" },
      { id: "rag-knowledge-base", label: "RAG Knowledge Base",  icon: "book"     },
    ],
  },
  {
    id: "emergency", label: "Emergency Response", priority: "Ultra-Fast · Auto Key Rotation · Groq Fallback",
    color: "#ef4444", icon: "alert-triangle",
    models: [
      { id: "cerebras-gpt-oss-120b", label: "Cerebras GPT-OSS 120B (Primary)",       icon: "zap"   },
      { id: "groq-gpt-oss-120b",     label: "GPT-OSS 120B via Groq (Auto Fallback)", icon: "zap"   },
      { id: "openrouter-deepseek",   label: "DeepSeek R1-0528 via OpenRouter",         icon: "cpu"   },
    ],
  },
];

// ─── Status helpers ───────────────────────────────────────────────────────────
function tavilyStatusColor(s: TavilyKeyStatus): string {
  if (s === "Online")       return "#10b981";
  if (s === "Rate Limited") return "#f59e0b";
  if (s === "Invalid Key")  return "#ef4444";
  if (s === "Offline")      return "#ef4444";
  if (s === "Not Set")      return "#64748b";
  return "#94a3b8";
}

function resolveKeyStatus(
  keyId: string,
  statuses: Record<string, boolean>,
  checked: boolean,
): { online: boolean | null; label: string; color: string } {
  if (!checked) return { online: null, label: "…", color: "#94a3b8" };
  if (!(keyId in statuses)) return { online: null, label: "Not Set", color: "#64748b" };
  return statuses[keyId]
    ? { online: true,  label: "Online",  color: "#10b981" }
    : { online: false, label: "Offline", color: "#ef4444" };
}

function resolveTavilyKeyStatus(
  keyId: string,
  keyIndex: number,
  statuses: Record<string, boolean>,
  tavilyDetails: Record<number, TavilyKeyStatus>,
  checked: boolean,
): { label: TavilyKeyStatus; color: string } {
  if (!checked) return { label: "…", color: "#94a3b8" };
  const configured = statuses[keyId] === true;
  if (!configured) return { label: "Not Set", color: "#64748b" };
  const detail = tavilyDetails[keyIndex];
  if (detail) return { label: detail, color: tavilyStatusColor(detail) };
  return { label: "Online", color: "#10b981" };
}

// ─── Pulsing dot ──────────────────────────────────────────────────────────────
function StatusDot({ online, color }: { online: boolean | null; color: string }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (online !== true) { anim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1.65, duration: 800, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 1.0,  duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [online]);

  return (
    <Animated.View style={{
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: color,
      transform: [{ scale: online === true ? anim : 1 }],
      shadowColor: online === true ? color : "transparent",
      shadowOpacity: 0.7, shadowRadius: 4, elevation: online === true ? 3 : 0,
    }} />
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ label, color, online }: { label: string; color: string; online: boolean | null }) {
  return (
    <View style={styles.statusBadge}>
      <StatusDot online={online} color={color} />
      <Text style={[styles.statusBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

// ─── Provider Card ────────────────────────────────────────────────────────────
function ProviderCard({
  provider,
  statuses,
  tavilyDetails,
  keyCounts,
  checked,
  colors,
}: {
  provider: ProviderDef;
  statuses: Record<string, boolean>;
  tavilyDetails: Record<number, TavilyKeyStatus>;
  keyCounts: Record<string, number>;
  checked: boolean;
  colors: any;
}) {
  // Generate dynamic key rows based on actual count from server/pool
  const keyCount = keyCounts[provider.id] ?? 0;
  const dynamicKeys: Array<{ id: string; index: number }> = Array.from(
    { length: keyCount },
    (_, i) => ({ id: `${provider.id}-key-${i + 1}`, index: i + 1 })
  );

  const modelStatusValues: Array<boolean | null> = provider.models.map(
    m => checked && m.id in statuses ? statuses[m.id] : null
  );
  const keyStatusValues: Array<boolean | null> = dynamicKeys.map(k => {
    if (provider.isTavily) {
      return statuses[k.id] === true ? true : null;
    }
    return resolveKeyStatus(k.id, statuses, checked).online;
  });
  // For Tavily, exclude DuckDuckGo fallback from the header count — it's always online
  // and would make Tavily appear "Online" even with no API key configured.
  const allStatusValues = provider.isTavily
    ? keyStatusValues
    : [...modelStatusValues, ...keyStatusValues];
  const onlineCount = allStatusValues.filter(v => v === true).length;
  const totalCount  = allStatusValues.filter(v => v !== null).length;
  const anyOnline   = onlineCount > 0;
  const noKeysConfigured = provider.isTavily && totalCount === 0;
  const headerColor = !checked
    ? "#94a3b8"
    : noKeysConfigured
    ? "#64748b"
    : anyOnline ? "#10b981" : "#ef4444";

  const showKeys   = dynamicKeys.length > 0;
  const showModels = provider.models.length > 0;

  return (
    <View style={[styles.providerCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Provider header */}
      <View style={[styles.providerHeader, { borderBottomColor: colors.border }]}>
        <View style={[styles.providerIconBox, { backgroundColor: provider.color + "20" }]}>
          <Feather name={provider.icon as any} size={16} color={provider.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.providerTitle, { color: colors.foreground }]}>{provider.label}</Text>
          <Text style={[styles.providerPriority, { color: colors.mutedForeground }]}>{provider.priority}</Text>
        </View>
        {checked && (
          <Text style={[styles.providerCount, { color: headerColor }]}>
            {noKeysConfigured ? "Not Configured" : `${onlineCount}/${totalCount} Online`}
          </Text>
        )}
      </View>

      {/* Dynamic key rows */}
      {showKeys && (
        <View style={[styles.section, { borderBottomColor: colors.border }, !showModels && { borderBottomWidth: 0 }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            API Keys ({keyCount})
          </Text>
          {dynamicKeys.map((key, idx) => {
            let label: string;
            let color: string;
            let online: boolean | null;

            if (provider.isTavily) {
              const r = resolveTavilyKeyStatus(key.id, key.index, statuses, tavilyDetails, checked);
              label  = r.label;
              color  = r.color;
              online = r.label === "Online" ? true : (r.label === "Not Set" || r.label === "…") ? null : false;
            } else {
              const r = resolveKeyStatus(key.id, statuses, checked);
              label  = r.label;
              color  = r.color;
              online = r.online;
            }

            return (
              <View key={key.id} style={[styles.keyRow, { borderBottomColor: colors.border }, idx === dynamicKeys.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.keyIconBox, { backgroundColor: provider.color + "15" }]}>
                  <Feather name="key" size={12} color={provider.color} />
                </View>
                <Text style={[styles.keyLabel, { color: colors.foreground }]}>API Key {key.index}</Text>
                <StatusBadge label={label} color={color} online={online} />
              </View>
            );
          })}
        </View>
      )}

      {/* Model rows */}
      {showModels && (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            {provider.id === "system" ? "Services" : provider.id === "tavily" ? "Fallback" : "Models"}
          </Text>
          {provider.models.map((model, idx) => {
            const isChecked = checked && model.id in statuses;
            const online    = isChecked ? statuses[model.id] : null;
            const label     = !checked ? "…" : !isChecked ? "…" : online ? "Online" : "Offline";
            const color     = !checked || !isChecked ? "#94a3b8" : online ? "#10b981" : "#ef4444";

            return (
              <View key={model.id} style={[styles.modelRow, { borderBottomColor: colors.border }, idx === provider.models.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.modelIconBox, { backgroundColor: provider.color + "15" }]}>
                  <Feather name={model.icon as any} size={12} color={provider.color} />
                </View>
                <Text style={[styles.modelLabel, { color: colors.foreground }]}>{model.label}</Text>
                <StatusBadge label={label} color={color} online={online} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Tavily probe helper (native/direct) ──────────────────────────────────────
async function probeTavilyKeyDirect(key: string): Promise<TavilyKeyStatus> {
  if (!key) return "Not Set";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "ping", max_results: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) return "Online";
    if (r.status === 429) return "Rate Limited";
    if (r.status === 401 || r.status === 403) return "Invalid Key";
    return "Offline";
  } catch {
    return "Offline";
  }
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function ModelsScreen() {
  const { apiKeys } = useApp();
  const colors      = useColors();
  const insets      = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();

  // ── Lock gate (same password system as Settings) ─────────────────────────
  const [locked,        setLocked]        = useState(true);
  const [lockPwd,       setLockPwd]       = useState("");
  const [lockError,     setLockError]     = useState("");
  const [lockLoading,   setLockLoading]   = useState(false);
  const [showLockPwd,   setShowLockPwd]   = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntil,   setLockedUntil]   = useState(0);

  useEffect(() => {
    // Restore lockout state from storage
    const { count, lockedUntil: until } = readModelsLockout();
    if (until > Date.now()) {
      setLockedUntil(until);
      setFailedAttempts(count);
    } else if (until > 0) {
      saveModelsLockout({ count: 0, lockedUntil: 0 });
    }
    tryBiometric();
  }, []);

  const tryBiometric = async () => {
    const result = await authenticateWithBiometric();
    if (result.success) setLocked(false);
  };

  const handlePasswordUnlock = async () => {
    const now = Date.now();
    if (lockedUntil > now) {
      const mins = Math.ceil((lockedUntil - now) / 60_000);
      setLockError(`Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}. / محاولات فاشلة كثيرة. حاول بعد ${mins} دقيقة`);
      return;
    }
    if (!lockPwd.trim()) return;
    setLockLoading(true);
    setLockError("");
    const ok = await verifySettingsPassword(lockPwd);
    setLockLoading(false);
    if (ok) {
      setLocked(false);
      setLockPwd("");
      setFailedAttempts(0);
      setLockedUntil(0);
      saveModelsLockout({ count: 0, lockedUntil: 0 });
    } else {
      const newCount = failedAttempts + 1;
      if (newCount >= MODELS_MAX_ATTEMPTS) {
        const until = Date.now() + MODELS_LOCKOUT_MS;
        setLockedUntil(until);
        setFailedAttempts(0);
        saveModelsLockout({ count: MODELS_MAX_ATTEMPTS, lockedUntil: until });
        setLockError("Too many failed attempts. Model Status locked for 15 minutes. / محاولات فاشلة كثيرة. مقفل لمدة 15 دقيقة");
      } else {
        const remaining = MODELS_MAX_ATTEMPTS - newCount;
        setFailedAttempts(newCount);
        saveModelsLockout({ count: newCount, lockedUntil: 0 });
        setLockError(`Incorrect password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining. / كلمة مرور خاطئة. ${remaining} محاولة متبقية`);
      }
      setLockPwd("");
    }
  };

  // Emergency code on lock gate
  const [showEmergencyOnLock, setShowEmergencyOnLock] = useState(false);
  const [emergencyCodeLock, setEmergencyCodeLock] = useState("");

  const handleEmergencyUnlock = async () => {
    const ok = await verifyEmergencyCode(emergencyCodeLock);
    setEmergencyCodeLock("");
    if (ok) {
      setLocked(false);
      setFailedAttempts(0);
      setLockedUntil(0);
      saveModelsLockout({ count: 0, lockedUntil: 0 });
    } else {
      setLockError("Invalid or already-used emergency code. / الرمز غير صحيح أو استُخدم مسبقاً");
    }
  };

  // ── Status state ──────────────────────────────────────────────────────────
  const [statuses,       setStatuses]       = useState<Record<string, boolean>>({});
  const [tavilyDetails,  setTavilyDetails]  = useState<Record<number, TavilyKeyStatus>>({});
  const [keyCounts,      setKeyCounts]      = useState<Record<string, number>>({});
  const [loading,        setLoading]        = useState(false);
  const [lastChecked,    setLastChecked]    = useState<Date | null>(null);

  const fetchTavilyDetails = useCallback(async () => {
    if (Platform.OS === "web") {
      try {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const r = await fetch(`${origin}/api/tavily-status`);
        if (r.ok) {
          const data = await r.json();
          const map: Record<number, TavilyKeyStatus> = {};
          for (const entry of (data.keys ?? [])) {
            map[entry.index] = entry.status;
          }
          setTavilyDetails(map);
        }
      } catch { /* silent — leave as presence-based */ }
    } else {
      // Native: probe all configured tavily keys dynamically
      const keys: string[] = [
        (apiKeys as any).tavilyApiKey  || "",
        (apiKeys as any).tavilyApiKey2 || "",
        (apiKeys as any).tavilyApiKey3 || "",
      ].filter(Boolean);
      const map: Record<number, TavilyKeyStatus> = {};
      await Promise.all(
        keys.map(async (key, i) => { map[i + 1] = await probeTavilyKeyDirect(key); })
      );
      setTavilyDetails(map);
    }
  }, [apiKeys]);

  const fetchKeyCounts = useCallback(async () => {
    if (Platform.OS === "web") {
      try {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const r = await fetch(`${origin}/api/status`);
        if (r.ok) {
          const d = await r.json();
          setKeyCounts({
            groq:       d.groq_count       ?? 0,
            gemini:     d.gemini_count     ?? 0,
            openrouter: d.openrouter_count ?? 0,
            nvidia:     d.nvidia_count     ?? 0,
            tavily:     d.tavily_count     ?? 0,
            cerebras:   d.cerebras_count   ?? 0,
            emergency:  d.cerebras_count   ?? 0,
          });
        }
      } catch { /* silent */ }
    } else {
      // Native: count non-empty slots in apiKeys (up to 3 per provider via Settings)
      const countNonEmpty = (...keys: string[]) => keys.filter(Boolean).length;
      setKeyCounts({
        groq:       countNonEmpty(apiKeys.groqApiKey, apiKeys.groqApiKey2, apiKeys.groqApiKey3),
        gemini:     countNonEmpty(apiKeys.geminiApiKey, apiKeys.geminiApiKey2, apiKeys.geminiApiKey3),
        openrouter: countNonEmpty(apiKeys.openrouterApiKey),
        nvidia:     countNonEmpty(apiKeys.nvidiaApiKey),
        tavily:     countNonEmpty(apiKeys.tavilyApiKey, apiKeys.tavilyApiKey2, apiKeys.tavilyApiKey3),
        cerebras:   countNonEmpty((apiKeys as any).cerebrasApiKey, (apiKeys as any).cerebrasApiKey2, (apiKeys as any).cerebrasApiKey3),
        emergency:  countNonEmpty((apiKeys as any).cerebrasApiKey, (apiKeys as any).cerebrasApiKey2, (apiKeys as any).cerebrasApiKey3),
      });
    }
  }, [apiKeys]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setTavilyDetails({});
    try {
      const [results] = await Promise.all([
        checkModelStatus(apiKeys),
        fetchTavilyDetails(),
        fetchKeyCounts(),
      ]);
      setStatuses(results);
      setLastChecked(new Date());
    } finally {
      setLoading(false);
    }
  }, [apiKeys, fetchTavilyDetails, fetchKeyCounts]);

  useEffect(() => {
    if (!locked) refresh();
  }, [locked]);

  // ── Summary counts ────────────────────────────────────────────────────────
  const totalOnline  = Object.values(statuses).filter(Boolean).length;
  const totalChecked = Object.keys(statuses).length;
  const isChecked    = totalChecked > 0;

  // ── Lock gate screen ──────────────────────────────────────────────────────
  if (locked) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.lockHeader, {
          backgroundColor: colors.headerBackground,
          borderBottomColor: colors.border,
          paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12),
          paddingHorizontal: 8,
        }]}>
          <View style={{ width: hamburgerOffset + 4 }} />
          <View style={styles.lockHeaderCenter}>
            <View style={[styles.lockHeaderIcon, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="lock" size={18} color={colors.primary} />
            </View>
            <Text style={[styles.lockHeaderTitle, { color: colors.foreground }]}>Model Status</Text>
          </View>
          <View style={{ width: hamburgerOffset + 4 }} />
        </View>

        <View style={styles.lockBody}>
          <View style={[styles.lockIconWrap, { backgroundColor: colors.primary + "18" }]}>
            <Feather name="lock" size={40} color={colors.primary} />
          </View>
          <Text style={[styles.lockTitle, { color: colors.foreground }]}>Model Status Protected</Text>
          <Text style={[styles.lockSubtitle, { color: colors.mutedForeground }]}>
            {Platform.OS !== "web"
              ? "Use fingerprint or enter the Settings password\nاستخدم البصمة أو أدخل كلمة المرور"
              : "Enter the Settings password to view model status\nأدخل كلمة المرور للوصول"}
          </Text>

          <View style={[styles.lockInputRow, { borderColor: colors.border, backgroundColor: colors.card, opacity: lockedUntil > Date.now() ? 0.5 : 1 }]}>
            <Feather name="key" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.lockInput, { color: colors.foreground }]}
              placeholder="Settings password / كلمة المرور"
              placeholderTextColor={colors.mutedForeground}
              value={lockPwd}
              onChangeText={setLockPwd}
              secureTextEntry={!showLockPwd}
              autoCapitalize="none"
              returnKeyType="done"
              editable={lockedUntil <= Date.now()}
              onSubmitEditing={handlePasswordUnlock}
            />
            <TouchableOpacity
              onPress={() => setShowLockPwd(!showLockPwd)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Feather name={showLockPwd ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {lockError ? <Text style={styles.lockError}>{lockError}</Text> : null}

          <TouchableOpacity
            style={[styles.lockBtn, { backgroundColor: colors.primary, opacity: (lockLoading || !lockPwd.trim() || lockedUntil > Date.now()) ? 0.5 : 1 }]}
            onPress={handlePasswordUnlock}
            disabled={lockLoading || !lockPwd.trim() || lockedUntil > Date.now()}
            activeOpacity={0.82}
          >
            <Feather name="unlock" size={16} color="#fff" />
            <Text style={styles.lockBtnText}>{lockLoading ? "Checking…" : "Unlock / فتح"}</Text>
          </TouchableOpacity>

          {Platform.OS !== "web" && (
            <TouchableOpacity
              style={[styles.biometricBtn, { borderColor: colors.border }]}
              onPress={tryBiometric}
              activeOpacity={0.75}
            >
              <Feather name="user" size={16} color={colors.primary} />
              <Text style={[styles.biometricText, { color: colors.primary }]}>
                Use Fingerprint / بصمة الإصبع
              </Text>
            </TouchableOpacity>
          )}

          {/* ── Emergency Code ──────────────────────────────────────────── */}
          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 }}
            onPress={() => { setShowEmergencyOnLock(v => !v); setEmergencyCodeLock(""); setLockError(""); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="shield" size={13} color={colors.mutedForeground} />
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
              {showEmergencyOnLock ? "Hide / إخفاء" : "Use Emergency Code / رمز الطوارئ"}
            </Text>
          </TouchableOpacity>

          {showEmergencyOnLock && (
            <View style={{ width: "100%", gap: 8, marginTop: 2 }}>
              <View style={[styles.lockInputRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="shield" size={16} color={colors.mutedForeground} />
                <TextInput
                  style={[styles.lockInput, { color: colors.foreground, letterSpacing: 3 }]}
                  placeholder="XXXXX-XXXXX"
                  placeholderTextColor={colors.mutedForeground}
                  value={emergencyCodeLock}
                  onChangeText={(v) => setEmergencyCodeLock(v.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleEmergencyUnlock}
                />
              </View>
              <TouchableOpacity
                style={[styles.lockBtn, { backgroundColor: "#475569", opacity: !emergencyCodeLock.trim() ? 0.5 : 1 }]}
                onPress={handleEmergencyUnlock}
                disabled={!emergencyCodeLock.trim()}
                activeOpacity={0.82}
              >
                <Feather name="shield" size={16} color="#fff" />
                <Text style={styles.lockBtnText}>Access with Emergency Code / دخول</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  }

  // ── Main status screen ────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Model Status"
        subtitle={
          loading
            ? "Checking all providers…"
            : lastChecked
            ? `Checked ${lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ·  ${totalOnline}/${totalChecked} online`
            : "Tap refresh to check"
        }
        colors={colors}
        right={
          <TouchableOpacity
            style={[styles.refreshBtn, { backgroundColor: loading ? colors.muted : "#10b98120" }]}
            onPress={refresh}
            disabled={loading}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {loading
              ? <ActivityIndicator size="small" color="#10b981" />
              : <Feather name="refresh-cw" size={18} color="#10b981" />
            }
          </TouchableOpacity>
        }
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 120 }]}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor="#10b981" colors={["#10b981"]} />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Summary card */}
        {isChecked && (
          <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.summaryRow}>
              <StatusDot online={totalOnline > 0} color={totalOnline > 0 ? "#10b981" : "#ef4444"} />
              <Text style={[styles.summaryText, { color: colors.foreground }]}>
                {totalOnline} of {totalChecked} checks online
              </Text>
            </View>
            <View style={styles.summaryLegend}>
              {[
                { color: "#10b981", label: "Online" },
                { color: "#f59e0b", label: "Rate Limited" },
                { color: "#ef4444", label: "Offline / Invalid" },
                { color: "#64748b", label: "Not Set" },
                { color: "#94a3b8", label: "Checking…" },
              ].map(({ color, label }) => (
                <View key={label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: color }]} />
                  <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Safety notice */}
        <View style={[styles.safetyNotice, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="shield" size={13} color={colors.primary} />
          <Text style={[styles.safetyText, { color: colors.mutedForeground }]}>
            Diagnostic view only — no API key values are shown
          </Text>
        </View>

        {/* Provider cards */}
        {PROVIDERS.map(provider => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            statuses={statuses}
            tavilyDetails={tavilyDetails}
            keyCounts={keyCounts}
            checked={isChecked}
            colors={colors}
          />
        ))}

        {/* Routing card */}
        <View style={[styles.routingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.routingTitle, { color: colors.foreground }]}>⚡ How Model Routing Works</Text>
          {[
            { icon: "book",    text: "Simple questions → RAG documents first" },
            { icon: "zap",     text: "Complex / urgent → Groq GPT-OSS 120B (skip RAG)" },
            { icon: "cpu",     text: "If Groq fails → OpenRouter free models" },
            { icon: "eye",     text: "Photos & video → Gemini 2.5 Flash (vision only)" },
            { icon: "monitor", text: "All cloud fail → Local models (home laptop)" },
            { icon: "server",  text: "Last resort → NVIDIA free API" },
            { icon: "search",  text: "Low-confidence answers → Tavily web search" },
          ].map((r, i) => (
            <View key={i} style={styles.routingRow}>
              <Feather name={r.icon as any} size={13} color={colors.primary} />
              <Text style={[styles.routingText, { color: colors.mutedForeground }]}>{r.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },

  // Lock gate
  lockHeader: {
    flexDirection: "row", alignItems: "center",
    paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 56,
  },
  lockHeaderCenter: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  lockHeaderIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  lockHeaderTitle: { fontSize: moderateScale(16), fontWeight: "700", fontFamily: "Inter_700Bold" },
  lockBody: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 18 },
  lockIconWrap: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center" },
  lockTitle: { fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  lockSubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  lockInputRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, width: "100%",
  },
  lockInput: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  lockError: { fontSize: 12, color: "#ef4444", fontFamily: "Inter_400Regular", textAlign: "center" },
  lockBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: "100%",
  },
  lockBtnText: { fontSize: 15, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  biometricBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 1,
  },
  biometricText: { fontSize: 13, fontFamily: "Inter_500Medium" },

  // Main screen
  refreshBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 14, gap: 10 },

  // Summary
  summaryCard: { borderRadius: 14, padding: 14, borderWidth: 1, gap: 10 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryText: { fontSize: moderateScale(13), fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  summaryLegend: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: moderateScale(10), fontFamily: "Inter_400Regular" },

  // Safety notice
  safetyNotice: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8,
  },
  safetyText: { fontSize: moderateScale(11), fontFamily: "Inter_400Regular", flex: 1 },

  // Provider card
  providerCard: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  providerHeader: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  providerIconBox: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  providerTitle: { fontSize: moderateScale(14), fontWeight: "700", fontFamily: "Inter_700Bold" },
  providerPriority: { fontSize: moderateScale(10), fontFamily: "Inter_400Regular", marginTop: 1 },
  providerCount: { fontSize: moderateScale(11), fontWeight: "700", fontFamily: "Inter_700Bold", flexShrink: 0 },

  // Section (keys / models)
  section: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 4 },
  sectionLabel: {
    fontSize: moderateScale(9), fontWeight: "700", fontFamily: "Inter_700Bold",
    textTransform: "uppercase", letterSpacing: 0.8,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4,
  },

  // Key row
  keyRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  keyIconBox: { width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  keyLabel: { flex: 1, fontSize: moderateScale(13), fontFamily: "Inter_500Medium" },

  // Model row
  modelRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modelIconBox: { width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  modelLabel: { flex: 1, fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },

  // Status badge
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 76, justifyContent: "flex-end" },
  statusBadgeText: { fontSize: moderateScale(11), fontWeight: "600", fontFamily: "Inter_600SemiBold" },

  // Routing card
  routingCard: { borderRadius: 14, padding: 14, borderWidth: 1, gap: 8 },
  routingTitle: { fontSize: moderateScale(13), fontWeight: "700", fontFamily: "Inter_700Bold", marginBottom: 4 },
  routingRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  routingText: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular", flex: 1, lineHeight: 18 },
});
