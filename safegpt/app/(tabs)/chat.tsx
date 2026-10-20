import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, KeyboardAvoidingView,
  Platform, StyleSheet, Text, TextInput,
  TouchableOpacity, useWindowDimensions, View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, ChatMessage } from "@/context/AppContext";
import {
  callAI, transcribeAudio, stopSpeech, detectLanguage, detectWebSearchCommand, detectDocCommand,
} from "@/services/aiService";
import { isSituationQuery, detectViolations, detectConflicts, ViolationResult } from "@/services/violationService";
import { readAsBase64, uploadFileToGemini } from "@/services/geminiUpload";
import { SpeakerButton } from "@/components/SpeakerButton";
import { ensureMicPermission, startNativeRecording, stopNativeRecordingToBlob } from "@/services/nativeRecording";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useColors } from "@/hooks/useColors";
import { moderateScale } from "@/hooks/useResponsive";
import { MentionMenu, DirectTarget } from "@/components/MentionMenu";

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
      _recorder?.stream.getTracks().forEach((t: any) => t.stop());
    };
    _recorder.stop();
  });
}

// ─── Web Speech API (free browser STT — no API key needed) ───────────────────
let _chatRecognition: any = null;
let _chatTranscript = "";

function chatHasBrowserSpeech(): boolean {
  if (typeof window === "undefined") return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

function startChatWebSpeech(): Promise<void> {
  return new Promise((resolve, reject) => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { reject(new Error("Browser speech recognition not supported.")); return; }
    _chatTranscript = "";
    _chatRecognition = new SR();
    _chatRecognition.continuous = true;
    _chatRecognition.interimResults = true;
    _chatRecognition.lang = "";
    _chatRecognition.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      _chatTranscript = t;
    };
    _chatRecognition.onerror = (e: any) => {
      if (e.error !== "aborted") reject(new Error(`Mic error: ${e.error}`));
    };
    _chatRecognition.onstart = () => resolve();
    _chatRecognition.start();
  });
}

function stopChatWebSpeech(): Promise<{ text: string; language: "en" | "ar" }> {
  return new Promise((resolve) => {
    if (!_chatRecognition) { resolve({ text: "", language: "en" }); return; }
    _chatRecognition.onend = () => {
      const text = _chatTranscript.trim();
      const isAr = /[\u0600-\u06FF]/.test(text);
      resolve({ text, language: isAr ? "ar" : "en" });
      _chatRecognition = null;
    };
    _chatRecognition.stop();
  });
}

// ─── Bilingual parser ─────────────────────────────────────────────────────────
function parseBilingual(content: string): { ar: string | null; en: string } {
  const i = content.indexOf("---EN---");
  if (i === -1) {
    const match = content.match(/^\s*(?:Arabic|العربية)\s*:?\s*\n([\s\S]*?)\n\s*(?:English|EN)\s*:?\s*\n([\s\S]*)$/i);
    if (match) return { ar: match[1].trim(), en: match[2].trim() };
    return { ar: null, en: content };
  }
  return { ar: content.slice(0, i).trim(), en: content.slice(i + 8).trim() };
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ChatScreen() {
  const { chatHistory, addChatMessage, clearChatHistory, apiKeys, language, ragDocuments, showModelDetails, setShowModelDetails } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [currentModel, setCurrentModel] = useState("");
  const flatListRef = useRef<FlatList>(null);
  const webFileInputRef = useRef<any>(null);
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64?: string; file?: File; mime: string; mediaType: "image" | "video" } | null>(null);
  const [violationCheckEnabled, setViolationCheckEnabled] = useState(true);
  const [directTarget, setDirectTarget] = useState<DirectTarget | null>(null);
  const [showMentionMenu, setShowMentionMenu] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem("violationCheckEnabled").then((v) => {
      if (v !== null) setViolationCheckEnabled(v === "true");
    });
  }, []);

  // ── Attach photo / video ──────────────────────────────────────────────────
  const handleAttach = useCallback(async () => {
    if (Platform.OS === "web") {
      // On web — trigger a hidden file input
      if (webFileInputRef.current) {
        webFileInputRef.current.click();
      }
      return;
    }
    // Native — use ImagePicker
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      addChatMessage({ role: "assistant", content: "Photo library permission denied. Enable it in device settings.", language: "en" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const isVideo = asset.type === "video";
      setPendingImage({
        uri: asset.uri,
        mime: isVideo ? "video/mp4" : "image/jpeg",
        mediaType: isVideo ? "video" : "image",
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [addChatMessage]);

  // Web file input change handler
  const handleWebFileChange = useCallback((e: any) => {
    const file: File | undefined = e.target?.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    const objectUrl = URL.createObjectURL(file);
    setPendingImage({
      uri: objectUrl,
      file,
      mime: file.type || (isVideo ? "video/mp4" : "image/jpeg"),
      mediaType: isVideo ? "video" : "image",
    });
    e.target.value = "";
  }, []);

  // ── Send text (with optional image) ──────────────────────────────────────
  const handleSend = useCallback(async () => {
    const raw = input.trim();
    const hasImage = !!pendingImage;
    if (!raw && !hasImage || isLoading) return;

    const imageToSend = pendingImage;
    const capturedDirectTarget = directTarget;
    setInput("");
    setPendingImage(null);
    setDirectTarget(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Skip @doc/@search detection when routing via @ menu
    const { isDocOnly, query: docQuery } = capturedDirectTarget
      ? { isDocOnly: false, query: raw }
      : detectDocCommand(raw);
    const { isWebSearch, query: webQuery } = (isDocOnly || !!capturedDirectTarget)
      ? { isWebSearch: false, query: docQuery }
      : detectWebSearchCommand(raw);
    const query = isDocOnly ? docQuery : webQuery;

    const imageLabel = imageToSend
      ? imageToSend.mediaType === "video" ? "[🎥 Video] " : "[📷 Photo] "
      : "";
    const userText = raw || (imageToSend ? "Analyze this image for health & safety hazards." : "");
    const displayText = capturedDirectTarget
      ? `@${capturedDirectTarget.label}: ${query || userText}`
      : isDocOnly
        ? `📄 Doc: ${query}`
        : isWebSearch ? `🔍 Search: ${query}` : `${imageLabel}${userText}`;

    addChatMessage({ role: "user", content: displayText, language });
    setIsLoading(true);
    if (isWebSearch) setIsSearching(true);

    try {
      const history = chatHistory.slice(-12).map(m => ({ role: m.role, content: m.content }));
      let geminiFileUri: string | undefined;
      let base64Fallback: string | undefined;
      if (imageToSend && !isWebSearch && !isDocOnly) {
        const src = imageToSend.file ?? imageToSend.uri;
        geminiFileUri = (await uploadFileToGemini(
          src,
          imageToSend.mime,
          imageToSend.mediaType === "video" ? "video.mp4" : "photo.jpg"
        )) || undefined;
        if (!geminiFileUri) base64Fallback = (await readAsBase64(src)) ?? undefined;
      }
      const { content, model, ragUsed, ragSource, citationWarning } = await callAI(
        apiKeys,
        query || userText,
        history,
        base64Fallback,
        ragDocuments,
        capturedDirectTarget
          ? capturedDirectTarget.id === "rag"
            ? { forceRagOnly: true }
            : { forceDirectModel: capturedDirectTarget.id }
          : isDocOnly
            ? { forceRagOnly: true }
            : isWebSearch
              ? { forceWebSearch: true }
              : imageToSend ? { geminiFileUri, visionMimeType: imageToSend.mime } : undefined
      );
      setCurrentModel(model);

      // Run violation detection if toggle is on and message describes a situation
      let violations: ViolationResult[] = [];
      if (violationCheckEnabled && !isWebSearch && !isDocOnly && !imageToSend && isSituationQuery(query || userText)) {
        try {
          violations = await detectViolations(query || userText, ragDocuments || []);
        } catch { violations = []; }
      }

      addChatMessage({
        role: "assistant",
        content,
        language: detectLanguage(content),
        modelLabel: model,
        ragSource: ragUsed ? ragSource : undefined,
        citationWarning: citationWarning ?? null,
        violationResults: violations.length > 0 ? violations : undefined,
      });
    } catch (e: any) {
      addChatMessage({ role: "assistant", content: e.message || "Error connecting to AI. Check Settings.", language: "en" });
    } finally {
      setIsLoading(false);
      setIsSearching(false);
    }
  }, [input, pendingImage, isLoading, chatHistory, addChatMessage, apiKeys, language, ragDocuments, directTarget]);

  // True when on web with no Groq key → use free browser Speech Recognition
  const useWebSpeech = Platform.OS === "web" && !apiKeys.groqApiKey && chatHasBrowserSpeech();

  // ── Voice / mic ───────────────────────────────────────────────────────────
  const handleMic = useCallback(async () => {
    if (isLoading && !isRecording) return;

    if (!isRecording) {
      if (Platform.OS === "web") {
        if (useWebSpeech) {
          try {
            await startChatWebSpeech();
            setIsRecording(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          } catch (e: any) {
            addChatMessage({ role: "assistant", content: e.message || "Microphone error.", language: "en" });
          }
        } else {
          try {
            await startRec();
            setIsRecording(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          } catch {
            addChatMessage({
              role: "assistant",
              content: "Microphone access denied. Allow microphone in your browser settings.",
              language: "en",
            });
          }
        }
      } else {
        const ok = await ensureMicPermission();
        if (!ok) {
          addChatMessage({
            role: "assistant",
            content: "Microphone access denied. Enable the microphone in system settings for SafeGPT.",
            language: "en",
          });
          return;
        }
        try {
          await startNativeRecording();
          setIsRecording(true);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        } catch {
          addChatMessage({
            role: "assistant",
            content: "Could not start voice recording. Try again.",
            language: "en",
          });
        }
      }
      return;
    }

    setIsRecording(false);
    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      let text: string;
      let detectedLang: "en" | "ar";

      if (Platform.OS === "web" && useWebSpeech) {
        const result = await stopChatWebSpeech();
        text = result.text;
        detectedLang = result.language;
      } else {
        const blob =
          Platform.OS === "web" ? await stopRec() : await stopNativeRecordingToBlob();
        const result = await transcribeAudio(apiKeys, blob);
        text = result.text;
        detectedLang = result.language;
      }

      if (!text.trim()) {
        setIsLoading(false);
        return;
      }

      const sttSource = (Platform.OS === "web" && useWebSpeech) ? "Browser Speech" : "Whisper";
      const { isWebSearch: voiceIsSearch, query: voiceQuery } = detectWebSearchCommand(text);
      const voiceDisplay = voiceIsSearch ? `🔍 Search: ${voiceQuery}` : text;
      addChatMessage({ role: "user", content: voiceDisplay, language: detectedLang });
      if (voiceIsSearch) setIsSearching(true);

      const history = chatHistory.slice(-12).map((m) => ({ role: m.role, content: m.content }));
      const { content, model, ragUsed, ragSource, citationWarning: voiceCitationWarning } = await callAI(
        apiKeys, voiceQuery, history, undefined, ragDocuments,
        voiceIsSearch ? { forceWebSearch: true, sttSource } : { sttSource }
      );
      setCurrentModel(model);

      let voiceViolations: ViolationResult[] = [];
      if (violationCheckEnabled && !voiceIsSearch && isSituationQuery(voiceQuery)) {
        try {
          voiceViolations = await detectViolations(voiceQuery, ragDocuments || []);
        } catch { voiceViolations = []; }
      }

      addChatMessage({
        role: "assistant",
        content,
        language: detectLanguage(content),
        modelLabel: model,
        ragSource: ragUsed ? ragSource : undefined,
        citationWarning: voiceCitationWarning ?? null,
        violationResults: voiceViolations.length > 0 ? voiceViolations : undefined,
      });
    } catch (e: any) {
      addChatMessage({ role: "assistant", content: e.message || "Voice error.", language: "en" });
    } finally {
      setIsLoading(false);
      setIsSearching(false);
    }
  }, [isRecording, isLoading, apiKeys, chatHistory, addChatMessage, ragDocuments, useWebSpeech]);

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble
        message={item}
        colors={colors}
        groqApiKey={apiKeys.groqApiKey}
        groqApiKey2={apiKeys.groqApiKey2}
        showModelDetails={showModelDetails}
        onToggleModelDetails={setShowModelDetails}
      />
    ),
    [colors, apiKeys.groqApiKey, apiKeys.groqApiKey2]
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Chat Assistant"
        subtitle={currentModel || null}
        colors={colors}
        right={
          <TouchableOpacity
            onPress={() => {
              void stopSpeech();
              clearChatHistory();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Feather name="trash-2" size={moderateScale(19)} color={colors.mutedForeground} />
          </TouchableOpacity>
        }
      />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        {/* Empty state */}
        {chatHistory.length === 0 ? (
          <View style={styles.emptyState}>
            <Feather name="shield" size={moderateScale(46)} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>SafeGPT Assistant</Text>
            <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
              Ask any Health {"&"} Safety question in English or Arabic
            </Text>
            <Text style={[styles.emptySubtitleAr, { color: colors.primary }]}>
              اسأل أي سؤال عن السلامة والصحة المهنية
            </Text>
            <View style={{ gap: 8, width: "100%", marginTop: 8 }}>
              {[
                "What PPE is required on a construction site?",
                "كيف أجري تقييم للمخاطر؟",
                "What are NEBOSH key principles?",
                "Explain fall protection requirements",
                "search the web for: latest OSHA scaffold regulations",
              ].map((s, i) => (
                <TouchableOpacity
                  key={i}
                  style={[styles.suggestion, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => setInput(s)}
                >
                  <Text style={[styles.suggestionText, { color: colors.foreground }]}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={chatHistory}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            showsVerticalScrollIndicator={false}
          />
        )}

        {/* Loading */}
        {isLoading && (
          <View style={[styles.loadingBar, { backgroundColor: colors.card }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
              {isRecording ? "🔴 Listening..." : isSearching ? "🔍 Searching the web..." : "SafeGPT is thinking..."}
            </Text>
          </View>
        )}

        {/* Hidden web file input */}
        {Platform.OS === "web" && (
          <input
            ref={webFileInputRef}
            type="file"
            accept="image/*,video/*"
            style={{ display: "none" }}
            onChange={handleWebFileChange}
          />
        )}

        {/* Pending image preview strip */}
        {pendingImage && (
          <View style={[styles.pendingImageBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <View style={styles.pendingImageThumb}>
              {pendingImage.mediaType === "image" ? (
                <Image source={{ uri: pendingImage.uri }} style={styles.thumbImg} />
              ) : (
                <View style={[styles.thumbImg, { backgroundColor: "#1e293b", alignItems: "center", justifyContent: "center" }]}>
                  <Feather name="video" size={22} color="#94a3b8" />
                </View>
              )}
              <Text style={[styles.pendingLabel, { color: colors.foreground }]}>
                {pendingImage.mediaType === "video" ? "🎥 Video attached" : "📷 Photo attached"}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setPendingImage(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* @ mention menu */}
        <MentionMenu
          visible={showMentionMenu}
          type="chat"
          colors={colors}
          onSelect={(target) => {
            setDirectTarget(target);
            setShowMentionMenu(false);
            setInput((prev) => prev.endsWith("@") ? prev.slice(0, -1) : prev);
          }}
          onClose={() => setShowMentionMenu(false)}
        />

        {/* Direct target badge — shown when an @ model is selected */}
        {directTarget && (
          <View style={[styles.targetBadge, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <Feather name="at-sign" size={13} color={colors.primary} />
            <Text style={[styles.targetBadgeText, { color: colors.primary }]}>{directTarget.label}</Text>
            <TouchableOpacity onPress={() => setDirectTarget(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={13} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* Input bar: [📎 attach] [text input] [🎙 mic] [➤ send] */}
        <View style={[styles.inputBar, {
          backgroundColor: colors.headerBackground,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom + 8, 12),
        }]}>
          {/* Attach button — LEFT */}
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: pendingImage ? colors.primary + "30" : colors.muted, borderColor: pendingImage ? colors.primary : colors.border }]}
            onPress={handleAttach}
            disabled={isLoading}
          >
            <Feather name="image" size={moderateScale(18)} color={pendingImage ? colors.primary : colors.mutedForeground} />
          </TouchableOpacity>

          <View style={[styles.inputContainer, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <TextInput
              style={[styles.textInput, { color: colors.foreground, fontSize: Math.max(16, moderateScale(14)) }]}
              placeholder={isRecording ? "🔴 Recording... tap mic to stop" : pendingImage ? "Ask about this photo/video..." : "Ask a safety question..."}
              placeholderTextColor={isRecording ? "#ef4444" : colors.mutedForeground}
              value={input}
              onChangeText={(text) => {
                setInput(text);
                if (text.endsWith("@")) setShowMentionMenu(true);
              }}
              multiline
              maxLength={2000}
              editable={!isRecording}
            />
          </View>

          {/* Mic button — RIGHT of input */}
          <TouchableOpacity
            style={[styles.iconBtn, {
              backgroundColor: isRecording ? "#ef4444" : colors.muted,
              borderColor: isRecording ? "#ef4444" : colors.border,
            }]}
            onPress={handleMic}
            disabled={isLoading && !isRecording}
          >
            <Feather name={isRecording ? "mic-off" : "mic"} size={moderateScale(18)} color={isRecording ? "#fff" : colors.mutedForeground} />
          </TouchableOpacity>

          {/* Send button — far right */}
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: (input.trim() || pendingImage) ? colors.primary : colors.muted, borderColor: "transparent" }]}
            onPress={handleSend}
            disabled={(!input.trim() && !pendingImage) || isLoading}
          >
            <Feather name="send" size={moderateScale(18)} color={(input.trim() || pendingImage) ? "#fff" : colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Message Bubble ────────────────────────────────────────────────────────────
function MessageBubble({
  message,
  colors,
  groqApiKey,
  groqApiKey2 = "",
  showModelDetails,
  onToggleModelDetails,
}: {
  message: ChatMessage;
  colors: any;
  groqApiKey: string;
  groqApiKey2?: string;
  showModelDetails: boolean;
  onToggleModelDetails: (show: boolean) => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const isUser = message.role === "user";
  const { ar, en } = parseBilingual(message.content);
  const defaultLang: "en" | "ar" = ar && message.language === "ar" ? "ar" : "en";

  return (
    <View style={[styles.msgContainer, isUser && styles.msgContainerUser]}>
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Feather name="shield" size={11} color="#fff" />
        </View>
      )}

      <View style={[styles.bubble, {
        backgroundColor: isUser ? colors.primary : colors.card,
        borderColor: isUser ? colors.primary : colors.border,
        maxWidth: Math.min(screenWidth * 0.76, 860),
      }]}>
        {/* ── Citation warning (above model display) ── */}
        {!isUser && message.citationWarning ? (
          <View style={styles.citationWarning}>
            <Text style={styles.citationWarningText}>{message.citationWarning}</Text>
          </View>
        ) : null}

        {/* ── Model / Source metadata header ── */}
        {!isUser && (
          <View style={[styles.metaHeader, { borderBottomColor: colors.border }]}>
            {message.modelLabel && showModelDetails ? (
              <Text style={[styles.metaItem, { color: colors.primary }]}>{message.modelLabel}</Text>
            ) : null}
            {message.ragSource && showModelDetails ? (
              <Text style={[styles.metaItem, { color: "#10b981" }]}>Source: {message.ragSource}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.modelVisibilityButton, { borderColor: colors.border }]}
              onPress={() => onToggleModelDetails(!showModelDetails)}
              accessibilityRole="button"
              accessibilityLabel={showModelDetails ? "Hide model and source details" : "Show model and source details"}
              {...(Platform.OS === "web" ? { title: showModelDetails ? "Hide model and source details" : "Show model and source details" } as any : {})}
            >
              <Feather name={showModelDetails ? "eye-off" : "eye"} size={14} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* ── Speaker button (AI responses only) ── */}
        {!isUser && (
          <SpeakerButton
            text={en}
            arText={ar}
            messageId={message.id}
            groqApiKey={groqApiKey}
            groqApiKey2={groqApiKey2}
            colors={colors}
            defaultLang={defaultLang}
          />
        )}

        {/* ── Bilingual content ── */}
        {ar && !isUser && (
          <>
            <View style={styles.langTagRow}>
              <View style={[styles.langTag, { backgroundColor: "#10b98120", borderColor: "#10b98140" }]}>
                <Text style={[styles.langTagText, { color: "#10b981" }]}>🇸🇦 Arabic / العربية</Text>
              </View>
            </View>
            <Text style={[styles.msgText, styles.arabicText, { color: colors.foreground, fontSize: moderateScale(14) }]}>
              {ar}
            </Text>
            <View style={[styles.langDivider, { backgroundColor: colors.border }]} />
            <View style={styles.langTagRow}>
              <View style={[styles.langTag, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "30" }]}>
                <Text style={[styles.langTagText, { color: colors.primary }]}>🇬🇧 English</Text>
              </View>
            </View>
          </>
        )}

        <Text style={[styles.msgText, { color: isUser ? "#fff" : colors.foreground, fontSize: moderateScale(14) }]}>
          {en}
        </Text>
        <Text style={[styles.timestamp, { color: isUser ? "rgba(255,255,255,0.55)" : colors.mutedForeground }]}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </Text>

        {/* ── Violation Detection Panel ── */}
        {!isUser && message.violationResults !== undefined && (
          <ViolationPanel violations={message.violationResults} />
        )}
      </View>
    </View>
  );
}

// ─── Violation Panel ──────────────────────────────────────────────────────────
function ViolationPanel({ violations }: { violations: ViolationResult[] }) {
  const [expanded, setExpanded] = useState(true);
  const hasCritical = violations.some((v) => v.severity === "CRITICAL");
  const conflict = detectConflicts(violations);

  return (
    <View style={violStyles.panel}>
      <TouchableOpacity
        style={violStyles.panelHeader}
        onPress={() => setExpanded((e) => !e)}
        activeOpacity={0.7}
      >
        <Text style={violStyles.panelTitle}>
          🔍 Violation Check {violations.length > 0 ? `(${violations.length} reference${violations.length !== 1 ? "s" : ""})` : ""}
        </Text>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={14} color="#64748b" />
      </TouchableOpacity>

      {expanded && (
        <View>
          {hasCritical && (
            <View style={violStyles.critical}>
              <Text style={violStyles.criticalTitle}>🚨 CRITICAL — POTENTIAL IMMEDIATE LIFE RISK</Text>
              <Text style={violStyles.criticalBody}>
                If this situation is currently ongoing, stop work immediately.{"\n"}
                Do not resume until verified safe by a competent person.
              </Text>
            </View>
          )}

          {violations.length === 0 ? (
            <View style={violStyles.noMatch}>
              <Text style={violStyles.noMatchText}>
                ⚪ NO REGULATION MATCH FOUND IN UPLOADED DOCUMENTS{"\n"}
                This does not mean no regulation applies.{"\n"}
                It means the uploaded documents did not contain a confirmed match.{"\n"}
                Consult your HSE team or legal advisor.
              </Text>
            </View>
          ) : (
            violations.map((v, idx) => (
              <View
                key={idx}
                style={[
                  violStyles.violItem,
                  v.confidence === "HIGH" ? violStyles.violItemHigh : violStyles.violItemLow,
                ]}
              >
                <Text style={violStyles.violConfidence}>
                  {v.confidence === "HIGH" ? "🔴 CONFIRMED REGULATION REFERENCE" : "🟡 POSSIBLE RELATED REGULATION"}
                </Text>
                <Text style={violStyles.violDoc}>
                  {v.documentName}{v.articleNumber ? ` — Article ${v.articleNumber}` : ""}
                </Text>
                <Text style={violStyles.violText}>"{v.articleText}"</Text>
                <Text style={violStyles.violNote}>
                  {v.confidence === "HIGH"
                    ? "This situation appears to relate to this regulation.\nVerify with your legal or HSE team before taking any action."
                    : "Weak match — manual verification required.\nDo not use this as the basis for any action without checking the source."}
                </Text>
              </View>
            ))
          )}

          {conflict ? (
            <View style={violStyles.conflict}>
              <Text style={violStyles.conflictText}>{conflict}</Text>
            </View>
          ) : null}

          <View style={violStyles.disclaimer}>
            <Text style={violStyles.disclaimerText}>
              {"━".repeat(36)}{"\n"}
              ⚠️ IMPORTANT DISCLAIMER{"\n"}
              This tool is a reference aid only and does not constitute legal advice.{"\n"}
              All results must be verified by a qualified HSE professional or legal advisor{"\n"}
              before any action, disciplinary measure, or compliance decision is taken.{"\n"}
              {"━".repeat(36)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const violStyles = StyleSheet.create({
  panel: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8,
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  panelTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
    fontFamily: "Inter_700Bold",
  },
  critical: {
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
    borderLeftWidth: 3,
    borderLeftColor: "#ef4444",
  },
  criticalTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#b91c1c",
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  criticalBody: {
    fontSize: 11,
    color: "#7f1d1d",
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  noMatch: {
    backgroundColor: "#f1f5f9",
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
  },
  noMatchText: {
    fontSize: 10,
    color: "#64748b",
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  violItem: {
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
    borderLeftWidth: 3,
  },
  violItemHigh: {
    backgroundColor: "#fff1f2",
    borderLeftColor: "#ef4444",
  },
  violItemLow: {
    backgroundColor: "#fefce8",
    borderLeftColor: "#eab308",
  },
  violConfidence: {
    fontSize: 10,
    fontWeight: "700",
    color: "#475569",
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  violDoc: {
    fontSize: 11,
    fontWeight: "600",
    color: "#1e293b",
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  violText: {
    fontSize: 11,
    color: "#334155",
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 16,
    marginBottom: 4,
  },
  violNote: {
    fontSize: 10,
    color: "#64748b",
    fontFamily: "Inter_400Regular",
    lineHeight: 15,
  },
  conflict: {
    backgroundColor: "#fff7ed",
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
    borderLeftWidth: 3,
    borderLeftColor: "#f97316",
  },
  conflictText: {
    fontSize: 10,
    color: "#9a3412",
    fontFamily: "Inter_400Regular",
    lineHeight: 15,
  },
  disclaimer: {
    marginTop: 8,
    paddingTop: 6,
  },
  disclaimerText: {
    fontSize: 9,
    color: "#94a3b8",
    fontFamily: "Inter_400Regular",
    lineHeight: 14,
  },
});

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, gap: 10 },
  emptyTitle: { fontSize: moderateScale(20), fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySubtitle: { fontSize: moderateScale(13), textAlign: "center", fontFamily: "Inter_400Regular" },
  emptySubtitleAr: { fontSize: moderateScale(12), textAlign: "center", fontFamily: "Inter_400Regular" },
  suggestion: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  suggestionText: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
  messagesList: { padding: 14, gap: 10, paddingBottom: 20 },
  // Bubbles
  msgContainer: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  msgContainerUser: { alignSelf: "flex-end", flexDirection: "row-reverse" },
  avatar: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
  },
  metaHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 6,
    marginBottom: 6,
    gap: 6,
  },
  metaItem: { flexShrink: 1, maxWidth: "100%", fontSize: moderateScale(9), fontFamily: "Inter_400Regular", fontStyle: "italic" },
  modelVisibilityButton: {
    alignSelf: "flex-start",
    minWidth: 32,
    minHeight: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  // Bilingual
  langTagRow: { marginBottom: 4 },
  langTag: {
    alignSelf: "flex-start",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  langTagText: { fontSize: moderateScale(9), fontWeight: "700", letterSpacing: 0.3 },
  langDivider: { height: 1, marginVertical: 10 },
  arabicText: { textAlign: "right", writingDirection: "rtl", marginBottom: 2 },
  msgText: { fontFamily: "Inter_400Regular", lineHeight: 22 },
  timestamp: { fontSize: moderateScale(9), marginTop: 5, alignSelf: "flex-end", fontFamily: "Inter_400Regular" },
  citationWarning: {
    backgroundColor: "#fef3c7",
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
    padding: 8,
    marginBottom: 8,
  },
  citationWarningText: {
    fontSize: moderateScale(10),
    color: "#92400e",
    fontFamily: "Inter_400Regular",
    lineHeight: 15,
  },
  // Loading
  loadingBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 10, gap: 10 },
  loadingText: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular" },
  // Input bar
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    flexShrink: 0,
  },
  inputContainer: {
    flex: 1,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxHeight: 120,
    minHeight: 44,
    justifyContent: "center",
  },
  textInput: { fontFamily: "Inter_400Regular", maxHeight: 100 },
  // Pending image preview strip
  pendingImageBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  pendingImageThumb: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  thumbImg: { width: 48, height: 48, borderRadius: 8 },
  pendingLabel: { fontSize: 13, fontFamily: "Inter_500Medium" },
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
});
