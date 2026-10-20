import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/context/AppContext";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useColors } from "@/hooks/useColors";
import { moderateScale } from "@/hooks/useResponsive";
import { readAsBase64, uploadFileToGemini } from "@/services/geminiUpload";
import { transcribeAudio } from "@/services/aiService";
import {
  ensureMicPermission,
  startNativeRecording,
  stopNativeRecordingToBlob,
} from "@/services/nativeRecording";
import { MentionMenu } from "@/components/MentionMenu";

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCENT = "#ef4444";
const CONTACTS_STORAGE_KEY = "emergency_contacts_v1";

const DEFAULT_CONTACTS = [
  { id: "police",   label: "Police",        labelAr: "الشرطة",         number: "999", icon: "shield"         },
  { id: "ambu",     label: "Ambulance",     labelAr: "الإسعاف",        number: "993", icon: "activity"       },
  { id: "fire",     label: "Fire Brigade",  labelAr: "الإطفاء",        number: "998", icon: "alert-triangle" },
  { id: "civil",    label: "Civil Defense", labelAr: "الدفاع المدني",  number: "998", icon: "alert-octagon"  },
  { id: "emg",      label: "Emergency",     labelAr: "الطوارئ",        number: "911", icon: "phone"          },
];

// ─── Web MediaRecorder (Groq Whisper path) ────────────────────────────────────
let _recorder: MediaRecorder | null = null;
let _chunks: Blob[] = [];

async function startRec(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not available.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  _chunks = [];
  const MR = (typeof MediaRecorder !== "undefined" ? MediaRecorder : null) as any;
  if (!MR) throw new Error("MediaRecorder not supported.");
  const mimeType = MR.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  _recorder = new MR(stream, { mimeType });
  _recorder!.ondataavailable = (e: any) => { if (e.data.size > 0) _chunks.push(e.data); };
  _recorder!.start(200);
}

function stopRec(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!_recorder) { reject(new Error("No recorder")); return; }
    _recorder.onstop = () => {
      resolve(new Blob(_chunks, { type: "audio/webm" }));
      _recorder?.stream.getTracks().forEach((t: any) => t.stop());
    };
    _recorder.stop();
  });
}

// ─── Web Speech API fallback ──────────────────────────────────────────────────
let _recognition: any = null;
let _transcript = "";

function hasBrowserSpeech(): boolean {
  if (typeof window === "undefined") return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

function startWebSpeech(): Promise<void> {
  return new Promise((resolve, reject) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { reject(new Error("Browser speech not supported.")); return; }
    _transcript = "";
    _recognition = new SR();
    _recognition.continuous = true;
    _recognition.interimResults = true;
    _recognition.lang = "";
    _recognition.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      _transcript = t;
    };
    _recognition.onerror = (e: any) => { if (e.error !== "aborted") reject(new Error(`Mic: ${e.error}`)); };
    _recognition.onstart = () => resolve();
    _recognition.start();
  });
}

function stopWebSpeech(): Promise<{ text: string; language: "en" | "ar" }> {
  return new Promise((resolve) => {
    if (!_recognition) { resolve({ text: "", language: "en" }); return; }
    _recognition.onend = () => {
      const text = _transcript.trim();
      const isAr = /[\u0600-\u06FF]/.test(text);
      resolve({ text, language: isAr ? "ar" : "en" });
      _recognition = null;
    };
    _recognition.stop();
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Contact {
  id: string;
  label: string;
  labelAr?: string;
  number: string;
  icon: string;
}

interface PendingMedia {
  uri: string;
  base64?: string;
  mimeType: string;
  mediaType: "image" | "video";
}

interface TurnResponse {
  cerebras?: string;
  cerebrasFallback?: string;
  deepseek?: string;
  deepseekFallback?: string;
  geminiVisual?: string;
  geminiFallback?: string;
  cerebrasLoading: boolean;
  deepseekLoading: boolean;
  geminiLoading: boolean;
  cerebrasError?: string;
  deepseekError?: string;
  geminiError?: string;
}

interface Turn {
  id: string;
  userText: string;
  media?: { uri: string; mediaType: "image" | "video" };
  response: TurnResponse;
  activeTab: "quick" | "deep";
}

// ─── Server base URL ──────────────────────────────────────────────────────────
function getProxyBase(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return (process.env.EXPO_PUBLIC_PROXY_URL ?? "").replace(/\/$/, "");
}

// ─── /api/emergency helper ────────────────────────────────────────────────────
async function callEmergency(
  step: "cerebras" | "deepseek" | "gemini-visual",
  messages: Array<{ role: string; content: string }>,
  opts?: { imageBase64?: string; visionMimeType?: string; geminiFileUri?: string }
): Promise<{ text: string; fallbackProvider?: string }> {
  const res = await fetch(`${getProxyBase()}/api/emergency`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, messages, ...opts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return {
    text: (
    data?.choices?.[0]?.message?.content ??
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    ""
    ).trim(),
    fallbackProvider:
      typeof data?.fallbackProvider === "string" ? data.fallbackProvider : undefined,
  };
}

// ─── Pulsing dot ──────────────────────────────────────────────────────────────
const USE_NATIVE_DRIVER = Platform.OS !== "web";

function PulseDot() {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.5, duration: 700, useNativeDriver: USE_NATIVE_DRIVER }),
        Animated.timing(scale, { toValue: 1.0, duration: 700, useNativeDriver: USE_NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: ACCENT,
      transform: [{ scale }],
      shadowColor: ACCENT, shadowOpacity: 0.8, shadowRadius: 4, elevation: 4,
    }} />
  );
}

// ─── Response Panel ───────────────────────────────────────────────────────────
function ResponsePanel({ turn, colors, onTabChange }: {
  turn: Turn; colors: any;
  onTabChange: (id: string, tab: "quick" | "deep") => void;
}) {
  const hasVisual = !!turn.response.geminiVisual || turn.response.geminiLoading || !!turn.response.geminiError;

  return (
    <View style={[styles.responseCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.tab, turn.activeTab === "quick" && { borderBottomColor: ACCENT, borderBottomWidth: 2 }]}
          onPress={() => onTabChange(turn.id, "quick")}
        >
          <Feather name="zap" size={12} color={turn.activeTab === "quick" ? ACCENT : colors.mutedForeground} />
          <Text style={[styles.tabLabel, { color: turn.activeTab === "quick" ? ACCENT : colors.mutedForeground }]}>
            Quick Response
          </Text>
          {turn.response.cerebrasLoading && <ActivityIndicator size="small" color={ACCENT} style={{ marginLeft: 4 }} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, turn.activeTab === "deep" && { borderBottomColor: "#8b5cf6", borderBottomWidth: 2 }]}
          onPress={() => onTabChange(turn.id, "deep")}
        >
          <Feather name="cpu" size={12} color={turn.activeTab === "deep" ? "#8b5cf6" : colors.mutedForeground} />
          <Text style={[styles.tabLabel, { color: turn.activeTab === "deep" ? "#8b5cf6" : colors.mutedForeground }]}>
            Deep Analysis
          </Text>
          {turn.response.deepseekLoading && <ActivityIndicator size="small" color="#8b5cf6" style={{ marginLeft: 4 }} />}
        </TouchableOpacity>
        {hasVisual && (
          <View style={[styles.tab, { opacity: 0.7 }]}>
            <Feather name="eye" size={12} color="#3b82f6" />
            <Text style={[styles.tabLabel, { color: "#3b82f6" }]}>Visual</Text>
            {turn.response.geminiLoading && <ActivityIndicator size="small" color="#3b82f6" style={{ marginLeft: 4 }} />}
          </View>
        )}
      </View>

      <View style={styles.responseContent}>
        {turn.activeTab === "quick" && (
          <>
            {turn.response.cerebrasLoading && !turn.response.cerebras ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={ACCENT} />
                <Text style={[styles.loadingLabel, { color: colors.mutedForeground }]}>Cerebras GPT-OSS 120B responding…</Text>
              </View>
            ) : turn.response.cerebrasError ? (
              <View style={[styles.errorBox, { backgroundColor: "#ef444415" }]}>
                <Feather name="alert-circle" size={14} color={ACCENT} />
                <Text style={[styles.errorText, { color: ACCENT }]}>{turn.response.cerebrasError}</Text>
              </View>
            ) : (
              <Text style={[styles.responseText, { color: colors.foreground }]}>{turn.response.cerebras || ""}</Text>
            )}
            <Text style={[styles.modelBadge, { color: colors.mutedForeground }]}>
              {turn.response.cerebrasFallback
                ? `${turn.response.cerebrasFallback} · fallback`
                : "Cerebras · GPT-OSS 120B"}
            </Text>
          </>
        )}
        {turn.activeTab === "deep" && (
          <>
            {turn.response.deepseekLoading && !turn.response.deepseek ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8b5cf6" />
                <Text style={[styles.loadingLabel, { color: colors.mutedForeground }]}>DeepSeek R1-0528 analyzing…</Text>
              </View>
            ) : turn.response.deepseekError ? (
              <View style={[styles.errorBox, { backgroundColor: "#8b5cf615" }]}>
                <Feather name="alert-circle" size={14} color="#8b5cf6" />
                <Text style={[styles.errorText, { color: "#8b5cf6" }]}>{turn.response.deepseekError}</Text>
              </View>
            ) : (
              <Text style={[styles.responseText, { color: colors.foreground }]}>{turn.response.deepseek || ""}</Text>
            )}
            <Text style={[styles.modelBadge, { color: colors.mutedForeground }]}>
              {turn.response.deepseekFallback
                ? `${turn.response.deepseekFallback} · fallback`
                : "OpenRouter · DeepSeek R1-0528"}
            </Text>
          </>
        )}
        {hasVisual && (
          <View style={[styles.visualSection, { borderTopColor: colors.border }]}>
            <View style={styles.visualHeader}>
              <Feather name="eye" size={12} color="#3b82f6" />
              <Text style={[styles.visualTitle, { color: "#3b82f6" }]}>
                Visual Analysis · {turn.response.geminiFallback || "Gemini 2.5 Flash"}
              </Text>
            </View>
            {turn.response.geminiLoading && !turn.response.geminiVisual ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#3b82f6" />
                <Text style={[styles.loadingLabel, { color: colors.mutedForeground }]}>Gemini analyzing image…</Text>
              </View>
            ) : turn.response.geminiError ? (
              <View style={[styles.errorBox, { backgroundColor: "#3b82f615" }]}>
                <Feather name="alert-circle" size={14} color="#3b82f6" />
                <Text style={[styles.errorText, { color: "#3b82f6" }]}>{turn.response.geminiError}</Text>
              </View>
            ) : (
              <Text style={[styles.responseText, { color: colors.foreground }]}>{turn.response.geminiVisual || ""}</Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Add Contact Modal ────────────────────────────────────────────────────────
function AddContactModal({ visible, colors, onAdd, onClose }: {
  visible: boolean; colors: any;
  onAdd: (c: Contact) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [number, setNumber] = useState("");

  const handleAdd = () => {
    if (!label.trim() || !number.trim()) return;
    onAdd({ id: Date.now().toString(), label: label.trim(), number: number.trim(), icon: "phone" });
    setLabel(""); setNumber("");
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Add Emergency Contact</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>Contact Name</Text>
          <TextInput
            style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.muted }]}
            placeholder="e.g. Site Safety Officer"
            placeholderTextColor={colors.mutedForeground}
            value={label}
            onChangeText={setLabel}
            autoCapitalize="words"
          />
          <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>Phone Number</Text>
          <TextInput
            style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.muted }]}
            placeholder="e.g. +966 50 123 4567"
            placeholderTextColor={colors.mutedForeground}
            value={number}
            onChangeText={setNumber}
            keyboardType="phone-pad"
          />
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnCancel, { borderColor: colors.border }]}
              onPress={onClose}
            >
              <Text style={[styles.modalBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: ACCENT, opacity: !label.trim() || !number.trim() ? 0.5 : 1 }]}
              onPress={handleAdd}
              disabled={!label.trim() || !number.trim()}
            >
              <Text style={[styles.modalBtnText, { color: "#fff" }]}>Add Contact</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function EmergencyScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { apiKeys } = useApp();

  const scrollRef   = useRef<ScrollView>(null);
  const webFileRef  = useRef<HTMLInputElement | null>(null);

  // ── Contacts state ────────────────────────────────────────────────────────
  const [contacts, setContacts]         = useState<Contact[]>(DEFAULT_CONTACTS);
  const [showAddContact, setShowAddContact] = useState(false);
  const [editMode, setEditMode]         = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(CONTACTS_STORAGE_KEY).then((raw) => {
      if (raw) {
        try { setContacts(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const saveContacts = useCallback((list: Contact[]) => {
    setContacts(list);
    AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(list));
  }, []);

  const handleAddContact = useCallback((c: Contact) => {
    saveContacts([...contacts, c]);
  }, [contacts, saveContacts]);

  const handleDeleteContact = useCallback((id: string) => {
    saveContacts(contacts.filter((c) => c.id !== id));
  }, [contacts, saveContacts]);

  // ── Conversation state ─────────────────────────────────────────────────────
  const [turns, setTurns]         = useState<Turn[]>([]);
  const [input, setInput]         = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null);
  const [isSending, setIsSending] = useState(false);

  // ── @ direct-step state ────────────────────────────────────────────────────
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [directStep, setDirectStep] = useState<"cerebras" | "deepseek" | null>(null);

  // ── Mic/recording state ───────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const useWebSpeech = Platform.OS === "web" && !apiKeys.groqApiKey && hasBrowserSpeech();

  const updateTurn = useCallback((id: string, patch: Partial<TurnResponse>) => {
    setTurns((prev) =>
      prev.map((t) => (t.id === id ? { ...t, response: { ...t.response, ...patch } } : t))
    );
  }, []);

  const handleTabChange = useCallback((id: string, tab: "quick" | "deep") => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, activeTab: tab } : t)));
  }, []);

  // ── Web file input ────────────────────────────────────────────────────────
  const handleWebFileChange = useCallback(async (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    const uri = URL.createObjectURL(file);
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => { resolve((reader.result as string).split(",")[1] || ""); };
      reader.readAsDataURL(file);
    });
    setPendingMedia({ uri, base64, mimeType: file.type, mediaType: isVideo ? "video" : "image" });
    if (webFileRef.current) webFileRef.current.value = "";
  }, []);

  const handleAttach = useCallback(async () => {
    if (Platform.OS === "web") { webFileRef.current?.click(); return; }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        base64: true,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setPendingMedia({
          uri: asset.uri,
          base64: asset.base64 ?? undefined,
          mimeType: asset.mimeType ?? "image/jpeg",
          mediaType: "image",
        });
      }
    } catch {}
  }, []);

  // ── Mic handler ───────────────────────────────────────────────────────────
  const handleMic = useCallback(async () => {
    if (isSending && !isRecording) return;

    if (!isRecording) {
      if (Platform.OS === "web") {
        if (useWebSpeech) {
          try { await startWebSpeech(); setIsRecording(true); } catch {}
        } else {
          try { await startRec(); setIsRecording(true); } catch {}
        }
      } else {
        const ok = await ensureMicPermission();
        if (!ok) return;
        try { await startNativeRecording(); setIsRecording(true); } catch {}
      }
      return;
    }

    // Stop recording and transcribe
    setIsRecording(false);
    setIsTranscribing(true);
    try {
      let text = "";
      if (Platform.OS === "web" && useWebSpeech) {
        const r = await stopWebSpeech();
        text = r.text;
      } else {
        const blob = Platform.OS === "web" ? await stopRec() : await stopNativeRecordingToBlob();
        const r = await transcribeAudio(apiKeys, blob);
        text = r.text;
      }
      if (text.trim()) {
        setInput(text.trim());
      }
    } catch {} finally {
      setIsTranscribing(false);
    }
  }, [isRecording, isSending, useWebSpeech, apiKeys]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && !pendingMedia) return;
    if (isSending) return;

    const capturedDirectStep = directStep;
    const turnId = Date.now().toString();
    const media = pendingMedia
      ? { uri: pendingMedia.uri, mediaType: pendingMedia.mediaType }
      : undefined;
    const capturedMedia = pendingMedia;

    const newTurn: Turn = {
      id: turnId,
      userText: text || "Describe what you see in this image.",
      media,
      response: {
        cerebrasLoading: !capturedDirectStep || capturedDirectStep === "cerebras",
        deepseekLoading: !capturedDirectStep || capturedDirectStep === "deepseek",
        geminiLoading: !!capturedMedia,
      },
      activeTab: capturedDirectStep === "deepseek" ? "deep" : "quick",
    };

    setTurns((prev) => [...prev, newTurn]);
    setInput("");
    setPendingMedia(null);
    setDirectStep(null);
    setIsSending(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    const messages = [{ role: "user", content: newTurn.userText }];
    const tasks: Promise<void>[] = [];

    if (!capturedDirectStep || capturedDirectStep === "cerebras") {
      tasks.push(
        callEmergency("cerebras", messages)
          .then((result) => updateTurn(turnId, {
            cerebras: result.text,
            cerebrasFallback: result.fallbackProvider,
            cerebrasLoading: false,
          }))
          .catch((e) => updateTurn(turnId, { cerebrasError: e?.message || "Failed", cerebrasLoading: false }))
      );
    }

    if (!capturedDirectStep || capturedDirectStep === "deepseek") {
      tasks.push(
        callEmergency("deepseek", messages)
          .then((result) => updateTurn(turnId, {
            deepseek: result.text,
            deepseekFallback: result.fallbackProvider,
            deepseekLoading: false,
          }))
          .catch((e) => updateTurn(turnId, { deepseekError: e?.message || "Failed", deepseekLoading: false }))
      );
    }

    if (capturedMedia) {
      tasks.push(
        (async () => {
          try {
            let imageBase64: string | undefined;
            let geminiFileUri: string | undefined;
            const visionMimeType = capturedMedia.mimeType;

            if (capturedMedia.mediaType === "video") {
              try {
                const up = await uploadFileToGemini(capturedMedia.uri, capturedMedia.mimeType, "emergency-video");
                if (up) geminiFileUri = up;
              } catch {
                if (capturedMedia.base64) imageBase64 = capturedMedia.base64;
                else if (Platform.OS !== "web") imageBase64 = (await readAsBase64(capturedMedia.uri)) ?? undefined;
              }
            } else {
              if (capturedMedia.base64) imageBase64 = capturedMedia.base64;
              else if (Platform.OS !== "web") imageBase64 = (await readAsBase64(capturedMedia.uri)) ?? undefined;
            }

            const gmsg = [{ role: "user", content: newTurn.userText || "What do you see? Any emergency or safety hazard?" }];
            const result = await callEmergency("gemini-visual", gmsg, { imageBase64, visionMimeType, geminiFileUri });
            updateTurn(turnId, {
              geminiVisual: result.text,
              geminiFallback: result.fallbackProvider,
              geminiLoading: false,
            });
          } catch (e: any) {
            updateTurn(turnId, { geminiError: e?.message || "Visual analysis failed", geminiLoading: false });
          }
        })()
      );
    }

    await Promise.allSettled(tasks);
    setIsSending(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [input, pendingMedia, isSending, updateTurn, directStep]);

  const handleClear = useCallback(() => { setTurns([]); setInput(""); setPendingMedia(null); }, []);

  const isBusy = isSending || isRecording || isTranscribing;
  const canSend = (input.trim().length > 0 || !!pendingMedia) && !isSending;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Emergency Response"
        subtitle="استجابة الطوارئ"
        colors={colors}
        right={
          turns.length > 0 ? (
            <TouchableOpacity style={[styles.headerBtn, { borderColor: colors.border }]} onPress={handleClear}>
              <Feather name="trash-2" size={14} color={colors.mutedForeground} />
            </TouchableOpacity>
          ) : undefined
        }
      />

      {/* SOS bar */}
      <View style={[styles.sosBar, { backgroundColor: "#ef444410", borderBottomColor: "#ef444430" }]}>
        <PulseDot />
        <Text style={styles.sosText}>Emergency mode active · الوضع الطارئ مفعّل</Text>
      </View>

      {/* Emergency contacts row */}
      <View style={[styles.contactsWrapper, { borderBottomColor: colors.border }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.contactsContent}
        >
          {contacts.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.chip, { backgroundColor: "#ef444418", borderColor: "#ef444435" }]}
              onPress={() => {
                if (editMode) return;
                Linking.openURL(`tel:${c.number}`).catch(() => {});
              }}
              activeOpacity={0.75}
            >
              <Feather name={c.icon as any} size={11} color={ACCENT} />
              <View style={{ flexShrink: 1 }}>
                <Text style={[styles.chipLabel, { color: ACCENT }]} numberOfLines={1}>{c.label}</Text>
                <Text style={[styles.chipSub, { color: "#ef444490" }]}>{c.number}{c.labelAr ? ` · ${c.labelAr}` : ""}</Text>
              </View>
              {editMode && (
                <TouchableOpacity
                  onPress={() => handleDeleteContact(c.id)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  style={[styles.deleteChip, { backgroundColor: ACCENT }]}
                >
                  <Feather name="x" size={9} color="#fff" />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}

          {/* + Add button */}
          <TouchableOpacity
            style={[styles.chip, styles.chipAdd, { backgroundColor: colors.muted, borderColor: colors.border }]}
            onPress={() => setShowAddContact(true)}
          >
            <Feather name="plus" size={13} color={colors.mutedForeground} />
            <Text style={[styles.chipLabel, { color: colors.mutedForeground }]}>Add</Text>
          </TouchableOpacity>

          {/* Edit/done toggle */}
          <TouchableOpacity
            style={[styles.chip, { backgroundColor: colors.muted, borderColor: colors.border }]}
            onPress={() => setEditMode((v) => !v)}
          >
            <Feather name={editMode ? "check" : "edit-2"} size={11} color={colors.mutedForeground} />
            <Text style={[styles.chipLabel, { color: colors.mutedForeground }]}>{editMode ? "Done" : "Edit"}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* Add contact modal */}
      <AddContactModal
        visible={showAddContact}
        colors={colors}
        onAdd={handleAddContact}
        onClose={() => setShowAddContact(false)}
      />

      {/* Conversation */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {turns.length === 0 && (
            <View style={styles.emptyState}>
              <View style={[styles.emptyIcon, { backgroundColor: "#ef444420" }]}>
                <Feather name="alert-triangle" size={32} color={ACCENT} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Emergency Response</Text>
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                Describe your emergency below or tap the mic to speak. You'll receive an immediate response and a deep analysis.
                Attach a photo or video for visual assessment.
              </Text>
              <Text style={[styles.emptySubtitleAr, { color: colors.mutedForeground }]}>
                صِف حالة الطوارئ أدناه أو انقر على الميكروفون للتحدث.
              </Text>
            </View>
          )}

          {turns.map((turn) => (
            <View key={turn.id} style={styles.turnBlock}>
              <View style={[styles.userBubble, { backgroundColor: "#ef444415", borderColor: "#ef444430" }]}>
                {turn.media && (
                  <View style={styles.mediaThumbnailWrap}>
                    {turn.media.mediaType === "image" ? (
                      <Image source={{ uri: turn.media.uri }} style={styles.mediaThumbnail} resizeMode="cover" />
                    ) : (
                      <View style={[styles.mediaThumbnail, { backgroundColor: "#1e293b", alignItems: "center", justifyContent: "center" }]}>
                        <Feather name="video" size={24} color="#94a3b8" />
                      </View>
                    )}
                  </View>
                )}
                <Text style={[styles.userText, { color: colors.foreground }]}>{turn.userText}</Text>
              </View>
              <ResponsePanel turn={turn} colors={colors} onTabChange={handleTabChange} />
            </View>
          ))}
        </ScrollView>

        {/* Web hidden file input */}
        {Platform.OS === "web" && (
          <input ref={webFileRef} type="file" accept="image/*,video/*"
            style={{ display: "none" }} onChange={handleWebFileChange} />
        )}

        {/* Pending media preview */}
        {pendingMedia && (
          <View style={[styles.pendingBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            {pendingMedia.mediaType === "image" ? (
              <Image source={{ uri: pendingMedia.uri }} style={styles.pendingThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.pendingThumb, { backgroundColor: "#1e293b", alignItems: "center", justifyContent: "center" }]}>
                <Feather name="video" size={16} color="#94a3b8" />
              </View>
            )}
            <Text style={[styles.pendingLabel, { color: colors.mutedForeground }]}>
              {pendingMedia.mediaType === "video" ? "🎥 Video" : "📷 Photo"} attached · Gemini will analyze
            </Text>
            <TouchableOpacity onPress={() => setPendingMedia(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* Transcribing indicator */}
        {isTranscribing && (
          <View style={[styles.transcribingBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <ActivityIndicator size="small" color={ACCENT} />
            <Text style={[styles.transcribingText, { color: colors.mutedForeground }]}>
              Transcribing with Groq Whisper…
            </Text>
          </View>
        )}

        {/* @ mention menu */}
        <MentionMenu
          visible={showMentionMenu}
          type="emergency"
          colors={colors}
          onSelect={(target) => {
            setDirectStep(target.id as "cerebras" | "deepseek");
            setShowMentionMenu(false);
            setInput((prev) => prev.endsWith("@") ? prev.slice(0, -1) : prev);
          }}
          onClose={() => setShowMentionMenu(false)}
        />

        {/* Direct step badge */}
        {directStep && (
          <View style={[styles.targetBadge, { backgroundColor: ACCENT + "15", borderTopColor: colors.border }]}>
            <Feather name="at-sign" size={13} color={ACCENT} />
            <Text style={[styles.targetBadgeText, { color: ACCENT }]}>
              {directStep === "cerebras" ? "Cerebras GPT-OSS 120B" : "DeepSeek R1-0528"}
            </Text>
            <TouchableOpacity onPress={() => setDirectStep(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={13} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* Input bar */}
        <View style={[styles.inputBar, {
          backgroundColor: colors.headerBackground,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom + 8, 12),
        }]}>
          {/* Attach */}
          <TouchableOpacity
            style={[styles.iconBtn, {
              backgroundColor: pendingMedia ? "#ef444420" : colors.muted,
              borderColor: pendingMedia ? "#ef444440" : colors.border,
            }]}
            onPress={handleAttach}
            disabled={isBusy}
          >
            <Feather name="image" size={moderateScale(18)}
              color={pendingMedia ? ACCENT : colors.mutedForeground} />
          </TouchableOpacity>

          {/* Text input */}
          <View style={[styles.inputBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <TextInput
              style={[styles.textInput, { color: colors.foreground, fontSize: moderateScale(14) }]}
              placeholder={
                isRecording ? "🔴 Recording… tap mic to stop" :
                isTranscribing ? "Transcribing…" :
                "Describe the emergency… / صِف الطارئ"
              }
              placeholderTextColor={isRecording ? ACCENT : colors.mutedForeground}
              value={input}
              onChangeText={(text) => {
                setInput(text);
                if (text.endsWith("@")) setShowMentionMenu(true);
              }}
              multiline
              maxLength={2000}
              editable={!isRecording && !isTranscribing}
            />
          </View>

          {/* Mic */}
          <TouchableOpacity
            style={[styles.iconBtn, {
              backgroundColor: isRecording ? ACCENT : colors.muted,
              borderColor: isRecording ? ACCENT : colors.border,
            }]}
            onPress={handleMic}
            disabled={isSending || isTranscribing}
          >
            <Feather
              name={isRecording ? "mic-off" : "mic"}
              size={moderateScale(18)}
              color={isRecording ? "#fff" : colors.mutedForeground}
            />
          </TouchableOpacity>

          {/* Send */}
          <TouchableOpacity
            style={[styles.sendBtn, {
              backgroundColor: canSend ? ACCENT : colors.muted,
              borderColor: canSend ? ACCENT : colors.border,
              opacity: isSending ? 0.7 : 1,
            }]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.8}
          >
            {isSending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="send" size={moderateScale(18)}
                color={canSend ? "#fff" : colors.mutedForeground} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },

  sosBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sosText: { fontSize: moderateScale(11), color: ACCENT, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },

  contactsWrapper: { borderBottomWidth: StyleSheet.hairlineWidth },
  contactsContent: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    alignItems: "center",
  },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, position: "relative",
  },
  chipAdd: { gap: 4 },
  chipLabel: { fontSize: moderateScale(11), fontFamily: "Inter_700Bold", letterSpacing: 0.2 },
  chipSub: { fontSize: moderateScale(9), fontFamily: "Inter_400Regular" },
  deleteChip: {
    position: "absolute", top: -4, right: -4,
    width: 16, height: 16, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },

  scrollContent: { padding: 12, gap: 16, paddingBottom: 24 },

  emptyState: {
    alignItems: "center", justifyContent: "center",
    paddingTop: 40, paddingHorizontal: 24, gap: 12,
  },
  emptyIcon: { width: 80, height: 80, borderRadius: 40, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: moderateScale(20), fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySubtitle: { fontSize: moderateScale(13), fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  emptySubtitleAr: {
    fontSize: moderateScale(12), fontFamily: "Inter_400Regular",
    textAlign: "center", lineHeight: 20, writingDirection: "rtl",
  },

  turnBlock: { gap: 8 },
  userBubble: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  mediaThumbnailWrap: { borderRadius: 8, overflow: "hidden" },
  mediaThumbnail: { width: "100%", height: 180, borderRadius: 8 },
  userText: { fontSize: moderateScale(14), fontFamily: "Inter_400Regular", lineHeight: 22 },

  responseCard: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  tabBar: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 10,
    flex: 1, justifyContent: "center",
  },
  tabLabel: { fontSize: moderateScale(11), fontFamily: "Inter_700Bold", letterSpacing: 0.2 },
  responseContent: { padding: 14, gap: 8 },
  responseText: { fontSize: moderateScale(14), fontFamily: "Inter_400Regular", lineHeight: 22 },
  modelBadge: { fontSize: moderateScale(10), fontFamily: "Inter_400Regular", marginTop: 4 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  loadingLabel: { fontSize: moderateScale(13), fontFamily: "Inter_400Regular" },
  errorBox: { flexDirection: "row", alignItems: "flex-start", gap: 6, padding: 10, borderRadius: 8 },
  errorText: { fontSize: moderateScale(13), fontFamily: "Inter_400Regular", flex: 1, lineHeight: 18 },
  visualSection: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  visualHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  visualTitle: { fontSize: moderateScale(11), fontFamily: "Inter_700Bold", letterSpacing: 0.2 },

  pendingBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 10, borderTopWidth: StyleSheet.hairlineWidth,
  },
  pendingThumb: { width: 40, height: 40, borderRadius: 6 },
  pendingLabel: { flex: 1, fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },

  transcribingBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  transcribingText: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },

  targetBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  targetBadgeText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", gap: 8,
    paddingHorizontal: 10, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: {
    width: moderateScale(40), height: moderateScale(40),
    borderRadius: 12, alignItems: "center", justifyContent: "center",
    borderWidth: 1, flexShrink: 0,
  },
  sendBtn: {
    width: moderateScale(44), height: moderateScale(40),
    borderRadius: 12, alignItems: "center", justifyContent: "center",
    borderWidth: 1, flexShrink: 0,
  },
  inputBox: {
    flex: 1, borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: Platform.OS === "ios" ? 10 : 6,
    minHeight: moderateScale(40), maxHeight: 120,
  },
  textInput: { flex: 1, fontFamily: "Inter_400Regular", lineHeight: 20 },
  headerBtn: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  modalCard: {
    width: "100%", maxWidth: 380,
    borderRadius: 16, borderWidth: 1,
    padding: 20, gap: 10,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  modalTitle: { fontSize: moderateScale(16), fontFamily: "Inter_700Bold" },
  modalLabel: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
  modalInput: {
    borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: moderateScale(14), fontFamily: "Inter_400Regular",
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtn: {
    flex: 1, paddingVertical: 11,
    borderRadius: 10, alignItems: "center", justifyContent: "center",
  },
  modalBtnCancel: { borderWidth: 1 },
  modalBtnText: { fontSize: moderateScale(14), fontFamily: "Inter_700Bold" },
});
