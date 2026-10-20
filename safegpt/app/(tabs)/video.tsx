import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import React, { useState } from "react";
import {
  ActivityIndicator, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";
import { callAI } from "@/services/aiService";
import { uploadFileToGemini } from "@/services/geminiUpload";



// ── Convert video URI → base64 (+ mimeType) for Gemini ───────────────────────
async function videoToBase64(uri: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const res = await fetch(uri);
    const blob = await res.blob();
    const mimeType = String((blob as any)?.type || "").trim() || "video/mp4";
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve({ base64: result.split(",")[1], mimeType }); // strip data: prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export default function VideoAnalysisScreen() {
  const { apiKeys } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoName, setVideoName] = useState("");
  const [note, setNote] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState("");

  const resetVideo = () => {
    setVideoUri(null);
    setVideoBlob(null);
    setVideoName("");
    setResult(null);
    setAnalyzeStep("");
  };

  // ── Expo ImagePicker (native) ─────────────────────────────────────────────
  const pickVideoNative = async (fromCamera: boolean) => {
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["videos"], quality: 0.7, videoMaxDuration: 60 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["videos"], quality: 0.7 });
    if (!res.canceled && res.assets[0]) {
      resetVideo();
      setVideoUri(res.assets[0].uri);
      setVideoName(res.assets[0].fileName || "video.mp4");
    }
  };

  // ── Web file picker ───────────────────────────────────────────────────────
  const pickVideoWeb = () => {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = async (e: any) => {
      const file: File = e.target.files?.[0];
      if (!file) return;
      resetVideo();
      const url = URL.createObjectURL(file);
      setVideoUri(url);
      setVideoName(file.name);
      setVideoBlob(file);
    };
    input.click();
  };

  // ── Main analysis logic ───────────────────────────────────────────────────
  const analyzeVideo = async () => {
    if (!videoUri) return;
    setIsAnalyzing(true);
    setResult(null);
    setAnalyzeStep("");

    const safetyPrompt = `You are a certified construction site safety inspector.
Analyze this video for health & safety compliance.${note ? `\n\nInspector notes: ${note}` : ""}

Provide a structured safety report:
1. **PPE Compliance** — helmet, hi-vis vest, gloves, safety boots, harness
2. **Work at Height / Fall Protection**
3. **Equipment & Machinery Safety**
4. **Electrical Hazards**
5. **Housekeeping / Slip / Trip / Fall**
6. **Manual Handling**
7. **Emergency Access & First Aid**
8. **Risk Rating per hazard** — Low / Medium / High / Critical
9. **Immediate Actions Required** (numbered priority list)
10. **Applicable Standards** — NEBOSH / OSHA / Saudi regulations`;

    try {
      setAnalyzeStep("⬆️ Uploading video directly to Gemini...");

      // Upload directly to Gemini Files API — no Vercel relay, supports up to 2 GB
      const source: File | Blob | string = videoBlob ?? videoUri;
      const mimeType = videoBlob ? (videoBlob.type || "video/mp4") : "video/mp4";
      const fileUri = await uploadFileToGemini(source, mimeType, videoName || "video.mp4");

      if (!fileUri) throw new Error("Could not upload video to Gemini. Check your connection and API key.");

      setAnalyzeStep("🔍 Analyzing video with Gemini Vision...");
      const { content, model } = await callAI(
        apiKeys,
        safetyPrompt,
        [],
        undefined,
        undefined,
        { geminiFileUri: fileUri, visionMimeType: mimeType }
      );
      setResult(content);
      setModelUsed(`${model} (direct video analysis)`);
    } catch (e: any) {
      setResult("❌ Error: " + (e.message || "Failed to analyze video."));
    } finally {
      setIsAnalyzing(false);
      setAnalyzeStep("");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, {
        backgroundColor: colors.headerBackground,
        borderBottomColor: colors.border,
        paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12),
        paddingHorizontal: 8,
      }]}>
        <View style={{ width: hamburgerOffset + 4 }} />
        <View style={[styles.headerIcon, { backgroundColor: "#ec489920" }]}>
          <Feather name="video" size={18} color="#ec4899" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Video Analysis</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Gemini Vision • تحليل الفيديو
          </Text>
        </View>
        <View style={{ width: hamburgerOffset + 4 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Upload buttons */}
        <View style={styles.uploadRow}>
          <TouchableOpacity
            style={[styles.uploadBtn, { backgroundColor: "#ec4899" }]}
            onPress={Platform.OS === "web" ? pickVideoWeb : () => pickVideoNative(false)}
            activeOpacity={0.85}
          >
            <Feather name="upload" size={20} color="#fff" />
            <Text style={styles.uploadBtnLabel}>Upload Video</Text>
            <Text style={styles.uploadBtnLabelAr}>رفع فيديو</Text>
          </TouchableOpacity>

          {Platform.OS !== "web" && (
            <TouchableOpacity
              style={[styles.uploadBtn, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
              onPress={() => pickVideoNative(true)}
              activeOpacity={0.85}
            >
              <Feather name="video" size={20} color={colors.foreground} />
              <Text style={[styles.uploadBtnLabel, { color: colors.foreground }]}>Record</Text>
              <Text style={[styles.uploadBtnLabelAr, { color: colors.mutedForeground }]}>تسجيل</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Vision routing info */}
        <View style={[styles.routingCard, { backgroundColor: "#8b5cf620", borderColor: "#8b5cf650" }]}>
          <Feather name="info" size={13} color="#8b5cf6" />
          <Text style={[styles.routingText, { color: "#8b5cf6" }]}>
            <Text style={{ fontWeight: "700" }}>Vision routing: </Text>
            Full video → Gemini 2.5 Flash (primary) → if quota hit → frame extraction → Local Llama 3.2 Vision
          </Text>
        </View>

        {/* Video selected */}
        {videoUri ? (
          <View style={[styles.videoCard, { backgroundColor: colors.card, borderColor: "#ec489960" }]}>
            <View style={[styles.videoIconBox, { backgroundColor: "#ec489920" }]}>
              <Feather name="film" size={26} color="#ec4899" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.videoName, { color: colors.foreground }]} numberOfLines={2}>{videoName}</Text>
              <Text style={[styles.videoSub, { color: "#10b981" }]}>
                {videoBlob ? "✓ Ready (full video + frame fallback)" : "✓ Video selected"}
              </Text>
            </View>
            <TouchableOpacity onPress={resetVideo} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x-circle" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.placeholder, { borderColor: colors.border }]}>
            <Feather name="video" size={36} color={colors.mutedForeground} />
            <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>No Video Selected</Text>
            <Text style={[styles.placeholderSub, { color: colors.mutedForeground }]}>
              Upload a video for AI-powered safety analysis
            </Text>
          </View>
        )}

        {/* Notes */}
        <View style={[styles.noteBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Feather name="edit-3" size={15} color={colors.mutedForeground} />
          <TextInput
            style={[styles.noteInput, { color: colors.foreground, fontSize: moderateScale(13) }]}
            placeholder="Inspector notes (optional) / ملاحظات المفتش"
            placeholderTextColor={colors.mutedForeground}
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={500}
          />
        </View>

        {/* Analyze button */}
        <TouchableOpacity
          style={{ borderRadius: 14, overflow: "hidden", opacity: !videoUri || isAnalyzing ? 0.55 : 1 }}
          onPress={analyzeVideo}
          disabled={!videoUri || isAnalyzing}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={["#ec4899", "#8b5cf6"]}
            style={styles.analyzeGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {isAnalyzing
              ? <ActivityIndicator color="#fff" size="small" />
              : <Feather name="search" size={18} color="#fff" />}
            <Text style={styles.analyzeBtnText}>
              {isAnalyzing ? "Analyzing..." : "Analyze Video"}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        {/* Step indicator */}
        {isAnalyzing && analyzeStep ? (
          <View style={[styles.stepCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.stepText, { color: colors.mutedForeground, fontSize: moderateScale(12) }]}>
              {analyzeStep}
            </Text>
          </View>
        ) : null}

        {/* Result */}
        {result && (
          <View style={[styles.resultCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.resultHeader}>
              <View style={[styles.resultIconBox, { backgroundColor: "#10b98120" }]}>
                <Feather name="shield" size={16} color="#10b981" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.resultTitle, { color: colors.foreground }]}>Safety Analysis Report</Text>
                <Text style={[styles.resultModel, { color: colors.mutedForeground, fontSize: moderateScale(10) }]}>
                  {modelUsed}
                </Text>
              </View>
            </View>
            <Text style={[styles.resultText, { color: colors.foreground, fontSize: moderateScale(13) }]}>
              {result}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
    minHeight: 60,
  },
  headerIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: moderateScale(16), fontWeight: "700", fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: moderateScale(10), fontFamily: "Inter_400Regular", marginTop: 1 },
  content: { padding: 16, gap: 14 },
  uploadRow: { flexDirection: "row", gap: 12 },
  uploadBtn: { flex: 1, borderRadius: 14, paddingVertical: 18, paddingHorizontal: 10, alignItems: "center", gap: 6 },
  uploadBtnLabel: { fontSize: moderateScale(13), fontWeight: "700", fontFamily: "Inter_700Bold", color: "#fff" },
  uploadBtnLabelAr: { fontSize: moderateScale(10), fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.7)" },
  routingCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
  },
  routingText: { flex: 1, fontSize: moderateScale(11), fontFamily: "Inter_400Regular", lineHeight: 17 },
  videoCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 12,
  },
  videoIconBox: { width: 50, height: 50, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  videoName: { fontSize: moderateScale(13), fontWeight: "600", fontFamily: "Inter_700Bold" },
  videoSub: { fontSize: moderateScale(11), fontFamily: "Inter_400Regular", marginTop: 2 },
  placeholder: {
    minHeight: 150,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 20,
  },
  placeholderTitle: { fontSize: moderateScale(15), fontWeight: "600", fontFamily: "Inter_700Bold" },
  placeholderSub: { fontSize: moderateScale(12), fontFamily: "Inter_400Regular", textAlign: "center" },
  noteBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  noteInput: { flex: 1, fontFamily: "Inter_400Regular", maxHeight: 80 },
  analyzeGradient: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    gap: 10,
  },
  analyzeBtnText: { fontSize: moderateScale(15), fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  stepCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
  },
  stepText: { fontFamily: "Inter_400Regular", flex: 1 },
  resultCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  resultHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultIconBox: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  resultTitle: { fontSize: moderateScale(14), fontWeight: "700", fontFamily: "Inter_700Bold" },
  resultModel: { fontFamily: "Inter_400Regular", marginTop: 1 },
  resultText: { fontFamily: "Inter_400Regular", lineHeight: 21 },
});
