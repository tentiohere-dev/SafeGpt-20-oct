import AsyncStorage from "@react-native-async-storage/async-storage";
import { verifyLogin } from "@/services/authService";
import {
  StoredUserAccount, getStoredUserAccounts,
  createUserAccount as createUserAccountSvc,
  deleteUserAccount as deleteUserAccountSvc,
  verifyAnyUserAccount,
} from "@/services/userAccountService";
import { resolveApiKeys, validateAllKeys } from "@/services/keyManager";
import { configureReliabilityMonitor, startReliabilityMonitor } from "@/services/reliabilityMonitor";
import { extractRagDocumentContent, RagChunk, RAG_INDEX_VERSION } from "@/services/ragService";
import { Platform } from "react-native";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export interface ProjectInfo {
  companyName: string;
  siteName: string;
  projectName: string;
  startDate: string;
  safetyOfficer: string;
  additionalDetails: string;
}

export interface SiteRecord {
  id: string;
  name: string;
  dateStarted: string;
  dateLeft: string;
  isActive: boolean;
}

export interface ApiKeys {
  groqApiKey: string;
  /** Second Groq key — auto-rotates when Key 1 hits rate limit. */
  groqApiKey2: string;
  /** Third Groq key — auto-rotates when Key 2 hits rate limit. */
  groqApiKey3: string;
  openrouterApiKey: string;
  geminiApiKey: string;
  /** Second Gemini key — auto-rotates when Key 1 hits rate limit. */
  geminiApiKey2: string;
  /** Third Gemini key — auto-rotates when Key 2 hits rate limit. */
  geminiApiKey3: string;
  nvidiaApiKey: string;
  /** NVIDIA NIM vision (e.g. Llama 3.2 vision) — for future use; chat uses `nvidiaApiKey`. */
  nvidiaVisionApiKey: string;
  /** NVIDIA TTS (e.g. Magpie) — for future use. */
  nvidiaTtsApiKey: string;
  /** NVIDIA STT (e.g. Whisper) — for future use. */
  nvidiaSttApiKey: string;
  ngrokUrl: string;
  /** Tavily API key for web search (api.tavily.com). */
  tavilyApiKey: string;
  /** Second Tavily key — auto-rotates when Key 1 hits rate limit. */
  tavilyApiKey2: string;
  /** Third Tavily key — auto-rotates when Key 2 hits rate limit. */
  tavilyApiKey3: string;
  /** Cerebras API key 1 — ultra-fast emergency inference (api.cerebras.ai). */
  cerebrasApiKey: string;
  /** Second Cerebras key — auto-rotates when Key 1 hits rate limit. */
  cerebrasApiKey2: string;
  /** Third Cerebras key — auto-rotates when Key 2 hits rate limit. */
  cerebrasApiKey3: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentAr?: string;
  timestamp: number;
  language?: "en" | "ar";
  modelLabel?: string;
  ragSource?: string;
  ttsEngine?: string;
  citationWarning?: string | null;
  violationResults?: import("@/services/violationService").ViolationResult[];
}

export interface AnalyticsRecord {
  id: string;
  type: "incident" | "accident" | "near_miss" | "violation" | "fine" | "other";
  description: string;
  date: string;
  personName?: string;
  location?: string;
  severity?: "low" | "medium" | "high";
}

interface AppContextType {
  isAuthenticated: boolean;
  isFirstLaunch: boolean;
  projectInfo: ProjectInfo | null;
  sites: SiteRecord[];
  activeSite: SiteRecord | null;
  apiKeys: ApiKeys;
  darkMode: boolean;
  showModelDetails: boolean;
  language: "en" | "ar";
  chatHistory: ChatMessage[];
  voiceHistory: ChatMessage[];
  analyticsRecords: AnalyticsRecord[];
  ragDocuments: RagDocument[];
  reportLayouts: ReportLayout[];
  isAdmin: boolean;
  currentUsername: string;
  userAccounts: StoredUserAccount[];
  login: (username: string, password: string) => Promise<boolean>;
  emergencyUnlock: () => void;
  logout: () => Promise<void>;
  registerUserAccount: (username: string, password: string) => Promise<string>;
  removeUserAccount: (username: string) => Promise<void>;
  completeOnboarding: (info: ProjectInfo) => void;
  updateProjectInfo: (info: ProjectInfo) => void;
  addSite: (site: Omit<SiteRecord, "id">) => void;
  updateSite: (id: string, site: Partial<SiteRecord>) => void;
  setActiveSite: (id: string) => void;
  updateApiKeys: (keys: Partial<ApiKeys>) => void;
  toggleDarkMode: () => void;
  setShowModelDetails: (show: boolean) => void;
  setLanguage: (lang: "en" | "ar") => void;
  addChatMessage: (msg: Omit<ChatMessage, "id" | "timestamp">) => void;
  clearChatHistory: () => void;
  addVoiceMessage: (msg: Omit<ChatMessage, "id" | "timestamp">) => void;
  clearVoiceHistory: () => void;
  addAnalyticsRecord: (record: Omit<AnalyticsRecord, "id">) => void;
  deleteAnalyticsRecord: (id: string) => void;
  addRagDocument: (doc: Omit<RagDocument, "id" | "addedAt">) => void;
  deleteRagDocument: (id: string) => void;
  addReportLayout: (layout: Omit<ReportLayout, "id" | "addedAt">) => void;
  deleteReportLayout: (id: string) => void;
}

export interface RagDocument {
  id: string;
  name: string;
  type: string;
  size: number;
  uri: string;
  addedAt: number;
  indexed: boolean;
  content?: string;
  chunks?: RagChunk[];
  indexVersion?: number;
}

export interface ReportLayout {
  id: string;
  name: string;
  type: string;
  uri?: string;
  isBuiltIn: boolean;
  addedAt: number;
}

const BUILT_IN_LAYOUTS: ReportLayout[] = [
  { id: "incident",             name: "Incident Report",                      type: "incident",             isBuiltIn: true, addedAt: 0 },
  { id: "near_miss",            name: "Near Miss Report",                     type: "near_miss",            isBuiltIn: true, addedAt: 0 },
  { id: "accident",             name: "Accident Report",                      type: "accident",             isBuiltIn: true, addedAt: 0 },
  { id: "first_aid",            name: "First Aid / Medical Treatment Report", type: "first_aid",            isBuiltIn: true, addedAt: 0 },
  { id: "property_damage",      name: "Property Damage Report",               type: "property_damage",      isBuiltIn: true, addedAt: 0 },
  { id: "environmental",        name: "Environmental Incident Report",        type: "environmental",        isBuiltIn: true, addedAt: 0 },
  { id: "unsafe_condition",     name: "Unsafe Condition Report",              type: "unsafe_condition",     isBuiltIn: true, addedAt: 0 },
  { id: "unsafe_act",           name: "Unsafe Act Report",                    type: "unsafe_act",           isBuiltIn: true, addedAt: 0 },
  { id: "safety_observation",   name: "Safety Observation Report",            type: "safety_observation",   isBuiltIn: true, addedAt: 0 },
  { id: "vehicle_equipment",    name: "Vehicle / Equipment Incident Report",  type: "vehicle_equipment",    isBuiltIn: true, addedAt: 0 },
  { id: "fire_incident",        name: "Fire Incident Report",                 type: "fire_incident",        isBuiltIn: true, addedAt: 0 },
  { id: "security_incident",    name: "Security Incident Report",             type: "security_incident",    isBuiltIn: true, addedAt: 0 },
  { id: "occupational_illness", name: "Occupational Illness Report",          type: "occupational_illness", isBuiltIn: true, addedAt: 0 },
  { id: "emergency_event",      name: "Emergency Event Report",               type: "emergency_event",      isBuiltIn: true, addedAt: 0 },
];

const DEFAULT_API_KEYS: ApiKeys = resolveApiKeys(null);

export const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isFirstLaunch, setIsFirstLaunch] = useState(true);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [activeSite, setActiveSiteState] = useState<SiteRecord | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeys>(DEFAULT_API_KEYS);
  const [darkMode, setDarkMode] = useState(true);
  const [showModelDetails, setShowModelDetailsState] = useState(true);
  const [language, setLanguageState] = useState<"en" | "ar">("en");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [voiceHistory, setVoiceHistory] = useState<ChatMessage[]>([]);
  const [analyticsRecords, setAnalyticsRecords] = useState<AnalyticsRecord[]>([]);
  const [ragDocuments, setRagDocuments] = useState<RagDocument[]>([]);
  const [reportLayouts, setReportLayouts] = useState<ReportLayout[]>(BUILT_IN_LAYOUTS);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUsername, setCurrentUsername] = useState("");
  const [userAccounts, setUserAccounts] = useState<StoredUserAccount[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // ── Silent startup key validation ─────────────────────────────────────────
  // Runs once after app data is loaded. Logs a per-provider report (no key
  // values are ever logged). Failures are non-fatal — model status row in
  // Settings is still the source of truth.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    validateAllKeys(apiKeys)
      .then((report) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.log("[SafeGPT] Key validation:", report);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // ── Reliability monitor (automatic recovery) ───────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    configureReliabilityMonitor(() => apiKeys);
    startReliabilityMonitor();
  }, [loaded, apiKeys]);

  const loadData = async () => {
    try {
      const [
        authData, firstLaunchData, projectData, sitesData, activeSiteData,
        apiKeysData, darkModeData, showModelDetailsData, langData, chatData, voiceData,
        analyticsData, ragData, layoutsData,
      ] = await Promise.all([
        Platform.OS === "web" ? Promise.resolve(null) : AsyncStorage.getItem("isAuthenticated"),
        AsyncStorage.getItem("isFirstLaunch"),
        AsyncStorage.getItem("projectInfo"),
        AsyncStorage.getItem("sites"),
        AsyncStorage.getItem("activeSite"),
        AsyncStorage.getItem("apiKeys"),
        AsyncStorage.getItem("darkMode"),
        AsyncStorage.getItem("showModelDetails"),
        AsyncStorage.getItem("language"),
        AsyncStorage.getItem("chatHistory"),
        AsyncStorage.getItem("voiceHistory"),
        AsyncStorage.getItem("analyticsRecords"),
        AsyncStorage.getItem("ragDocuments"),
        AsyncStorage.getItem("reportLayouts"),
      ]);

      if (Platform.OS === "web") {
        try {
          const response = await fetch("/api/session", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
          });
          const session = await response.json().catch(() => ({}));
          const authenticated =
            response.ok &&
            session?.authenticated === true &&
            typeof session?.username === "string";
          setIsAuthenticated(authenticated);
          setIsAdmin(authenticated);
          setCurrentUsername(authenticated ? session.username : "");
          if (!authenticated) await AsyncStorage.setItem("isAuthenticated", JSON.stringify(false));
        } catch {
          setIsAuthenticated(false);
          setIsAdmin(false);
          setCurrentUsername("");
          await AsyncStorage.setItem("isAuthenticated", JSON.stringify(false));
        }
      } else if (authData) {
        setIsAuthenticated(JSON.parse(authData));
      }
      if (firstLaunchData !== null) setIsFirstLaunch(JSON.parse(firstLaunchData));
      if (projectData) setProjectInfo(JSON.parse(projectData));
      if (sitesData) setSites(JSON.parse(sitesData));
      if (activeSiteData) setActiveSiteState(JSON.parse(activeSiteData));
      if (apiKeysData) {
        try {
          setApiKeys(resolveApiKeys(JSON.parse(apiKeysData)));
        } catch {
          setApiKeys(DEFAULT_API_KEYS);
        }
      } else {
        setApiKeys(DEFAULT_API_KEYS);
      }
      if (darkModeData) setDarkMode(JSON.parse(darkModeData));
      if (showModelDetailsData !== null) setShowModelDetailsState(JSON.parse(showModelDetailsData));
      if (langData) setLanguageState(JSON.parse(langData));
      if (chatData) setChatHistory(JSON.parse(chatData));
      if (voiceData) setVoiceHistory(JSON.parse(voiceData));
      if (analyticsData) setAnalyticsRecords(JSON.parse(analyticsData));
      if (ragData) {
        const docs: RagDocument[] = JSON.parse(ragData);
        setRagDocuments(docs);
        const needsReindex = docs.some((doc) => doc.uri && (doc.indexVersion !== RAG_INDEX_VERSION || !doc.chunks?.length || !doc.content || doc.content.includes("This document has been added to your SafeGPT knowledge base")));
        if (needsReindex) {
          Promise.all(
            docs.map(async (doc) => {
              if (!doc.uri || (doc.indexVersion === RAG_INDEX_VERSION && doc.chunks?.length && doc.content && !doc.content.includes("This document has been added to your SafeGPT knowledge base"))) return doc;
              const extracted = await extractRagDocumentContent({
                name: doc.name,
                mimeType: doc.type,
                size: doc.size,
                uri: doc.uri,
              });
              return { ...doc, indexed: extracted.indexed, content: extracted.content, chunks: extracted.chunks, indexVersion: RAG_INDEX_VERSION };
            })
          ).then((updated) => {
            setRagDocuments(updated);
            AsyncStorage.setItem("ragDocuments", JSON.stringify(updated));
          }).catch(() => {});
        }
      }
      if (layoutsData) {
        const custom = JSON.parse(layoutsData).filter((l: ReportLayout) => !l.isBuiltIn);
        setReportLayouts([...BUILT_IN_LAYOUTS, ...custom]);
      }
      const accounts = await getStoredUserAccounts();
      setUserAccounts(accounts);
    } catch (e) {
      console.error("Error loading data", e);
    } finally {
      setLoaded(true);
    }
  };

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    if (Platform.OS === "web") {
      let response: Response;
      try {
        response = await fetch("/api/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
      } catch {
        throw new Error("Could not reach the sign-in service. Check your connection and try again.");
      }
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) return false;
      if (!response.ok) {
        throw new Error(result?.error || "Sign-in failed. Try again.");
      }
      if (result?.authenticated !== true || typeof result?.username !== "string") return false;
      setIsAuthenticated(true);
      setIsAdmin(true);
      setCurrentUsername(result.username);
      await AsyncStorage.setItem("isAuthenticated", JSON.stringify(false));
      return true;
    }

    // Admin credentials
    const adminValid = await verifyLogin(username, password);
    if (adminValid) {
      setIsAuthenticated(true);
      setIsAdmin(true);
      setCurrentUsername(username.trim());
      AsyncStorage.setItem("isAuthenticated", JSON.stringify(true));
      return true;
    }
    // Stored user accounts
    const userValid = await verifyAnyUserAccount(username, password);
    if (userValid) {
      setIsAuthenticated(true);
      setIsAdmin(false);
      setCurrentUsername(username.trim());
      AsyncStorage.setItem("isAuthenticated", JSON.stringify(true));
      return true;
    }
    return false;
  }, []);

  const emergencyUnlock = useCallback(() => {
    if (Platform.OS === "web") return;
    setIsAuthenticated(true);
    setIsAdmin(true);
    setCurrentUsername("Admin");
    AsyncStorage.setItem("isAuthenticated", JSON.stringify(true));
  }, []);

  const logout = useCallback(async () => {
    if (Platform.OS === "web") {
      try {
        await fetch("/api/session", {
          method: "DELETE",
          credentials: "same-origin",
        });
      } catch {
        // Clear the local view even if the remote logout request cannot complete.
      }
    }
    setIsAuthenticated(false);
    setIsAdmin(false);
    setCurrentUsername("");
    AsyncStorage.setItem("isAuthenticated", JSON.stringify(false));
  }, []);

  const completeOnboarding = useCallback((info: ProjectInfo) => {
    setProjectInfo(info);
    setIsFirstLaunch(false);
    AsyncStorage.setItem("projectInfo", JSON.stringify(info));
    AsyncStorage.setItem("isFirstLaunch", JSON.stringify(false));
  }, []);

  const updateProjectInfo = useCallback((info: ProjectInfo) => {
    setProjectInfo(info);
    AsyncStorage.setItem("projectInfo", JSON.stringify(info));
  }, []);

  const addSite = useCallback((site: Omit<SiteRecord, "id">) => {
    const newSite: SiteRecord = {
      ...site,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    };
    setSites((prev) => {
      const updated = [...prev, newSite];
      AsyncStorage.setItem("sites", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const updateSite = useCallback((id: string, updates: Partial<SiteRecord>) => {
    setSites((prev) => {
      const updated = prev.map((s) => (s.id === id ? { ...s, ...updates } : s));
      AsyncStorage.setItem("sites", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const setActiveSite = useCallback((id: string) => {
    setSites((prev) => {
      const site = prev.find((s) => s.id === id) || null;
      setActiveSiteState(site);
      AsyncStorage.setItem("activeSite", JSON.stringify(site));
      return prev;
    });
  }, []);

  const updateApiKeys = useCallback((keys: Partial<ApiKeys>) => {
    setApiKeys((prev) => {
      const rawNext: any = { ...prev, ...keys };
      AsyncStorage.setItem("apiKeys", JSON.stringify(rawNext));
      return resolveApiKeys(rawNext);
    });
  }, []);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const updated = !prev;
      AsyncStorage.setItem("darkMode", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const setShowModelDetails = useCallback((show: boolean) => {
    setShowModelDetailsState(show);
    AsyncStorage.setItem("showModelDetails", JSON.stringify(show));
  }, []);

  const setLanguage = useCallback((lang: "en" | "ar") => {
    setLanguageState(lang);
    AsyncStorage.setItem("language", JSON.stringify(lang));
  }, []);

  const addChatMessage = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    const newMsg: ChatMessage = {
      ...msg,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      timestamp: Date.now(),
    };
    setChatHistory((prev) => {
      const updated = [...prev, newMsg];
      AsyncStorage.setItem("chatHistory", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearChatHistory = useCallback(() => {
    setChatHistory([]);
    AsyncStorage.setItem("chatHistory", JSON.stringify([]));
  }, []);

  const addVoiceMessage = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    const newMsg: ChatMessage = {
      ...msg,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      timestamp: Date.now(),
    };
    setVoiceHistory((prev) => {
      const updated = [...prev, newMsg];
      AsyncStorage.setItem("voiceHistory", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearVoiceHistory = useCallback(() => {
    setVoiceHistory([]);
    AsyncStorage.setItem("voiceHistory", JSON.stringify([]));
  }, []);

  const addAnalyticsRecord = useCallback((record: Omit<AnalyticsRecord, "id">) => {
    const newRecord: AnalyticsRecord = {
      ...record,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    };
    setAnalyticsRecords((prev) => {
      const updated = [...prev, newRecord];
      AsyncStorage.setItem("analyticsRecords", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const deleteAnalyticsRecord = useCallback((id: string) => {
    setAnalyticsRecords((prev) => {
      const updated = prev.filter((r) => r.id !== id);
      AsyncStorage.setItem("analyticsRecords", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addRagDocument = useCallback((doc: Omit<RagDocument, "id" | "addedAt">) => {
    const newDoc: RagDocument = {
      ...doc,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      addedAt: Date.now(),
    };
    setRagDocuments((prev) => {
      const updated = [...prev, newDoc];
      AsyncStorage.setItem("ragDocuments", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const deleteRagDocument = useCallback((id: string) => {
    setRagDocuments((prev) => {
      const updated = prev.filter((d) => d.id !== id);
      AsyncStorage.setItem("ragDocuments", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addReportLayout = useCallback((layout: Omit<ReportLayout, "id" | "addedAt">) => {
    const newLayout: ReportLayout = {
      ...layout,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      addedAt: Date.now(),
    };
    setReportLayouts((prev) => {
      const updated = [...prev, newLayout];
      const custom = updated.filter((l) => !l.isBuiltIn);
      AsyncStorage.setItem("reportLayouts", JSON.stringify(custom));
      return updated;
    });
  }, []);

  const deleteReportLayout = useCallback((id: string) => {
    setReportLayouts((prev) => {
      const updated = prev.filter((l) => l.id !== id);
      const custom = updated.filter((l) => !l.isBuiltIn);
      AsyncStorage.setItem("reportLayouts", JSON.stringify(custom));
      return updated;
    });
  }, []);

  const registerUserAccount = useCallback(async (username: string, password: string): Promise<string> => {
    const code = await createUserAccountSvc(username, password);
    const updated = await getStoredUserAccounts();
    setUserAccounts(updated);
    return code;
  }, []);

  const removeUserAccount = useCallback(async (username: string): Promise<void> => {
    await deleteUserAccountSvc(username);
    setUserAccounts((prev) => prev.filter((a) => a.username.toLowerCase() !== username.toLowerCase()));
  }, []);

  if (!loaded) return null;

  return (
    <AppContext.Provider
      value={{
        isAuthenticated,
        isAdmin,
        currentUsername,
        userAccounts,
        isFirstLaunch,
        projectInfo,
        sites,
        activeSite,
        apiKeys,
        darkMode,
        showModelDetails,
        language,
        chatHistory,
        voiceHistory,
        analyticsRecords,
        ragDocuments,
        reportLayouts,
        login,
        emergencyUnlock,
        logout,
        completeOnboarding,
        updateProjectInfo,
        addSite,
        updateSite,
        setActiveSite,
        updateApiKeys,
        toggleDarkMode,
        setShowModelDetails,
        setLanguage,
        addChatMessage,
        clearChatHistory,
        addVoiceMessage,
        clearVoiceHistory,
        addAnalyticsRecord,
        deleteAnalyticsRecord,
        addRagDocument,
        deleteRagDocument,
        addReportLayout,
        deleteReportLayout,
        registerUserAccount,
        removeUserAccount,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
