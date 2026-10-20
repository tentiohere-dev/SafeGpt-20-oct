import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Platform, StyleSheet,
  Text, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, ChatMessage } from "@/context/AppContext";
import { callAI, transcribeAudio, speakText, stopSpeech, detectLanguage, getLastTtsEngine } from "@/services/aiService";
import { ensureMicPermission, startNativeRecording, stopNativeRecordingToBlob } from "@/services/nativeRecording";
import { SpeakerButton } from "@/components/SpeakerButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useColors } from "@/hooks/useColors";
import { moderateScale } from "@/hooks/useResponsive";

// ─── Web MediaRecorder (Groq Whisper path) ────────────────────────────────────
let _recorder: MediaRecorder | null = null;
let _chunks: Blob[] = [];

async function startRec(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not available. Ensure the page is served over HTTPS.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  _chunks = [];
  const MR = (typeof MediaRecorder !== "undefined" ? MediaRecorder : null) as any;
  if (!MR) throw new Error("MediaRecorder not supported in this browser.");
  const mimeType = MR.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  _recorder = new MR(stream, { mimeType });
  _recorder!.ondataavailable = (e: any) => { if (e.data.size > 0) _chunks.push(e.data); };
  _recorder!.start(200);
}

function stopRec(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!_recorder) { reject(new Error("No recorder")); return; }
    _recorder.onstop = () => {
      resolve(new Blob(_chunks, { type: "audio/webm" }));
      _recorder?.stream.getTracks().forEach(t => t.stop());
    };
    _recorder.stop();
  });
}

// ─── Web Speech API (free browser STT — no API key needed) ───────────────────
let _recognition: any = null;
let _wsTranscript = "";

function hasBrowserSpeech(): boolean {
  if (typeof window === "undefined") return false;
  return !!(
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition
  );
}

function startWebSpeech(): Promise<void> {
  return new Promise((resolve, reject) => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      reject(new Error("Browser speech recognition not supported. Add a Groq API key in Settings → API Keys for best results."));
      return;
    }
    _wsTranscript = "";
    _recognition = new SR();
    _recognition.continuous = true;
    _recognition.interimResults = true;
    _recognition.lang = "";
    _recognition.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      _wsTranscript = t;
    };
    _recognition.onerror = (e: any) => {
      if (e.error !== "aborted") reject(new Error(`Mic error: ${e.error}`));
    };
    _recognition.onstart = () => resolve();
    _recognition.start();
  });
}

function stopWebSpeech(): Promise<{ text: string; language: "en" | "ar" }> {
  return new Promise((resolve) => {
    if (!_recognition) { resolve({ text: "", language: "en" }); return; }
    _recognition.onend = () => {
      const text = _wsTranscript.trim();
      const isAr = /[\u0600-\u06FF]/.test(text);
      resolve({ text, language: isAr ? "ar" : "en" });
      _recognition = null;
    };
    _recognition.stop();
  });
}

function parseBilingual(content: string): { ar: string | null; en: string } {
  const i = content.indexOf("---EN---");
  if (i === -1) {
    const match = content.match(/^\s*(?:Arabic|العربية)\s*:?\s*\n([\s\S]*?)\n\s*(?:English|EN)\s*:?\s*\n([\s\S]*)$/i);
    if (match) return { ar: match[1].trim(), en: match[2].trim() };
    return { ar: null, en: content };
  }
  return { ar: content.slice(0, i).trim(), en: content.slice(i + 8).trim() };
}

export default function VoiceScreen() {
  const { voiceHistory, addVoiceMessage, clearVoiceHistory, apiKeys, ragDocuments } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Tap microphone to speak");
  const [statusAr, setStatusAr] = useState("اضغط على الميكروفون للتحدث");

  const setStatuses = (en: string, ar: string) => { setStatus(en); setStatusAr(ar); };

  // True when on web with no Groq key → use free browser Speech Recognition
  const useWebSpeech = Platform.OS === "web" && !apiKeys.groqApiKey && hasBrowserSpeech();

  const handleVoicePress = useCallback(async () => {
    if (isProcessing) return;

    if (!isRecording) {
      if (Platform.OS === "web") {
        if (useWebSpeech) {
          // ── Free browser Speech Recognition (no API key needed) ──────────
          try {
            await startWebSpeech();
            setIsRecording(true);
            setStatuses("🔴 Listening... tap again to stop", "🔴 يستمع... اضغط مرة أخرى للإيقاف");
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          } catch (e: any) {
            setStatuses(e.message || "Microphone error.", "خطأ في الميكروفون.");
          }
        } else {
          // ── Groq Whisper path ─────────────────────────────────────────────
          try {
            await startRec();
            setIsRecording(true);
            setStatuses("🔴 Listening... tap again to stop", "🔴 يستمع... اضغط مرة أخرى للإيقاف");
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          } catch {
            setStatuses("Microphone denied. Allow mic in browser settings.", "الميكروفون محجوب. السماح في إعدادات المتصفح.");
          }
        }
      } else {
        const ok = await ensureMicPermission();
        if (!ok) {
          setStatuses("Microphone denied. Enable in Settings.", "الميكروفون محجوب. فعّله من الإعدادات.");
          return;
        }
        try {
          await startNativeRecording();
          setIsRecording(true);
          setStatuses("🔴 Listening... tap again to stop", "🔴 يستمع... اضغط مرة أخرى للإيقاف");
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        } catch {
          setStatuses("Could not start recording.", "تعذر بدء التسجيل.");
        }
      }
      return;
    }

    setIsRecording(false);
    setIsProcessing(true);
    setStatuses("⚙️ Transcribing your speech...", "⚙️ جاري تحويل الكلام إلى نص...");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      let text: string;
      let lang: "en" | "ar";

      if (Platform.OS === "web" && useWebSpeech) {
        // ── Browser Speech Recognition result ────────────────────────────
        const result = await stopWebSpeech();
        text = result.text;
        lang = result.language;
      } else {
        // ── Groq Whisper result ───────────────────────────────────────────
        const blob =
          Platform.OS === "web" ? await stopRec() : await stopNativeRecordingToBlob();
        const result = await transcribeAudio(apiKeys, blob);
        text = result.text;
        lang = result.language;
      }

      if (!text.trim()) {
        setStatuses("No speech detected. Tap mic to try again.", "لم يُكشف عن كلام. اضغط مجدداً.");
        setIsProcessing(false);
        return;
      }

      // For Arabic speech: show the transcription, and ask AI for a bilingual answer
      addVoiceMessage({ role: "user", content: text, language: lang });

      setStatuses("🤔 SafeGPT is thinking...", "🤔 يفكر SafeGPT...");

      const history = voiceHistory.slice(-8).map(m => ({ role: m.role, content: m.content }));

      // If Arabic: prefix instruction to ensure bilingual answer
      const queryText = lang === "ar"
        ? `[The user spoke in Arabic. Provide a BILINGUAL response with Arabic first, then English. Use clean language headings and numbered points.]\n\n${text}`
        : text;

      const { content, model, ragUsed, ragSource } = await callAI(apiKeys, queryText, history, undefined, ragDocuments);

      // Auto-play BEFORE saving message so TTS engine is captured
      const { ar, en } = parseBilingual(content);
      const speakLang = lang === "ar" && ar ? "ar" : "en";
      const speakContent = speakLang === "ar" ? ar! : en;
      speakText(speakContent, speakLang, apiKeys.groqApiKey, null, apiKeys.groqApiKey2);

      // Small delay to let TTS engine name get recorded
      await new Promise<void>((r) => setTimeout(r, 80));
      const ttsEngine = getLastTtsEngine();

      addVoiceMessage({
        role: "assistant",
        content,
        language: detectLanguage(content),
        modelLabel: model,
        ragSource: ragUsed ? ragSource : undefined,
        ttsEngine: ttsEngine || undefined,
      });

      setStatuses(`✅ ${model} — tap mic to continue`, `✅ ${model} — اضغط للمتابعة`);
    } catch (e: any) {
      addVoiceMessage({ role: "assistant", content: e.message || "Error occurred.", language: "en" });
      setStatuses("❌ Error — tap mic to retry", "❌ خطأ — اضغط للمحاولة مجدداً");
    } finally {
      setIsProcessing(false);
    }
  }, [isRecording, isProcessing, addVoiceMessage, apiKeys, voiceHistory, ragDocuments, useWebSpeech]);

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => {
    const isUser = item.role === "user";
    const { ar, en } = parseBilingual(item.content);
    const defaultLang: "en" | "ar" = ar && item.language === "ar" ? "ar" : "en";
    return (
      <View style={[styles.msgRow, isUser && styles.msgRowUser]}>
        {!isUser && (
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <Feather name="shield" size={10} color="#fff" />
          </View>
        )}
        <View style={[styles.bubble, {
          backgroundColor: isUser ? colors.primary : colors.card,
          borderColor: isUser ? colors.primary : colors.border,
          alignSelf: isUser ? "flex-end" : "flex-start",
        }]}>
          {!isUser && (item.modelLabel || item.ragSource || item.ttsEngine) && (
            <View style={[styles.metaBox, { borderBottomColor: colors.border }]}>
              {item.modelLabel ? (
                <Text style={[styles.metaText, { color: colors.primary }]}>Model: {item.modelLabel}</Text>
              ) : null}
              {item.ttsEngine ? (
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>Voice: {item.ttsEngine}</Text>
              ) : null}
              {item.ragSource ? (
                <Text style={[styles.metaText, { color: "#10b981" }]}>Source: {item.ragSource}</Text>
              ) : null}
            </View>
          )}
          {!isUser && (
            <SpeakerButton
              text={en}
              arText={ar}
              messageId={item.id}
              groqApiKey={apiKeys.groqApiKey}
              groqApiKey2={apiKeys.groqApiKey2}
              colors={colors}
              defaultLang={defaultLang}
            />
          )}
          {ar && !isUser && (
            <>
              <Text style={[styles.langTag, { color: colors.primary }]}>🇸🇦 العربية</Text>
              <Text style={[styles.msgText, styles.arabicText, { color: colors.foreground }]}>{ar}</Text>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <Text style={[styles.langTag, { color: colors.mutedForeground }]}>🇬🇧 English</Text>
            </>
          )}
          <Text style={[styles.msgText, { color: isUser ? "#fff" : colors.foreground }]}>{en}</Text>
          <Text style={[styles.ts, { color: isUser ? "rgba(255,255,255,0.5)" : colors.mutedForeground }]}>
            {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      </View>
    );
  }, [colors, apiKeys.groqApiKey]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Voice Assistant"
        subtitle="مساعد صوتي / Tap microphone"
        colors={colors}
        paddingTopExtra={Platform.OS === "android" ? 14 : 12}
        right={
          <TouchableOpacity
            onPress={() => {
              void stopSpeech();
              clearVoiceHistory();
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Feather name="trash-2" size={moderateScale(18)} color={colors.mutedForeground} />
          </TouchableOpacity>
        }
      />

      {/* History */}
      <FlatList
        ref={flatListRef}
        data={voiceHistory}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Feather name="mic" size={moderateScale(40)} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Voice Mode</Text>
            <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>Tap the mic button to speak in English or Arabic</Text>
            <Text style={[styles.emptySub, { color: colors.primary }]}>اضغط الميكروفون وتحدث بالعربية أو الإنجليزية</Text>
          </View>
        }
      />

      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
        <Text style={[styles.statusEn, { color: isRecording ? "#ef4444" : colors.mutedForeground }]}>{status}</Text>
        <Text style={[styles.statusAr, { color: isRecording ? "#ef4444" : colors.primary }]}>{statusAr}</Text>
      </View>

      {/* Big mic button */}
      <View style={[styles.micWrap, { paddingBottom: insets.bottom + 24 }]}>
        <TouchableOpacity onPress={handleVoicePress} disabled={isProcessing} activeOpacity={0.85}>
          <LinearGradient
            colors={isRecording ? ["#ef4444", "#dc2626"] : isProcessing ? [colors.muted, colors.muted] : [colors.primary, "#FF8C60"]}
            style={styles.micBtn}
          >
            {isProcessing ? (
              <ActivityIndicator color="#fff" size="large" />
            ) : (
              <Feather
                name={isRecording ? "mic-off" : "mic"}
                size={moderateScale(34)}
                color="#fff"
              />
            )}
          </LinearGradient>
        </TouchableOpacity>
        <Text style={[styles.micHint, { color: colors.mutedForeground }]}>
          {isRecording ? "Tap to stop" : isProcessing ? "Processing..." : "Tap to speak"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 14, gap: 10, paddingBottom: 16 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  msgRowUser: { flexDirection: "row-reverse" },
  avatar: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "78%",
  },
  metaBox: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 6, marginBottom: 6, gap: 2 },
  metaText: { fontSize: 9, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  langTag: { fontSize: 9, fontWeight: "600", marginBottom: 3 },
  divider: { height: 1, marginVertical: 7 },
  arabicText: { textAlign: "right", writingDirection: "rtl" },
  msgText: { fontSize: moderateScale(13), fontFamily: "Inter_400Regular", lineHeight: 20 },
  ts: { fontSize: 9, marginTop: 4, alignSelf: "flex-end" },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 10, paddingHorizontal: 30 },
  emptyTitle: { fontSize: moderateScale(18), fontWeight: "700", fontFamily: "Inter_700Bold" },
  emptySub: { fontSize: moderateScale(13), textAlign: "center", fontFamily: "Inter_400Regular" },
  statusBar: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    gap: 2,
  },
  statusEn: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
  statusAr: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
  micWrap: { alignItems: "center", paddingTop: 16, gap: 10 },
  micBtn: {
    width: 86,
    height: 86,
    borderRadius: 43,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#FF6B35",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
  micHint: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
});
