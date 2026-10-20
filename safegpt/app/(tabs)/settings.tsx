import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, SiteRecord } from "@/context/AppContext";
import { checkModelStatus } from "@/services/aiService";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";
import { authenticateWithBiometric, verifySettingsPassword } from "@/services/authService";
import { verifyEmergencyCode, generateEmergencyCodes, getEmergencyCodeCount } from "@/services/emergencyCodeService";

// ─── Settings lock gate: 5 attempts per 15 minutes ───────────────────────────
const SETTINGS_MAX_ATTEMPTS = 5;
const SETTINGS_LOCKOUT_MS   = 15 * 60 * 1000;
const SETTINGS_LOCKOUT_KEY  = "safegpt_settings_lockout";

function readSettingsLockout(): { count: number; lockedUntil: number } {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(SETTINGS_LOCKOUT_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return { count: 0, lockedUntil: 0 };
}

function saveSettingsLockout(data: { count: number; lockedUntil: number }) {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      if (data.count === 0 && data.lockedUntil === 0) {
        localStorage.removeItem(SETTINGS_LOCKOUT_KEY);
      } else {
        localStorage.setItem(SETTINGS_LOCKOUT_KEY, JSON.stringify(data));
      }
    }
  } catch {}
}

export default function SettingsScreen() {
  const {
    apiKeys, updateApiKeys, darkMode, toggleDarkMode, showModelDetails, setShowModelDetails, language, setLanguage,
    projectInfo, updateProjectInfo, sites, addSite, activeSite, setActiveSite,
    logout, reportLayouts, deleteReportLayout,
    isAdmin, userAccounts, registerUserAccount, removeUserAccount,
  } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();

  // ── Settings lock gate (fingerprint / password) ────────────────────────────
  const [settingsLocked, setSettingsLocked] = useState(true);
  const [lockPwd, setLockPwd] = useState("");
  const [lockError, setLockError] = useState("");
  const [lockLoading, setLockLoading] = useState(false);
  const [showLockPwd, setShowLockPwd] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  useEffect(() => {
    // Restore lockout state from storage
    const { count, lockedUntil: until } = readSettingsLockout();
    if (until > Date.now()) {
      setLockedUntil(until);
      setFailedAttempts(count);
    } else if (until > 0) {
      saveSettingsLockout({ count: 0, lockedUntil: 0 });
    }
    // Try biometric automatically on mount (native only; web skips to password)
    tryBiometric();
  }, []);

  const tryBiometric = async () => {
    const result = await authenticateWithBiometric();
    if (result.success) setSettingsLocked(false);
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
      setSettingsLocked(false);
      setLockPwd("");
      setFailedAttempts(0);
      setLockedUntil(0);
      saveSettingsLockout({ count: 0, lockedUntil: 0 });
    } else {
      const newCount = failedAttempts + 1;
      if (newCount >= SETTINGS_MAX_ATTEMPTS) {
        const until = Date.now() + SETTINGS_LOCKOUT_MS;
        setLockedUntil(until);
        setFailedAttempts(0);
        saveSettingsLockout({ count: SETTINGS_MAX_ATTEMPTS, lockedUntil: until });
        setLockError("Too many failed attempts. Settings locked for 15 minutes. / محاولات فاشلة كثيرة. مقفل لمدة 15 دقيقة");
      } else {
        const remaining = SETTINGS_MAX_ATTEMPTS - newCount;
        setFailedAttempts(newCount);
        saveSettingsLockout({ count: newCount, lockedUntil: 0 });
        setLockError(`Incorrect password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining. / كلمة مرور خاطئة. ${remaining} محاولة متبقية`);
      }
      setLockPwd("");
    }
  };

  // Emergency codes — lock gate + management
  const [showEmergencyOnLock, setShowEmergencyOnLock] = useState(false);
  const [emergencyCodeLock, setEmergencyCodeLock] = useState("");
  const [showCodesModal, setShowCodesModal] = useState(false);
  const [generatedCodesDisplay, setGeneratedCodesDisplay] = useState<string[]>([]);
  const [codeCountRemaining, setCodeCountRemaining] = useState(() => getEmergencyCodeCount());

  const handleEmergencyUnlock = async () => {
    const ok = await verifyEmergencyCode(emergencyCodeLock);
    setEmergencyCodeLock("");
    if (ok) {
      setSettingsLocked(false);
      setFailedAttempts(0);
      setLockedUntil(0);
      saveSettingsLockout({ count: 0, lockedUntil: 0 });
      setCodeCountRemaining(getEmergencyCodeCount());
    } else {
      setLockError("Invalid or already-used emergency code. / الرمز غير صحيح أو استُخدم مسبقاً");
    }
  };

  const handleGenerateCodes = async () => {
    const codes = await generateEmergencyCodes();
    setGeneratedCodesDisplay(codes);
    setCodeCountRemaining(codes.length);
    setShowCodesModal(true);
  };

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<Record<string, boolean> | null>(null);
  const [isCheckingModels, setIsCheckingModels] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showAddSite, setShowAddSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteStart, setNewSiteStart] = useState("");
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserPwd, setNewUserPwd] = useState("");
  const [userInviteCode, setUserInviteCode] = useState("");
  const [showDeleteUserConfirm, setShowDeleteUserConfirm] = useState(false);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [saveKeysFeedback, setSaveKeysFeedback] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  // Local draft state for API keys — only committed on "Save"
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>(() => ({ ...apiKeys as any }));
  const [keysSaved, setKeysSaved] = useState(false);

  const handleCheckModels = async () => {
    setIsCheckingModels(true);
    try {
      const status = await checkModelStatus(apiKeys);
      setModelStatus(status);
    } catch (e) {
      Alert.alert("Error", "Failed to check model status.");
    } finally {
      setIsCheckingModels(false);
    }
  };

  const handleAddSite = () => {
    if (!newSiteName.trim()) {
      Alert.alert("Required", "Please enter a site name.");
      return;
    }
    addSite({
      name: newSiteName.trim(),
      dateStarted: newSiteStart.trim() || new Date().toLocaleDateString(),
      dateLeft: "",
      isActive: true,
    });
    setNewSiteName("");
    setNewSiteStart("");
    setShowAddSite(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const MODEL_DISPLAY = [
    { key: "cerebras-gpt-oss-120b", label: "🚨 Emergency: Cerebras GPT-OSS 120B (Primary)" },
    { key: "groq-gpt-oss-120b",     label: "🚨 Emergency: GPT-OSS 120B via Groq (Fallback)" },
    { key: "openrouter-deepseek",   label: "🚨 Emergency: DeepSeek R1-0528 via OpenRouter" },
    { key: "groq-llama-3.3-70b",    label: "Groq Llama 3.3 70B" },
    { key: "groq-llama-3.1-8b",     label: "Groq Llama 3.1 8B" },
    { key: "groq-whisper",           label: "Groq Whisper Large v3 (STT)" },
    { key: "groq-orpheus",           label: "Groq Orpheus TTS (Arabic)" },
    { key: "openrouter-hermes",      label: "OpenRouter: Hermes 3 405B" },
    { key: "openrouter-llama",       label: "OpenRouter: Llama 3.3 70B" },
    { key: "openrouter-qwen3",       label: "OpenRouter: Qwen3 235B Plus" },
    { key: "openrouter-gemini",      label: "OpenRouter: Gemini 2.5 Flash (Vision)" },
    { key: "openrouter-qwen-vl",     label: "OpenRouter: Qwen2.5 VL 72B (Vision)" },
    { key: "gemini-2.5-flash",       label: "Gemini 2.5 Flash (Vision)" },
    { key: "local-llama3.2-vision",  label: "Local: Llama 3.2 Vision" },
    { key: "local-llama3.1-8b",      label: "Local: Llama 3.1 8B" },
    { key: "local-whisper",          label: "Local: Whisper STT" },
    { key: "nvidia-free",            label: "NVIDIA Llama 3.3 70B (Chat)" },
    { key: "web-speech-tts",         label: "Web Speech TTS (Browser)" },
    { key: "puter-tts",              label: "Puter.js TTS (English)" },
    { key: "rag-knowledge-base",     label: "RAG Knowledge Base" },
    { key: "tavily",                  label: "Tavily (Web Search)" },
    { key: "duckduckgo",             label: "DuckDuckGo (Web Search Fallback)" },
  ];

  // ── Lock gate screen ────────────────────────────────────────────────────────
  if (settingsLocked) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border, paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12), paddingHorizontal: 8 }]}>
          <View style={{ width: hamburgerOffset + 4 }} />
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="lock" size={20} color={colors.primary} />
            </View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings / الإعدادات</Text>
          </View>
          <View style={{ width: hamburgerOffset + 4 }} />
        </View>
        <View style={styles.lockBody}>
          <View style={[styles.lockIconWrap, { backgroundColor: colors.primary + "18" }]}>
            <Feather name="lock" size={40} color={colors.primary} />
          </View>
          <Text style={[styles.lockTitle, { color: colors.foreground }]}>Settings Protected</Text>
          <Text style={[styles.lockSubtitle, { color: colors.mutedForeground }]}>
            {Platform.OS !== "web"
              ? "Use fingerprint or enter password\nاستخدم البصمة أو أدخل كلمة المرور"
              : "Enter password to access settings\nأدخل كلمة المرور للوصول إلى الإعدادات"}
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
            <TouchableOpacity onPress={() => setShowLockPwd(!showLockPwd)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
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
            <TouchableOpacity style={[styles.biometricBtn, { borderColor: colors.border }]} onPress={tryBiometric} activeOpacity={0.75}>
              <Feather name="user" size={16} color={colors.primary} />
              <Text style={[styles.biometricText, { color: colors.primary }]}>Use Fingerprint / بصمة الإصبع</Text>
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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            backgroundColor: colors.headerBackground,
            borderBottomColor: colors.border,
            paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12), paddingHorizontal: 8,
          },
        ]}
      >
        <View style={{ width: hamburgerOffset + 4 }} />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
            <Feather name="settings" size={20} color={colors.primary} />
          </View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings / الإعدادات</Text>
        </View>
        <View style={{ width: hamburgerOffset + 4 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        <SettingsSection title="App Preferences / تفضيلات التطبيق" colors={colors}>
          <SettingsRow
            icon="moon"
            label="Dark Mode"
            labelAr="الوضع الليلي"
            colors={colors}
            right={
              <Switch
                value={darkMode}
                onValueChange={() => { toggleDarkMode(); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
            }
          />
          <SettingsRow
            icon="eye"
            label="Show model name and details"
            labelAr="إظهار اسم النموذج وتفاصيله"
            colors={colors}
            right={
              <Switch
                value={showModelDetails}
                onValueChange={(value) => {
                  setShowModelDetails(value);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
                accessibilityLabel="Show model name and details"
              />
            }
          />
          <SettingsRow
            icon="globe"
            label="Language"
            labelAr="اللغة"
            value={language === "en" ? "English" : "العربية"}
            colors={colors}
            onPress={() => setLanguage(language === "en" ? "ar" : "en")}
          />
        </SettingsSection>

        {/* ── Emergency Access Codes ─────────────────────────────────────── */}
        <SettingsSection title="🛡️  Emergency Access Codes / أكواد الطوارئ" colors={colors}>
          <View style={{ gap: 10, padding: 4 }}>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 18 }}>
              {"Generate 8 one-time codes you can use to bypass the password when locked out. Each code works once. Store them somewhere safe — they are shown only once.\n\nأنشئ 8 أكواد للاستخدام مرة واحدة للدخول عند نسيان كلمة المرور. لن تُعرض إلا مرة واحدة."}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.muted, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border }}>
              <Feather name="key" size={15} color={codeCountRemaining > 0 ? colors.success : "#f87171"} />
              <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium", flex: 1 }}>
                {codeCountRemaining > 0
                  ? `${codeCountRemaining} of 8 codes remaining / ${codeCountRemaining} من أصل 8 متبقية`
                  : "No codes available — generate new ones / لا توجد أكواد، أنشئ جديدة"}
              </Text>
            </View>
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#475569", borderRadius: 10, padding: 12, justifyContent: "center" }}
              onPress={handleGenerateCodes}
              activeOpacity={0.82}
            >
              <Feather name="refresh-cw" size={15} color="#fff" />
              <Text style={{ fontSize: 13, color: "#fff", fontFamily: "Inter_600SemiBold" }}>
                {codeCountRemaining > 0 ? "Regenerate Codes (invalidates old ones) / تجديد" : "Generate Emergency Codes / إنشاء أكواد"}
              </Text>
            </TouchableOpacity>
          </View>
        </SettingsSection>

        {/* ── Generated Codes Modal ──────────────────────────────────────── */}
        <Modal visible={showCodesModal} transparent animationType="fade" onRequestClose={() => setShowCodesModal(false)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 }}>
            <View style={{ backgroundColor: colors.card, borderRadius: 16, padding: 24, width: "100%", maxWidth: 400, gap: 16, borderWidth: 1, borderColor: colors.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Feather name="shield" size={22} color={colors.primary} />
                <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.foreground, flex: 1 }}>
                  Emergency Codes / أكواد الطوارئ
                </Text>
              </View>
              <View style={{ backgroundColor: "#fef9c3", borderRadius: 10, padding: 10, flexDirection: "row", gap: 8 }}>
                <Feather name="alert-triangle" size={14} color="#854d0e" style={{ marginTop: 1 }} />
                <Text style={{ fontSize: 12, color: "#854d0e", fontFamily: "Inter_400Regular", flex: 1, lineHeight: 18 }}>
                  {"Save these now — they won't be shown again. Each code can only be used once.\n\nاحفظها الآن — لن تُعرض مجدداً. كل كود للاستخدام مرة واحدة فقط."}
                </Text>
              </View>
              <View style={{ gap: 6 }}>
                {generatedCodesDisplay.map((code, idx) => (
                  <View key={idx} style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.muted, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border }}>
                    <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", width: 18 }}>{idx + 1}.</Text>
                    <Text style={{ flex: 1, fontSize: 15, color: colors.foreground, fontFamily: "Inter_600SemiBold", letterSpacing: 3, textAlign: "center" }}>{code}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={{ backgroundColor: colors.primary, borderRadius: 10, padding: 13, alignItems: "center" }}
                onPress={() => setShowCodesModal(false)}
                activeOpacity={0.85}
              >
                <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 }}>I've saved my codes / حفظت الأكواد</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <SettingsSection title="API Keys / مفاتيح API" colors={colors}>
          {/* Security notice */}
          <View style={[styles.apiSecurityBox, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "30" }]}>
            <Feather name="shield" size={15} color={colors.primary} />
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={[styles.apiSecurityTitle, { color: colors.primary }]}>
                🔒 Maximum Security on Vercel (Recommended)
              </Text>
              <Text style={[styles.apiSecurityDesc, { color: colors.mutedForeground }]}>
                {"For zero key exposure: store your keys in Vercel Dashboard → Settings → Environment Variables (not here), then set EXPO_PUBLIC_USE_SERVER_PROXY=1. All AI calls will route through secure server functions — your keys never reach the browser."}
              </Text>
              <Text style={[styles.apiSecurityDesc, { color: colors.mutedForeground, marginTop: 2 }]}>
                {"Vercel env vars to set: CEREBRAS_API_KEYS · GROQ_API_KEYS · GEMINI_API_KEYS · OPENROUTER_API_KEYS · NVIDIA_API_KEYS · TAVILY_API_KEY (comma-separated for multiple keys)"}
              </Text>
              <Text style={[styles.apiSecurityDesc, { color: colors.mutedForeground, marginTop: 2 }]}>
                {"Keys entered below are stored only on this device. On Vercel, web requests use server-side keys and never forward keys typed here; device-local keys are not shared with Vercel."}
              </Text>
              <Text style={[styles.apiSecurityDesc, { color: colors.mutedForeground, fontStyle: "italic", marginTop: 2 }]}>
                مفاتيح Vercel: مشفّرة على الخادم ولا تظهر للمتصفح أبداً. المفاتيح المُدخلة هنا: محفوظة محلياً على جهازك فقط.
              </Text>
            </View>
          </View>

          {[
            { key: "groqApiKey",         label: "Groq API Key 1 (Chat · STT · Arabic TTS)", placeholder: "gsk_..." },
            { key: "groqApiKey2",        label: "Groq API Key 2 (auto-rotates when Key 1 hits limit)", placeholder: "gsk_..." },
            { key: "groqApiKey3",        label: "Groq API Key 3 (auto-rotates when Key 2 hits limit)", placeholder: "gsk_..." },
            { key: "geminiApiKey",       label: "Gemini API Key 1 (Vision — photos/video/camera)", placeholder: "AIza..." },
            { key: "geminiApiKey2",      label: "Gemini API Key 2 (auto-rotates when Key 1 hits limit)", placeholder: "AIza..." },
            { key: "geminiApiKey3",      label: "Gemini API Key 3 (auto-rotates when Key 2 hits limit)", placeholder: "AIza..." },
            { key: "tavilyApiKey",       label: "Tavily Key 1 (Web Search)", placeholder: "tvly-..." },
            { key: "tavilyApiKey2",      label: "Tavily Key 2 (auto-rotates when Key 1 hits limit)", placeholder: "tvly-..." },
            { key: "tavilyApiKey3",      label: "Tavily Key 3 (auto-rotates when Key 2 hits limit)", placeholder: "tvly-..." },
            { key: "cerebrasApiKey",     label: "Cerebras Key 1 — Emergency ultra-fast model (api.cerebras.ai)", placeholder: "csk-..." },
            { key: "cerebrasApiKey2",    label: "Cerebras Key 2 (auto-rotates when Key 1 hits limit)", placeholder: "csk-..." },
            { key: "cerebrasApiKey3",    label: "Cerebras Key 3 (auto-rotates when Key 2 hits limit)", placeholder: "csk-..." },
            { key: "openrouterApiKey",   label: "OpenRouter API Key (Fallback chat · DeepSeek)", placeholder: "sk-or-..." },
            { key: "nvidiaApiKey",       label: "NVIDIA API Key (Last-resort fallback)", placeholder: "nvapi-..." },
            { key: "nvidiaVisionApiKey", label: "NVIDIA — vision (optional)", placeholder: "nvapi-..." },
            { key: "nvidiaTtsApiKey",    label: "NVIDIA — TTS (optional)", placeholder: "nvapi-..." },
            { key: "nvidiaSttApiKey",    label: "NVIDIA — STT (optional)", placeholder: "nvapi-..." },
          ].map((field) => (
            <View key={field.key} style={styles.apiField}>
              <Text style={[styles.apiFieldLabel, { color: colors.mutedForeground }]}>{field.label}</Text>
              <View style={[styles.apiFieldInput, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.apiInput, { color: colors.foreground }]}
                  placeholder={field.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                  value={draftKeys[field.key] ?? ""}
                  onChangeText={(v) => {
                    setDraftKeys((prev) => ({ ...prev, [field.key]: v }));
                    setKeysSaved(false);
                  }}
                  secureTextEntry={!showApiKeys}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </View>
            </View>
          ))}

          {/* ngrok / Local Ollama — separate, always-masked field */}
          <View style={styles.apiField}>
            <Text style={[styles.apiFieldLabel, { color: colors.mutedForeground }]}>
              {"Local Ollama URL (ngrok) — Dev Only"}
            </Text>
            <Text style={[styles.apiFieldLabel, { color: colors.mutedForeground, fontSize: 10, marginTop: -4, marginBottom: 4, fontStyle: "italic" }]}>
              {"On Vercel: set NGROK_URL env var (server-side) — never enter it here for production"}
            </Text>
            <View style={[styles.apiFieldInput, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <TextInput
                style={[styles.apiInput, { color: colors.foreground }]}
                placeholder="https://xxxx.ngrok-free.app"
                placeholderTextColor={colors.mutedForeground}
                value={draftKeys["ngrokUrl"] ?? ""}
                onChangeText={(v) => {
                  setDraftKeys((prev) => ({ ...prev, ngrokUrl: v }));
                  setKeysSaved(false);
                }}
                secureTextEntry={!showApiKeys}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            </View>
          </View>

          {/* Show/hide toggle + Save button row */}
          <View style={styles.apiActionsRow}>
            <TouchableOpacity
              style={styles.toggleShowKeys}
              onPress={() => setShowApiKeys((v) => !v)}
            >
              <Feather name={showApiKeys ? "eye-off" : "eye"} size={14} color={colors.mutedForeground} />
              <Text style={[styles.toggleShowText, { color: colors.mutedForeground }]}>
                {showApiKeys ? "Hide" : "Show"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveKeysBtn, {
                backgroundColor: keysSaved ? colors.success : colors.primary,
              }]}
              onPress={() => {
                updateApiKeys(draftKeys as any);
                setKeysSaved(true);
                setSaveKeysFeedback(true);
                setTimeout(() => setSaveKeysFeedback(false), 3000);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }}
              activeOpacity={0.85}
            >
              <Feather name={keysSaved ? "check" : "save"} size={14} color="#fff" />
              <Text style={styles.saveKeysBtnText}>
                {keysSaved ? "Saved!" : "Save API Keys"}
              </Text>
            </TouchableOpacity>
            {saveKeysFeedback && (
              <View style={[styles.saveKeysFeedbackBanner, { backgroundColor: colors.success + "18", borderColor: colors.success + "40" }]}>
                <Feather name="check-circle" size={14} color={colors.success} />
                <Text style={[styles.saveKeysFeedbackText, { color: colors.success }]}>
                  Keys saved securely on this device only.
                </Text>
              </View>
            )}
          </View>
        </SettingsSection>

        <SettingsSection title="Site Management / إدارة المواقع" colors={colors}>
          <TouchableOpacity
            style={[styles.addSiteBtn, { borderColor: colors.primary }]}
            onPress={() => setShowAddSite(true)}
            activeOpacity={0.8}
          >
            <Feather name="plus" size={16} color={colors.primary} />
            <Text style={[styles.addSiteText, { color: colors.primary }]}>Add New Site / إضافة موقع جديد</Text>
          </TouchableOpacity>
          {sites.map((site) => (
            <TouchableOpacity
              key={site.id}
              style={[
                styles.siteCard,
                {
                  backgroundColor: activeSite?.id === site.id ? colors.primary + "15" : colors.card,
                  borderColor: activeSite?.id === site.id ? colors.primary : colors.border,
                },
              ]}
              onPress={() => {
                setActiveSite(site.id);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              activeOpacity={0.8}
            >
              <View style={styles.siteInfo}>
                <Feather name="map-pin" size={16} color={activeSite?.id === site.id ? colors.primary : colors.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.siteName, { color: colors.foreground }]}>{site.name}</Text>
                  <Text style={[styles.siteDates, { color: colors.mutedForeground }]}>
                    From {site.dateStarted}{site.dateLeft ? ` to ${site.dateLeft}` : " — Present"}
                  </Text>
                </View>
              </View>
              {activeSite?.id === site.id && (
                <View style={[styles.activeBadge, { backgroundColor: colors.primary }]}>
                  <Text style={styles.activeBadgeText}>Active</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </SettingsSection>

        <SettingsSection title="Model Status / حالة النماذج" colors={colors}>
          <TouchableOpacity
            style={[styles.checkBtn, { backgroundColor: colors.primary, opacity: isCheckingModels ? 0.7 : 1 }]}
            onPress={handleCheckModels}
            disabled={isCheckingModels}
            activeOpacity={0.8}
          >
            <Feather name={isCheckingModels ? "loader" : "activity"} size={16} color="#fff" />
            <Text style={styles.checkBtnText}>
              {isCheckingModels ? "Checking..." : "Check All Models"}
            </Text>
          </TouchableOpacity>

          {modelStatus && MODEL_DISPLAY.map((m) => {
            const isOnline = modelStatus[m.key];
            return (
              <View key={m.key} style={[styles.modelRow, { borderBottomColor: colors.border }]}>
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: isOnline === undefined ? colors.muted : isOnline ? colors.success : colors.destructive },
                  ]}
                />
                <Text style={[styles.modelName, { color: colors.foreground }]}>{m.label}</Text>
                <Text
                  style={[
                    styles.modelStatus,
                    { color: isOnline === undefined ? colors.mutedForeground : isOnline ? colors.success : colors.destructive },
                  ]}
                >
                  {isOnline === undefined ? "—" : isOnline ? "Online" : "Offline"}
                </Text>
              </View>
            );
          })}

          {!modelStatus && (
            <Text style={[styles.modelHint, { color: colors.mutedForeground }]}>
              Press "Check All Models" to see real-time status of all AI services.
            </Text>
          )}
        </SettingsSection>

        <SettingsSection title="Report Layouts / تخطيطات التقارير" colors={colors}>
          {reportLayouts.filter((l) => !l.isBuiltIn).length === 0 ? (
            <Text style={[styles.noCustomLayouts, { color: colors.mutedForeground }]}>
              No custom layouts yet. Built-in layouts are always available in Reports.
            </Text>
          ) : (
            reportLayouts.filter((l) => !l.isBuiltIn).map((layout) => (
              <View key={layout.id} style={[styles.layoutItem, { borderBottomColor: colors.border }]}>
                <Text style={[styles.layoutItemName, { color: colors.foreground }]}>{layout.name}</Text>
                <TouchableOpacity onPress={() => deleteReportLayout(layout.id)}>
                  <Feather name="trash-2" size={16} color={colors.destructive} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </SettingsSection>

        <SettingsSection title="Project Info / معلومات المشروع" colors={colors}>
          {[
            { label: "Company Name", key: "companyName" },
            { label: "Site Name", key: "siteName" },
            { label: "Project Name", key: "projectName" },
            { label: "Start Date", key: "startDate" },
            { label: "Safety Officer", key: "safetyOfficer" },
          ].map((field) => (
            <View key={field.key} style={styles.projectField}>
              <Text style={[styles.projectFieldLabel, { color: colors.mutedForeground }]}>{field.label}</Text>
              <View style={[styles.projectFieldInput, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.projectInput, { color: colors.foreground }]}
                  value={projectInfo ? (projectInfo as any)[field.key] : ""}
                  onChangeText={(v) => {
                    if (projectInfo) updateProjectInfo({ ...projectInfo, [field.key]: v });
                  }}
                  placeholder={`Enter ${field.label.toLowerCase()}`}
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            </View>
          ))}
        </SettingsSection>

        <SettingsSection title="Account / الحساب" colors={colors}>
          <TouchableOpacity
            style={[styles.logoutButton, { borderColor: colors.destructive }]}
            onPress={() => setShowLogoutConfirm(true)}
            activeOpacity={0.8}
          >
            <Feather name="log-out" size={18} color={colors.destructive} />
            <Text style={[styles.logoutText, { color: colors.destructive }]}>Logout / تسجيل الخروج</Text>
          </TouchableOpacity>
        </SettingsSection>

        {isAdmin && (
          <SettingsSection title="👑 Admin — User Management / إدارة المستخدمين" colors={colors}>
            {userAccounts.length === 0 ? (
              <View style={{ padding: 16 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: colors.mutedForeground, textAlign: "center" }}>
                  No additional users yet. Create an invite code to share app access.
                </Text>
              </View>
            ) : (
              userAccounts.map((account) => (
                <View key={account.username} style={[styles.row, { borderBottomColor: colors.border }]}>
                  <View style={[styles.rowIcon, { backgroundColor: colors.primary + "20" }]}>
                    <Feather name="user" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowLabel, { color: colors.foreground }]}>{account.username}</Text>
                    <Text style={[styles.rowLabelAr, { color: colors.mutedForeground }]}>
                      Added {new Date(account.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => { setUserToDelete(account.username); setShowDeleteUserConfirm(true); }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ padding: 6 }}
                  >
                    <Feather name="trash-2" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ))
            )}
            <TouchableOpacity
              style={[styles.addSiteBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
              onPress={() => { setNewUserName(""); setNewUserPwd(""); setUserInviteCode(""); setShowAddUser(true); }}
              activeOpacity={0.7}
            >
              <Feather name="user-plus" size={16} color={colors.primary} />
              <Text style={[styles.addSiteText, { color: colors.primary }]}>Add User / إضافة مستخدم</Text>
            </TouchableOpacity>
          </SettingsSection>
        )}

        <View style={styles.appInfo}>
          <Text style={[styles.appInfoText, { color: colors.mutedForeground }]}>
            SafeGPT v1.0 — Built by Muddaser Abbasi
          </Text>
          <Text style={[styles.appInfoText, { color: colors.mutedForeground }]}>
            All Rights Reserved © 2025
          </Text>
          <Text style={[styles.appInfoEmail, { color: colors.primary }]}>
            muddaserabbasi896@gmail.com
          </Text>
        </View>
      </ScrollView>

      <Modal visible={showAddSite} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Add New Site</Text>
            <TouchableOpacity onPress={() => setShowAddSite(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <View style={styles.modalContent}>
            <View style={styles.modalField}>
              <Text style={[styles.modalLabel, { color: colors.foreground }]}>Site Name (required)</Text>
              <View style={[styles.modalInput, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.modalInputText, { color: colors.foreground }]}
                  placeholder="Enter site name"
                  placeholderTextColor={colors.mutedForeground}
                  value={newSiteName}
                  onChangeText={setNewSiteName}
                />
              </View>
            </View>
            <View style={styles.modalField}>
              <Text style={[styles.modalLabel, { color: colors.foreground }]}>Date Started (optional)</Text>
              <View style={[styles.modalInput, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.modalInputText, { color: colors.foreground }]}
                  placeholder="DD/MM/YYYY"
                  placeholderTextColor={colors.mutedForeground}
                  value={newSiteStart}
                  onChangeText={setNewSiteStart}
                />
              </View>
            </View>
            <TouchableOpacity
              style={[styles.saveButton, { backgroundColor: colors.primary }]}
              onPress={handleAddSite}
              activeOpacity={0.8}
            >
              <Text style={styles.saveButtonText}>Add Site / إضافة موقع</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Logout Confirmation Modal */}
      <Modal visible={showLogoutConfirm} transparent animationType="fade" onRequestClose={() => setShowLogoutConfirm(false)}>
        <View style={styles.logoutOverlay}>
          <View style={[styles.logoutDialog, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.logoutDialogIcon, { backgroundColor: colors.destructive + "18" }]}>
              <Feather name="log-out" size={28} color={colors.destructive} />
            </View>
            <Text style={[styles.logoutDialogTitle, { color: colors.foreground }]}>Logout</Text>
            <Text style={[styles.logoutDialogMessage, { color: colors.mutedForeground }]}>
              Are you sure you want to logout?{"\n"}هل تريد تسجيل الخروج؟
            </Text>
            <View style={styles.logoutDialogBtns}>
              <TouchableOpacity
                style={[styles.logoutDialogCancel, { borderColor: colors.border, backgroundColor: colors.muted }]}
                onPress={() => setShowLogoutConfirm(false)}
                activeOpacity={0.75}
              >
                <Text style={[styles.logoutDialogCancelText, { color: colors.foreground }]}>Cancel / إلغاء</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.logoutDialogConfirm, { backgroundColor: colors.destructive }]}
                onPress={() => {
                  setShowLogoutConfirm(false);
                  logout();
                }}
                activeOpacity={0.8}
              >
                <Feather name="log-out" size={15} color="#fff" />
                <Text style={styles.logoutDialogConfirmText}>Logout</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Delete User Confirmation Modal */}
      <Modal visible={showDeleteUserConfirm} transparent animationType="fade" onRequestClose={() => setShowDeleteUserConfirm(false)}>
        <View style={styles.logoutOverlay}>
          <View style={[styles.logoutDialog, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.logoutDialogIcon, { backgroundColor: colors.destructive + "18" }]}>
              <Feather name="user-x" size={28} color={colors.destructive} />
            </View>
            <Text style={[styles.logoutDialogTitle, { color: colors.foreground }]}>Remove User</Text>
            <Text style={[styles.logoutDialogMessage, { color: colors.mutedForeground }]}>
              Remove account for{"\n"}
              <Text style={{ fontWeight: "700", color: colors.foreground }}>"{userToDelete}"</Text>?{"\n"}
              {"\n"}This cannot be undone. They will not be able to log in.
            </Text>
            <View style={styles.logoutDialogBtns}>
              <TouchableOpacity
                style={[styles.logoutDialogCancel, { borderColor: colors.border, backgroundColor: colors.muted }]}
                onPress={() => { setShowDeleteUserConfirm(false); setUserToDelete(null); }}
                activeOpacity={0.75}
              >
                <Text style={[styles.logoutDialogCancelText, { color: colors.foreground }]}>Cancel / إلغاء</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.logoutDialogConfirm, { backgroundColor: colors.destructive }]}
                onPress={() => {
                  if (userToDelete) removeUserAccount(userToDelete);
                  setShowDeleteUserConfirm(false);
                  setUserToDelete(null);
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }}
                activeOpacity={0.8}
              >
                <Feather name="trash-2" size={15} color="#fff" />
                <Text style={styles.logoutDialogConfirmText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Add User Modal */}
      <Modal visible={showAddUser} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {userInviteCode ? "Invite Code Ready" : "Add New User"}
            </Text>
            <TouchableOpacity onPress={() => { setShowAddUser(false); setUserInviteCode(""); }}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <View style={styles.modalContent}>
            {!userInviteCode ? (
              <>
                <View style={styles.modalField}>
                  <Text style={[styles.modalLabel, { color: colors.foreground }]}>Username</Text>
                  <View style={[styles.modalInput, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TextInput
                      style={[styles.modalInputText, { color: colors.foreground }]}
                      placeholder="Enter username"
                      placeholderTextColor={colors.mutedForeground}
                      value={newUserName}
                      onChangeText={setNewUserName}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>
                <View style={styles.modalField}>
                  <Text style={[styles.modalLabel, { color: colors.foreground }]}>Password</Text>
                  <View style={[styles.modalInput, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TextInput
                      style={[styles.modalInputText, { color: colors.foreground }]}
                      placeholder="Enter password"
                      placeholderTextColor={colors.mutedForeground}
                      value={newUserPwd}
                      onChangeText={setNewUserPwd}
                      secureTextEntry
                      autoCapitalize="none"
                    />
                  </View>
                </View>
                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: colors.primary, opacity: (!newUserName.trim() || !newUserPwd.trim()) ? 0.5 : 1 }]}
                  onPress={async () => {
                    if (!newUserName.trim() || !newUserPwd.trim()) return;
                    const code = await registerUserAccount(newUserName.trim(), newUserPwd.trim());
                    setUserInviteCode(code);
                  }}
                  disabled={!newUserName.trim() || !newUserPwd.trim()}
                  activeOpacity={0.8}
                >
                  <Text style={styles.saveButtonText}>Create Account & Get Invite Code</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: "Inter_500Medium", marginBottom: 12, textAlign: "center" }}>
                  Account created for "{newUserName}". Share this invite code:
                </Text>
                <View style={[styles.modalInput, { backgroundColor: colors.card, borderColor: colors.primary, borderWidth: 2, paddingVertical: 16, marginBottom: 8 }]}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.foreground, textAlign: "center" }} selectable>
                    {userInviteCode}
                  </Text>
                </View>
                <Text style={{ fontSize: 11, color: colors.mutedForeground, textAlign: "center", marginBottom: 16, fontFamily: "Inter_400Regular" }}>
                  User opens the app → taps "Have an Invite Code?" → pastes this code to register their account
                </Text>
                <TouchableOpacity
                  style={[styles.saveButton, { backgroundColor: colors.primary }]}
                  onPress={() => {
                    if (typeof navigator !== "undefined" && navigator.clipboard) {
                      navigator.clipboard.writeText(userInviteCode)
                        .then(() => Alert.alert("Copied!", "Invite code copied to clipboard."))
                        .catch(() => Alert.alert("Invite Code", userInviteCode));
                    } else {
                      Alert.alert("Invite Code", userInviteCode);
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.saveButtonText}>Copy Invite Code</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SettingsSection({ title, children, colors }: { title: string; children: React.ReactNode; colors: any }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.primary }]}>{title}</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {children}
      </View>
    </View>
  );
}

function SettingsRow({ icon, label, labelAr, value, onPress, right, colors }: any) {
  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <View style={[styles.rowIcon, { backgroundColor: colors.muted }]}>
        <Feather name={icon} size={16} color={colors.foreground} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.foreground }]}>{label}</Text>
        {labelAr && <Text style={[styles.rowLabelAr, { color: colors.mutedForeground }]}>{labelAr}</Text>}
      </View>
      {right || (value ? <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>{value}</Text> : <Feather name="chevron-right" size={16} color={colors.mutedForeground} />)}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontWeight: "700", fontFamily: "Inter_700Bold" },
  content: { padding: 16, gap: 16 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", fontFamily: "Inter_700Bold", letterSpacing: 0.5, paddingLeft: 4 },
  sectionCard: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  rowLabelAr: { fontSize: 11, fontFamily: "Inter_400Regular" },
  rowValue: { fontSize: 13, fontFamily: "Inter_400Regular" },
  apiKeysNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  apiNote: { fontSize: 12, fontFamily: "Inter_400Regular" },
  apiField: { paddingHorizontal: 14, paddingVertical: 8, gap: 4 },
  apiFieldLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", fontWeight: "600" },
  apiFieldInput: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  apiInput: { fontSize: 14, fontFamily: "Inter_400Regular" },
  toggleShowKeys: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  toggleShowText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  addSiteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "transparent",
  },
  addSiteText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  siteCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    margin: 6,
    gap: 10,
  },
  siteInfo: { flexDirection: "row", alignItems: "flex-start", gap: 10, flex: 1 },
  siteName: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  siteDates: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  activeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  activeBadgeText: { fontSize: 10, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  checkBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    margin: 14,
    paddingVertical: 12,
    borderRadius: 10,
  },
  checkBtnText: { fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  modelName: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular" },
  modelStatus: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  modelHint: { fontSize: 13, fontFamily: "Inter_400Regular", padding: 14, textAlign: "center" },
  noCustomLayouts: { fontSize: 13, fontFamily: "Inter_400Regular", padding: 14 },
  layoutItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  layoutItemName: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
  projectField: { paddingHorizontal: 14, paddingVertical: 8, gap: 4 },
  projectFieldLabel: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  projectFieldInput: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  projectInput: { fontSize: 14, fontFamily: "Inter_400Regular" },
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    margin: 14,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  logoutText: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  appInfo: { alignItems: "center", gap: 4, paddingVertical: 8 },
  appInfoText: { fontSize: 11, fontFamily: "Inter_400Regular" },
  appInfoEmail: { fontSize: 11, fontFamily: "Inter_500Medium" },
  // API key security box
  apiSecurityBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    marginHorizontal: 14, marginTop: 12, marginBottom: 4,
    borderRadius: 10, borderWidth: 1, padding: 12,
  },
  apiSecurityTitle: { fontSize: 12, fontWeight: "700", fontFamily: "Inter_700Bold", marginBottom: 2 },
  apiSecurityDesc: { fontSize: 11, fontFamily: "Inter_400Regular", lineHeight: 17 },
  // API keys actions row (show/hide + save)
  apiActionsRow: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  saveKeysBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10,
  },
  saveKeysBtnText: { fontSize: 13, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  saveKeysFeedbackBanner: {
    flexDirection: "row", alignItems: "center", gap: 7,
    marginHorizontal: 14, marginBottom: 10, marginTop: 2,
    borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8,
  },
  saveKeysFeedbackText: { fontSize: 12, fontFamily: "Inter_500Medium", flex: 1 },
  modal: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", fontFamily: "Inter_700Bold" },
  modalContent: { padding: 20, gap: 16 },
  modalField: { gap: 6 },
  modalLabel: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  modalInput: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  modalInputText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  saveButton: { borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  saveButtonText: { fontSize: 16, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  // ── Settings lock gate ───────────────────────────────────────────────────────
  lockBody: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingHorizontal: 32, gap: 18,
  },
  lockIconWrap: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: "center", justifyContent: "center",
  },
  lockTitle: { fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  lockSubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  lockInputRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 12,
    width: "100%",
  },
  lockInput: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  lockError: { fontSize: 12, color: "#ef4444", fontFamily: "Inter_400Regular", textAlign: "center" },
  lockBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32,
    width: "100%",
  },
  lockBtnText: { fontSize: 15, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  biometricBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20,
    borderWidth: 1,
  },
  biometricText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  // Logout confirmation modal
  logoutOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 32,
  },
  logoutDialog: {
    width: "100%", borderRadius: 20, borderWidth: 1,
    padding: 24, alignItems: "center", gap: 14,
  },
  logoutDialogIcon: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: "center", justifyContent: "center",
  },
  logoutDialogTitle: { fontSize: 20, fontWeight: "700", fontFamily: "Inter_700Bold" },
  logoutDialogMessage: {
    fontSize: 14, fontFamily: "Inter_400Regular",
    textAlign: "center", lineHeight: 22,
  },
  logoutDialogBtns: { flexDirection: "row", gap: 12, width: "100%", marginTop: 4 },
  logoutDialogCancel: {
    flex: 1, borderRadius: 12, borderWidth: 1,
    paddingVertical: 13, alignItems: "center",
  },
  logoutDialogCancelText: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  logoutDialogConfirm: {
    flex: 1, borderRadius: 12, paddingVertical: 13,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
  },
  logoutDialogConfirmText: { fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
});
