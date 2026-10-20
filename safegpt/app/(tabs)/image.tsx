import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callAI } from "@/services/aiService";
import { readAsBase64, uploadFileToGemini } from "@/services/geminiUpload";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

export default function ImageAnalysisScreen() {
  const { apiKeys } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageSource, setImageSource] = useState<File | string | null>(null);
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [imageName, setImageName] = useState("photo.jpg");
  const [note, setNote] = useState("");
  const webFileInputRef = useRef<any>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState("");

  const handleWebFileChange = (e: any) => {
    const file: File | undefined = e.target?.files?.[0];
    if (!file) return;
    const objUrl = URL.createObjectURL(file);
    setImageUri(objUrl);
    setImageSource(file);
    setImageMime(file.type || "image/jpeg");
    setImageName(file.name);
    setResult(null);
    e.target.value = "";
  };

  const pickImage = async (fromCamera: boolean) => {
    if (Platform.OS === "web") {
      webFileInputRef.current?.click();
      return;
    }
    let res;
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 });
    } else {
      res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });
    }
    if (!res.canceled && res.assets[0]) {
      const uri = res.assets[0].uri;
      setImageUri(uri);
      setImageSource(uri);
      setImageMime("image/jpeg");
      setImageName(res.assets[0].fileName || "photo.jpg");
      setResult(null);
    }
  };

  const analyzeImage = async () => {
    if (!imageSource) return;
    setIsAnalyzing(true);
    setResult(null);

    const prompt = `You are a certified construction site safety inspector. Analyze this image for H&S compliance.
${note ? `Inspector notes: ${note}` : ""}

Identify and report:
1. All visible hazards and safety violations
2. PPE compliance — helmet, hi-vis vest, gloves, boots, harness
3. Unsafe conditions or practices observed
4. Risk level per hazard: Low / Medium / High / Critical
5. Recommended corrective actions (numbered)
6. Applicable NEBOSH / OSHA / Saudi regulations

Be specific about what you can SEE in this image.`;

    try {
      const fileUri = await uploadFileToGemini(imageSource, imageMime, imageName);
      let base64Fallback: string | undefined;
      if (!fileUri) {
        base64Fallback = (await readAsBase64(imageSource)) ?? undefined;
      }
      const { content, model } = await callAI(
        apiKeys, prompt, [],
        base64Fallback,
        undefined,
        { geminiFileUri: fileUri ?? undefined, visionMimeType: imageMime }
      );
      setResult(content);
      setModelUsed(model);
    } catch (e: any) {
      setResult("Error: " + (e.message || "Failed to analyze image. Check API keys in Settings."));
    } finally {
      setIsAnalyzing(false);
    }
  };

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
            <Feather name="camera" size={20} color={colors.primary} />
          </View>
          <View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Image Analysis</Text>
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>تحليل الصور</Text>
          </View>
        </View>
        <View style={{ width: hamburgerOffset + 4 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 20 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.uploadButtons}>
          {Platform.OS !== "web" && (
            <TouchableOpacity
              style={[styles.uploadBtn, { backgroundColor: colors.secondary }]}
              onPress={() => pickImage(true)}
              activeOpacity={0.8}
            >
              <Feather name="camera" size={24} color="#fff" />
              <Text style={styles.uploadBtnText}>Take Photo</Text>
              <Text style={styles.uploadBtnAr}>التقط صورة</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.uploadBtn, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => pickImage(false)}
            activeOpacity={0.8}
          >
            <Feather name="image" size={24} color={colors.primary} />
            <Text style={[styles.uploadBtnText, { color: colors.foreground }]}>
              {Platform.OS === "web" ? "Select / Capture Image" : "Upload Image"}
            </Text>
            <Text style={[styles.uploadBtnAr, { color: colors.mutedForeground }]}>
              {Platform.OS === "web" ? "اختر صورة أو التقطها" : "رفع صورة"}
            </Text>
          </TouchableOpacity>
        </View>

        {imageUri ? (
          <View style={styles.imagePreview}>
            <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="contain" />
            <TouchableOpacity
              style={styles.removeImage}
              onPress={() => { setImageUri(null); setImageSource(null); setResult(null); }}
            >
              <Feather name="x" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.placeholder, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="image" size={48} color={colors.mutedForeground} />
            <Text style={[styles.placeholderText, { color: colors.mutedForeground }]}>
              No image selected
            </Text>
          </View>
        )}

        <View style={[styles.noteContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="edit-3" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.noteInput, { color: colors.foreground }]}
            placeholder="Add notes or context (optional)... / أضف ملاحظات"
            placeholderTextColor={colors.mutedForeground}
            value={note}
            onChangeText={setNote}
            multiline
          />
        </View>

        {Platform.OS === "web" && (
          <input
            ref={webFileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleWebFileChange}
          />
        )}

        {imageUri && (
          <TouchableOpacity
            style={[styles.analyzeButton, { opacity: isAnalyzing ? 0.7 : 1 }]}
            onPress={analyzeImage}
            disabled={isAnalyzing}
            activeOpacity={0.8}
          >
            <LinearGradient colors={["#FF6B35", "#e85d25"]} style={styles.analyzeGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
              {isAnalyzing ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.analyzeButtonText}>Analyzing safety hazards...</Text>
                </>
              ) : (
                <>
                  <Feather name="search" size={20} color="#fff" />
                  <Text style={styles.analyzeButtonText}>Analyze for Safety Hazards</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        )}

        {result && (
          <View style={[styles.resultCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.resultHeader}>
              <View style={[styles.resultIconContainer, { backgroundColor: colors.primary + "20" }]}>
                <Feather name="alert-triangle" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.resultTitle, { color: colors.foreground }]}>Safety Analysis Report</Text>
              </View>
            </View>
            {modelUsed ? (
              <View style={[styles.visionModelBadge, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "30" }]}>
                <Feather name="cpu" size={11} color={colors.primary} />
                <Text style={[styles.visionModelText, { color: colors.primary }]}>Vision Model: {modelUsed}</Text>
              </View>
            ) : null}
            <Text style={[styles.resultText, { color: colors.foreground }]}>{result}</Text>
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
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular" },
  content: { padding: 20, gap: 16 },
  uploadButtons: { flexDirection: "row", gap: 12 },
  uploadBtn: {
    flex: 1,
    borderRadius: 14,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  uploadBtnText: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold", color: "#fff" },
  uploadBtnAr: { fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.7)" },
  imagePreview: { borderRadius: 16, overflow: "hidden", position: "relative" },
  previewImage: { width: "100%", height: 240, borderRadius: 16 },
  removeImage: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    height: 180,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  placeholderText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  noteContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  noteInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", maxHeight: 80 },
  analyzeButton: { borderRadius: 14, overflow: "hidden" },
  analyzeGradient: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    gap: 10,
  },
  analyzeButtonText: { fontSize: 16, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  resultCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  resultHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  resultTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  visionModelBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: "flex-start",
  },
  visionModelText: { fontSize: 11, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  resultText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22 },
});
