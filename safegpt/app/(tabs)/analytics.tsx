import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState, useMemo } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, AnalyticsRecord } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

const EVENT_TYPES = [
  { id: "incident",  label: "Incident",    labelAr: "حادث",          icon: "alert-octagon",  color: "#ef4444" },
  { id: "accident",  label: "Accident",    labelAr: "حادث خطير",     icon: "alert-circle",   color: "#dc2626" },
  { id: "near_miss", label: "Near Miss",   labelAr: "اشتباه خطر",    icon: "alert-triangle", color: "#f59e0b" },
  { id: "violation", label: "Violation",   labelAr: "مخالفة",        icon: "x-circle",       color: "#8b5cf6" },
  { id: "fine",      label: "Fine Issued", labelAr: "غرامة",         icon: "dollar-sign",    color: "#f97316" },
  { id: "other",     label: "Other",       labelAr: "حدث آخر",       icon: "plus-circle",    color: "#64748b" },
];

function recordsToCsv(records: AnalyticsRecord[]): string {
  const headers = ["ID", "Type", "Severity", "Description", "Person Name", "Location", "Date"];
  const rows = records.map((r) => [
    r.id,
    r.type,
    r.severity || "",
    `"${(r.description || "").replace(/"/g, '""')}"`,
    `"${(r.personName || "").replace(/"/g, '""')}"`,
    `"${(r.location || "").replace(/"/g, '""')}"`,
    new Date(r.date).toLocaleString(),
  ]);
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function downloadCsv(csv: string, filename: string) {
  if (Platform.OS === "web") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } else {
    Alert.alert("Export", csv.length > 500 ? csv.slice(0, 500) + "\n...(truncated)" : csv);
  }
}

type ExportScope = "all" | "month" | "year";

export default function AnalyticsScreen() {
  const { analyticsRecords, deleteAnalyticsRecord, projectInfo, activeSite } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportScope, setExportScope]       = useState<ExportScope>("all");
  const [selectedMonth, setSelectedMonth]   = useState<string | null>(null);
  const [selectedYear, setSelectedYear]     = useState<string | null>(null);

  const availableMonths = useMemo(() => {
    const seen = new Set<string>();
    analyticsRecords.forEach((r) => {
      const d = new Date(r.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      seen.add(key);
    });
    return Array.from(seen).sort().reverse().map((key) => {
      const [y, m] = key.split("-");
      const label = new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
      return { key, label };
    });
  }, [analyticsRecords]);

  const availableYears = useMemo(() => {
    const seen = new Set<string>();
    analyticsRecords.forEach((r) => {
      seen.add(String(new Date(r.date).getFullYear()));
    });
    return Array.from(seen).sort().reverse();
  }, [analyticsRecords]);

  const handleBulkExport = () => {
    let filtered: AnalyticsRecord[] = [];
    let filename = "safegpt-events-all.csv";

    if (exportScope === "all") {
      filtered = analyticsRecords;
      filename = "safegpt-events-all.csv";
    } else if (exportScope === "month" && selectedMonth) {
      filtered = analyticsRecords.filter((r) => {
        const d = new Date(r.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        return key === selectedMonth;
      });
      filename = `safegpt-events-${selectedMonth}.csv`;
    } else if (exportScope === "year" && selectedYear) {
      filtered = analyticsRecords.filter((r) => String(new Date(r.date).getFullYear()) === selectedYear);
      filename = `safegpt-events-${selectedYear}.csv`;
    } else {
      Alert.alert("Select a filter", "Please select a month or year to export.");
      return;
    }

    if (filtered.length === 0) {
      Alert.alert("No Records", "No records found for the selected period.");
      return;
    }

    const csv = recordsToCsv(filtered);
    downloadCsv(csv, filename);
    setShowExportModal(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleSingleExport = (record: AnalyticsRecord) => {
    const t = EVENT_TYPES.find((e) => e.id === record.type) || EVENT_TYPES[5];
    const csv = recordsToCsv([record]);
    const safeDate = new Date(record.date).toISOString().slice(0, 10);
    downloadCsv(csv, `safegpt-${t.label.toLowerCase().replace(/\s/g, "-")}-${safeDate}.csv`);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleDelete = (record: AnalyticsRecord) => {
    Alert.alert("Delete Record", "Remove this event from analytics?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteAnalyticsRecord(record.id);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      },
    ]);
  };

  const counts = EVENT_TYPES.reduce((acc, t) => {
    acc[t.id] = analyticsRecords.filter((r) => r.type === t.id).length;
    return acc;
  }, {} as Record<string, number>);

  const currentMonth = new Date().toLocaleString("default", { month: "long", year: "numeric" });
  const severityColor = (s?: string) =>
    s === "high" ? "#ef4444" : s === "medium" ? "#f59e0b" : "#10b981";
  const typeInfo = (type: string) => EVENT_TYPES.find((t) => t.id === type) || EVENT_TYPES[5];

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
        <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
          <Feather name="bar-chart-2" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Analytics</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>التحليلات — {currentMonth}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Site info */}
        {projectInfo?.companyName || activeSite ? (
          <View style={[styles.siteInfo, { backgroundColor: colors.secondary + "20", borderColor: colors.secondary + "40" }]}>
            <Feather name="map-pin" size={14} color={colors.secondary} />
            <Text style={[styles.siteInfoText, { color: colors.foreground }]}>
              {projectInfo?.companyName && `${projectInfo.companyName} · `}
              {activeSite ? activeSite.name : projectInfo?.siteName || "No site selected"}
            </Text>
          </View>
        ) : null}

        {/* Monthly summary */}
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Monthly Summary / ملخص الشهر</Text>
        <View style={styles.statsGrid}>
          {EVENT_TYPES.map((type) => (
            <View key={type.id} style={[styles.statCard, { backgroundColor: colors.card, borderColor: type.color + "30" }]}>
              <View style={[styles.statIcon, { backgroundColor: type.color + "20" }]}>
                <Feather name={type.icon as any} size={20} color={type.color} />
              </View>
              <Text style={[styles.statCount, { color: type.color }]}>{counts[type.id]}</Text>
              <Text style={[styles.statLabel, { color: colors.foreground }]}>{type.label}</Text>
              <Text style={[styles.statLabelAr, { color: colors.mutedForeground }]}>{type.labelAr}</Text>
            </View>
          ))}
        </View>

        {/* Events log */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Events Log ({analyticsRecords.length})
          </Text>
          <TouchableOpacity
            style={[styles.downloadBtn, { backgroundColor: colors.primary + "20" }]}
            onPress={() => {
              setExportScope("all");
              setSelectedMonth(null);
              setSelectedYear(null);
              setShowExportModal(true);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Feather name="download" size={14} color={colors.primary} />
            <Text style={[styles.downloadText, { color: colors.primary }]}>Export</Text>
          </TouchableOpacity>
        </View>

        {analyticsRecords.length === 0 ? (
          <View style={[styles.emptyRecords, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="inbox" size={36} color={colors.mutedForeground} />
            <Text style={[styles.emptyRecordsText, { color: colors.mutedForeground }]}>No events recorded</Text>
            <Text style={[styles.emptyRecordsAr, { color: colors.mutedForeground }]}>لا توجد أحداث مسجلة</Text>
          </View>
        ) : (
          analyticsRecords
            .slice()
            .reverse()
            .map((record) => {
              const t = typeInfo(record.type);
              return (
                <View key={record.id} style={[styles.recordCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={[styles.recordIcon, { backgroundColor: t.color + "20" }]}>
                    <Feather name={t.icon as any} size={18} color={t.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.recordTopRow}>
                      <Text style={[styles.recordType, { color: t.color }]}>
                        {record.type === "other" && (record as any).customEventName
                          ? (record as any).customEventName
                          : t.label}
                      </Text>
                      {record.severity && (
                        <View style={[styles.severityPill, { backgroundColor: severityColor(record.severity) + "20" }]}>
                          <Text style={[styles.severityPillText, { color: severityColor(record.severity) }]}>
                            {record.severity.toUpperCase()}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.recordDesc, { color: colors.foreground }]}>{record.description}</Text>
                    {record.personName ? (
                      <Text style={[styles.recordMeta, { color: colors.mutedForeground }]}>👤 {record.personName}</Text>
                    ) : null}
                    {record.location ? (
                      <Text style={[styles.recordMeta, { color: colors.mutedForeground }]}>📍 {record.location}</Text>
                    ) : null}
                    <Text style={[styles.recordDate, { color: colors.mutedForeground }]}>
                      {new Date(record.date).toLocaleDateString()}{" "}
                      {new Date(record.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                  <View style={styles.recordActions}>
                    <TouchableOpacity
                      style={[styles.recordActionBtn, { backgroundColor: colors.primary + "15" }]}
                      onPress={() => handleSingleExport(record)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Feather name="download" size={14} color={colors.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.recordActionBtn, { backgroundColor: "#ef444415" }]}
                      onPress={() => handleDelete(record)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Feather name="trash-2" size={14} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
        )}
      </ScrollView>

      {/* Export Modal */}
      <Modal
        visible={showExportModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowExportModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.exportModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Modal Header */}
            <View style={[styles.exportModalHeader, { borderBottomColor: colors.border }]}>
              <View style={[styles.exportModalIcon, { backgroundColor: colors.primary + "20" }]}>
                <Feather name="download" size={18} color={colors.primary} />
              </View>
              <Text style={[styles.exportModalTitle, { color: colors.foreground }]}>Export Reports</Text>
              <TouchableOpacity onPress={() => setShowExportModal(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false}>
              <View style={styles.exportModalBody}>
                {/* Scope selector */}
                <Text style={[styles.exportLabel, { color: colors.mutedForeground }]}>Select export range:</Text>
                <View style={styles.scopeRow}>
                  {(["all", "month", "year"] as ExportScope[]).map((scope) => (
                    <TouchableOpacity
                      key={scope}
                      style={[
                        styles.scopeBtn,
                        {
                          backgroundColor: exportScope === scope ? colors.primary : colors.muted,
                          borderColor: exportScope === scope ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() => {
                        setExportScope(scope);
                        setSelectedMonth(null);
                        setSelectedYear(null);
                      }}
                      activeOpacity={0.75}
                    >
                      <Feather
                        name={scope === "all" ? "archive" : scope === "month" ? "calendar" : "clock"}
                        size={14}
                        color={exportScope === scope ? "#fff" : colors.foreground}
                      />
                      <Text style={[styles.scopeBtnText, { color: exportScope === scope ? "#fff" : colors.foreground }]}>
                        {scope === "all" ? "All Records" : scope === "month" ? "By Month" : "By Year"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Month picker */}
                {exportScope === "month" && (
                  <View style={styles.pickerSection}>
                    <Text style={[styles.exportLabel, { color: colors.mutedForeground }]}>Select month:</Text>
                    {availableMonths.length === 0 ? (
                      <Text style={[styles.noDataText, { color: colors.mutedForeground }]}>No records available</Text>
                    ) : (
                      availableMonths.map((m) => (
                        <TouchableOpacity
                          key={m.key}
                          style={[
                            styles.pickerItem,
                            {
                              backgroundColor: selectedMonth === m.key ? colors.primary + "20" : colors.background,
                              borderColor: selectedMonth === m.key ? colors.primary : colors.border,
                            },
                          ]}
                          onPress={() => setSelectedMonth(m.key)}
                          activeOpacity={0.7}
                        >
                          <Feather name="calendar" size={14} color={selectedMonth === m.key ? colors.primary : colors.mutedForeground} />
                          <Text style={[styles.pickerItemText, { color: selectedMonth === m.key ? colors.primary : colors.foreground }]}>
                            {m.label}
                          </Text>
                          {selectedMonth === m.key && <Feather name="check" size={14} color={colors.primary} />}
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {/* Year picker */}
                {exportScope === "year" && (
                  <View style={styles.pickerSection}>
                    <Text style={[styles.exportLabel, { color: colors.mutedForeground }]}>Select year:</Text>
                    {availableYears.length === 0 ? (
                      <Text style={[styles.noDataText, { color: colors.mutedForeground }]}>No records available</Text>
                    ) : (
                      availableYears.map((yr) => (
                        <TouchableOpacity
                          key={yr}
                          style={[
                            styles.pickerItem,
                            {
                              backgroundColor: selectedYear === yr ? colors.primary + "20" : colors.background,
                              borderColor: selectedYear === yr ? colors.primary : colors.border,
                            },
                          ]}
                          onPress={() => setSelectedYear(yr)}
                          activeOpacity={0.7}
                        >
                          <Feather name="clock" size={14} color={selectedYear === yr ? colors.primary : colors.mutedForeground} />
                          <Text style={[styles.pickerItemText, { color: selectedYear === yr ? colors.primary : colors.foreground }]}>
                            {yr}
                          </Text>
                          {selectedYear === yr && <Feather name="check" size={14} color={colors.primary} />}
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}

                {/* Summary */}
                {exportScope === "all" && (
                  <View style={[styles.exportSummary, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}>
                    <Feather name="info" size={14} color={colors.primary} />
                    <Text style={[styles.exportSummaryText, { color: colors.foreground }]}>
                      Exports all {analyticsRecords.length} record{analyticsRecords.length !== 1 ? "s" : ""} as CSV
                    </Text>
                  </View>
                )}
              </View>
            </ScrollView>

            {/* Export button */}
            <View style={[styles.exportModalFooter, { borderTopColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.cancelBtn, { borderColor: colors.border }]}
                onPress={() => setShowExportModal(false)}
                activeOpacity={0.7}
              >
                <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.exportBtn, { backgroundColor: colors.primary }]}
                onPress={handleBulkExport}
                activeOpacity={0.85}
              >
                <Feather name="download" size={15} color="#fff" />
                <Text style={styles.exportBtnText}>Export CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingBottom: 16, paddingTop: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 12,
  },
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontWeight: "700", fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular" },
  content: { padding: 16, gap: 16 },
  siteInfo: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8,
  },
  siteInfoText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  quickActions: {
    borderRadius: 16, borderWidth: 1, padding: 16, gap: 12,
  },
  quickActionsTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  quickActionsSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: -4 },
  quickBtns: { flexDirection: "row", gap: 10 },
  quickBtn: {
    flex: 1, borderRadius: 12, padding: 14, alignItems: "center", gap: 4,
  },
  quickBtnText: { fontSize: 13, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  quickBtnSub: { fontSize: 10, color: "rgba(255,255,255,0.75)", fontFamily: "Inter_400Regular", textAlign: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  downloadBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  downloadText: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: {
    borderRadius: 14, borderWidth: 1, padding: 12, alignItems: "center",
    gap: 5, flex: 1, minWidth: "28%",
  },
  statIcon: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  statCount: { fontSize: 26, fontWeight: "700", fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold", textAlign: "center" },
  statLabelAr: { fontSize: 10, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyRecords: { borderRadius: 14, borderWidth: 1, padding: 32, alignItems: "center", gap: 10 },
  emptyRecordsText: { fontSize: 15, fontFamily: "Inter_400Regular" },
  emptyRecordsAr: { fontSize: 13, fontFamily: "Inter_400Regular" },
  recordCard: {
    flexDirection: "row", alignItems: "flex-start",
    borderRadius: 14, borderWidth: 1, padding: 14, gap: 12,
  },
  recordIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  recordTopRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  recordType: { fontSize: 12, fontWeight: "700", fontFamily: "Inter_700Bold" },
  recordDesc: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  recordMeta: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  recordDate: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 4 },
  severityPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  severityPillText: { fontSize: 9, fontWeight: "700", fontFamily: "Inter_700Bold" },
  recordActions: { flexDirection: "column", gap: 6, alignItems: "center", paddingTop: 2 },
  recordActionBtn: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  // Export Modal
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  exportModal: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderWidth: 1, borderBottomWidth: 0,
    overflow: "hidden",
  },
  exportModalHeader: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  exportModalIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  exportModalTitle: { flex: 1, fontSize: 17, fontWeight: "700", fontFamily: "Inter_700Bold" },
  exportModalBody: { padding: 20, gap: 16 },
  exportLabel: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
  scopeRow: { flexDirection: "row", gap: 8 },
  scopeBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 10, paddingHorizontal: 6,
    borderRadius: 10, borderWidth: 1,
  },
  scopeBtnText: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold", textAlign: "center" },
  pickerSection: { gap: 8 },
  pickerItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12,
  },
  pickerItemText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
  noDataText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", paddingVertical: 8 },
  exportSummary: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 10, borderWidth: 1, padding: 12,
  },
  exportSummaryText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular" },
  exportModalFooter: {
    flexDirection: "row", gap: 10,
    paddingHorizontal: 20, paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelBtn: {
    flex: 1, borderRadius: 12, paddingVertical: 14,
    alignItems: "center", borderWidth: 1,
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  exportBtn: {
    flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 12, paddingVertical: 14,
  },
  exportBtnText: { fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
});
