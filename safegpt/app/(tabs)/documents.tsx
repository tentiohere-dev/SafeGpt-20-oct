import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import React, { useState, useEffect } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, RagDocument } from "@/context/AppContext";
import {
  extractRagDocumentContent,
  RAG_INDEX_VERSION,
  detectScannedPDF,
  detectDocumentDate,
} from "@/services/ragService";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

const VIOLATION_TOGGLE_KEY = "violationCheckEnabled";

export default function DocumentsScreen() {
  const { ragDocuments, addRagDocument, deleteRagDocument } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();
  const [search, setSearch] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [violationCheckEnabled, setViolationCheckEnabled] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(VIOLATION_TOGGLE_KEY).then((v) => {
      if (v !== null) setViolationCheckEnabled(v === "true");
    });
  }, []);

  const handleViolationToggle = async (value: boolean) => {
    setViolationCheckEnabled(value);
    await AsyncStorage.setItem(VIOLATION_TOGGLE_KEY, String(value));
  };

  const handleAddDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/plain", "image/*"],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      setIsUploading(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const uploadSummaries: string[] = [];

      for (const asset of result.assets) {
        const extracted = await extractRagDocumentContent({
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          uri: asset.uri,
        });
        const doc: Omit<RagDocument, "id" | "addedAt"> = {
          name: asset.name,
          type: asset.mimeType || "unknown",
          size: asset.size || 0,
          uri: asset.uri,
          indexed: extracted.indexed,
          content: extracted.content,
          chunks: extracted.chunks,
          indexVersion: RAG_INDEX_VERSION,
        };
        addRagDocument(doc);

        // Build upload summary line for this document
        if (extracted.indexed && extracted.parseStats) {
          const s = extracted.parseStats;
          const typeLabel =
            s.docType === "law" ? "Law / Legal" :
            s.docType === "book" ? "Book / Manual" : "General";
          let structureLine = "";
          if (s.articleCount > 0) structureLine = `${s.articleCount} articles extracted`;
          else if (s.chapterCount > 0 || s.sectionCount > 0)
            structureLine = `${s.chapterCount} chapters, ${s.sectionCount} sections extracted`;
          else structureLine = `${extracted.chunks?.length ?? 0} text chunks indexed`;
          uploadSummaries.push(`📄 ${asset.name}\nType: ${typeLabel}\n${structureLine}`);
        } else if (extracted.indexed) {
          uploadSummaries.push(`📄 ${asset.name}\nIndexed: ${extracted.chunks?.length ?? 0} chunks`);
        } else {
          uploadSummaries.push(`📄 ${asset.name}\nCould not be text-indexed`);
        }

        // Check for scanned PDF or stale document date
        const contentForChecks = extracted.content || "";
        const scannedWarning = detectScannedPDF(contentForChecks, asset.name);
        const dateWarning = detectDocumentDate(contentForChecks, asset.name);
        if (scannedWarning) {
          Alert.alert("⚠️ Scanned Document Warning", scannedWarning, [{ text: "OK" }]);
        }
        if (dateWarning) {
          Alert.alert("⚠️ Document Date Warning", dateWarning, [{ text: "OK" }]);
        }
      }

      if (uploadSummaries.length > 0) {
        Alert.alert(
          "Documents Indexed",
          uploadSummaries.join("\n\n"),
          [{ text: "OK" }]
        );
      }
    } catch (e) {
      Alert.alert("Error", "Could not pick document. Please try again.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = (doc: RagDocument) => {
    if (Platform.OS === "web") {
      const confirmed = window.confirm(
        `Delete "${doc.name}"?\n\nThis will remove the document and all its indexed content from the knowledge base.`
      );
      if (confirmed) {
        deleteRagDocument(doc.id);
      }
      return;
    }
    Alert.alert(
      "Delete Document",
      `Are you sure you want to delete "${doc.name}"?\n\nThis will remove the document and all its indexed content from the knowledge base.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Yes, Delete",
          style: "destructive",
          onPress: () => {
            deleteRagDocument(doc.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
      ]
    );
  };

  const filtered = ragDocuments.filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase())
  );

  const getFileIcon = (type: string): string => {
    if (type.includes("pdf")) return "file-text";
    if (type.includes("word") || type.includes("document")) return "file";
    if (type.includes("excel") || type.includes("sheet")) return "grid";
    if (type.includes("image")) return "image";
    if (type.includes("text")) return "align-left";
    return "file";
  };

  const getFileColor = (type: string) => {
    if (type.includes("pdf")) return "#ef4444";
    if (type.includes("word") || type.includes("document")) return "#3b82f6";
    if (type.includes("excel") || type.includes("sheet")) return "#22c55e";
    if (type.includes("image")) return "#f59e0b";
    return "#64748b";
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
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
        <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
          <Feather name="book" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Document Library</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {ragDocuments.length} document{ragDocuments.length !== 1 ? "s" : ""} in knowledge base
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: colors.primary }]}
          onPress={handleAddDocument}
          disabled={isUploading}
          activeOpacity={0.8}
        >
          <Feather name={isUploading ? "loader" : "plus"} size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Violation Detection Toggle */}
      <View style={[styles.violationRow, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border }]}>
        <View style={styles.violationLabelRow}>
          <View style={[styles.violationDot, { backgroundColor: violationCheckEnabled ? "#22c55e" : "#94a3b8" }]} />
          <Text style={[styles.violationLabel, { color: colors.foreground }]}>Violation Detection</Text>
          <Text style={[styles.violationSub, { color: colors.mutedForeground }]}>
            {violationCheckEnabled ? "ON" : "OFF"}
          </Text>
        </View>
        <Switch
          value={violationCheckEnabled}
          onValueChange={handleViolationToggle}
          trackColor={{ false: "#94a3b8", true: "#22c55e" }}
          thumbColor="#fff"
        />
      </View>

      <View style={[styles.searchContainer, { backgroundColor: colors.headerBackground, paddingHorizontal: 16, paddingVertical: 12, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
        <View style={[styles.searchBar, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Search documents... / بحث"
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "20" }]}>
            <Feather name="book-open" size={48} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Knowledge Base Empty</Text>
          <Text style={[styles.emptyTitleAr, { color: colors.primary }]}>قاعدة المعرفة فارغة</Text>
          <Text style={[styles.emptyDesc, { color: colors.mutedForeground }]}>
            Upload NEBOSH books, OSHA guides, safety manuals, company SOPs, regulations, photos, and more.
          </Text>
          <Text style={[styles.emptySupportedTypes, { color: colors.mutedForeground }]}>
            Supported: PDF • Word • Excel • Text • Images
          </Text>
          <TouchableOpacity
            style={[styles.emptyAddButton, { backgroundColor: colors.primary }]}
            onPress={handleAddDocument}
            activeOpacity={0.8}
          >
            <Feather name="upload" size={20} color="#fff" />
            <Text style={styles.emptyAddText}>Upload Documents</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 20 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={[styles.uploadMoreButton, { borderColor: colors.primary }]}
            onPress={handleAddDocument}
            activeOpacity={0.8}
          >
            <Feather name="upload" size={16} color={colors.primary} />
            <Text style={[styles.uploadMoreText, { color: colors.primary }]}>Upload More Documents</Text>
          </TouchableOpacity>

          {filtered.map((doc) => (
            <View
              key={doc.id}
              style={[styles.docCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[styles.docIconContainer, { backgroundColor: getFileColor(doc.type) + "20" }]}>
                <Feather
                  name={getFileIcon(doc.type) as any}
                  size={24}
                  color={getFileColor(doc.type)}
                />
              </View>
              <View style={styles.docInfo}>
                <Text style={[styles.docName, { color: colors.foreground }]} numberOfLines={2}>
                  {doc.name}
                </Text>
                <View style={styles.docMeta}>
                  {doc.size > 0 && (
                    <Text style={[styles.docSize, { color: colors.mutedForeground }]}>
                      {formatSize(doc.size)}
                    </Text>
                  )}
                  {doc.indexed && (
                    <View style={[styles.indexedBadge, { backgroundColor: colors.success + "20" }]}>
                      <Feather name="check-circle" size={10} color={colors.success} />
                      <Text style={[styles.indexedText, { color: colors.success }]}>Indexed</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.docDate, { color: colors.mutedForeground }]}>
                  Added {new Date(doc.addedAt).toLocaleDateString()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleDelete(doc)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Feather name="trash-2" size={18} color={colors.destructive} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}
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
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  searchContainer: {},
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  emptyTitleAr: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyDesc: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  emptySupportedTypes: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyAddButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  emptyAddText: { fontSize: 15, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  listContent: { padding: 16, gap: 10 },
  uploadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
    paddingVertical: 14,
    marginBottom: 6,
  },
  uploadMoreText: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  docCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  docIconContainer: {
    width: 50,
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  docInfo: { flex: 1, gap: 4 },
  docName: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  docMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  docSize: { fontSize: 12, fontFamily: "Inter_400Regular" },
  indexedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  indexedText: { fontSize: 10, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  docDate: { fontSize: 11, fontFamily: "Inter_400Regular" },
  violationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  violationLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  violationDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  violationLabel: {
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
  violationSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
});
