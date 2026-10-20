import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { LinearGradient } from "expo-linear-gradient";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callAI, speakEnglish, stopSpeech, isTtsSpeaking } from "@/services/aiService";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

const STORAGE_KEY = "live_inspection_alerts";
const SCAN_INTERVAL_MS = 10000;

interface HazardAlert {
  id: string;
  text: string;
  severity: "low" | "medium" | "high";
  timestamp: number;
}


export default function LiveInspectionScreen() {
  const { apiKeys } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();
  const [permission, requestPermission] = useCameraPermissions();
  const [isActive, setIsActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [alerts, setAlerts] = useState<HazardAlert[]>([]);
  const [query, setQuery] = useState("");
  const [scanCount, setScanCount] = useState(0);
  const cameraRef = useRef<any>(null);
  const scanIntervalRef = useRef<any>(null);
  const isCapturingRef = useRef(false);

  // ── Load saved alerts on mount ─────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((data) => {
      if (data) {
        try { setAlerts(JSON.parse(data)); } catch { /* corrupt data */ }
      }
    });
  }, []);

  // ── Persist alerts whenever they change ───────────────────────────────────
  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(alerts)).catch(() => {});
  }, [alerts]);

  // ── Capture + analyze one frame ───────────────────────────────────────────
  const captureAndAnalyze = useCallback(async (userQuery?: string) => {
    if (!cameraRef.current || isCapturingRef.current) return;
    isCapturingRef.current = true;
    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.45,
      });

      const prompt = userQuery
        ? `Live camera inspection — ${userQuery}. Identify all immediate safety hazards visible.`
        : `Live camera safety inspection of a construction site. List ALL visible hazards concisely. ` +
          `For each hazard write one short line starting with the severity label (LOW / MEDIUM / HIGH / CRITICAL). ` +
          `Examples: "HIGH: Worker not wearing helmet", "MEDIUM: No guardrail on scaffolding". ` +
          `If no hazards are visible write: CLEAR: No hazards detected.`;

      const { content } = await callAI(apiKeys, prompt, [], photo.base64);

      const isClear =
        content.toLowerCase().includes("no hazard") ||
        content.toLowerCase().includes("clear:") ||
        content.toLowerCase().includes("none detected");

      if (!isClear) {
        const lines = content
          .split("\n")
          .map((l: string) => l.trim())
          .filter((l: string) => l.length > 0 && !l.toLowerCase().startsWith("clear"));

        const newAlerts: HazardAlert[] = lines.slice(0, 5).map((line: string, i: number) => {
          const upper = line.toUpperCase();
          const severity: "low" | "medium" | "high" =
            upper.includes("CRITICAL") || upper.includes("HIGH") ? "high"
            : upper.includes("MEDIUM") ? "medium"
            : "low";
          return {
            id: `${Date.now()}_${i}`,
            text: line.replace(/^(CRITICAL|HIGH|MEDIUM|LOW)\s*[:–—-]\s*/i, "").trim(),
            severity,
            timestamp: Date.now(),
          };
        });

        if (newAlerts.length > 0) {
          setAlerts((prev) => [...newAlerts, ...prev].slice(0, 30));
          setScanCount((c) => c + 1);

          // ── Speak the highest-severity warning ──────────────────────────
          const topAlert =
            newAlerts.find((a) => a.severity === "high") ||
            newAlerts.find((a) => a.severity === "medium") ||
            newAlerts[0];

          if (topAlert && !isTtsSpeaking()) {
            speakEnglish(
              `Warning: ${topAlert.text}`,
              `live_${Date.now()}`
            );
          }
        }
      }
    } catch (e: any) {
      const errAlert: HazardAlert = {
        id: `err_${Date.now()}`,
        text: "Scan error: " + (e.message || "Check API keys").slice(0, 80),
        severity: "low",
        timestamp: Date.now(),
      };
      setAlerts((prev) => [errAlert, ...prev].slice(0, 30));
    } finally {
      isCapturingRef.current = false;
      setIsCapturing(false);
    }
  }, [apiKeys]);

  // ── Auto-scan loop: start when camera becomes active, stop when closed ────
  useEffect(() => {
    if (isActive) {
      // First scan immediately
      captureAndAnalyze();
      // Then every SCAN_INTERVAL_MS
      scanIntervalRef.current = setInterval(() => {
        captureAndAnalyze();
      }, SCAN_INTERVAL_MS);
    } else {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      stopSpeech();
    }
    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, [isActive, captureAndAnalyze]);

  // ── Delete all warnings (in-memory + persisted) ───────────────────────────
  const clearAlerts = useCallback(() => {
    setAlerts([]);
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  if (!permission) {
    return (
      <View style={[styles.permContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.permContainer, { backgroundColor: colors.background }]}>
        <Feather name="camera-off" size={48} color={colors.mutedForeground} />
        <Text style={[styles.permTitle, { color: colors.foreground }]}>Camera Access Required</Text>
        <Text style={[styles.permSubtitle, { color: colors.mutedForeground }]}>
          Live inspection requires camera permission
        </Text>
        <TouchableOpacity
          style={[styles.permButton, { backgroundColor: colors.primary }]}
          onPress={requestPermission}
        >
          <Text style={styles.permButtonText}>Grant Camera Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const severityColor = (s: "low" | "medium" | "high") =>
    s === "high" ? colors.destructive : s === "medium" ? colors.warning : colors.success;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {isActive ? (
        // ── Active camera view ───────────────────────────────────────────────
        <View style={{ flex: 1 }}>
          <CameraView ref={cameraRef} style={styles.camera} facing={Platform.OS === "web" ? "front" : "back"}>
            <View style={styles.cameraOverlay}>
              {/* Header */}
              <View style={[styles.cameraHeader, { paddingTop: insets.top + 16 }]}>
                <View style={styles.scanningIndicator}>
                  <View style={[styles.scanDot, { backgroundColor: isCapturing ? "#f59e0b" : "#22c55e" }]} />
                  <Text style={styles.scanningText}>
                    {isCapturing ? "ANALYZING..." : "AUTO-SCANNING"}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.closeCamera}
                  onPress={() => setIsActive(false)}
                >
                  <Feather name="x" size={20} color="#fff" />
                </TouchableOpacity>
              </View>

              {/* Live alert badges */}
              <View style={[styles.alertsOverlay, { maxHeight: 220 }]}>
                {alerts.slice(0, 4).map((alert) => (
                  <View
                    key={alert.id}
                    style={[styles.alertBadge, { backgroundColor: severityColor(alert.severity) + "DD" }]}
                  >
                    <Feather name="alert-triangle" size={12} color="#fff" />
                    <Text style={styles.alertBadgeText} numberOfLines={2}>
                      {alert.text}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Scan counter + query row */}
              <View style={styles.cameraControls}>
                <Text style={styles.scanCounter}>
                  {scanCount > 0 ? `${scanCount} hazard event${scanCount > 1 ? "s" : ""} detected · scans every 10s` : "Scanning every 10s..."}
                </Text>
                <View style={[styles.queryRow, { backgroundColor: "rgba(0,0,0,0.7)" }]}>
                  <TextInput
                    style={styles.cameraInput}
                    placeholder="Ask about what you see..."
                    placeholderTextColor="rgba(255,255,255,0.5)"
                    value={query}
                    onChangeText={setQuery}
                  />
                  <TouchableOpacity
                    style={[styles.queryBtn, { backgroundColor: colors.primary, opacity: isCapturing ? 0.6 : 1 }]}
                    onPress={() => { captureAndAnalyze(query); setQuery(""); }}
                    disabled={isCapturing}
                  >
                    <Feather name="send" size={16} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </CameraView>
        </View>
      ) : (
        // ── Home view ────────────────────────────────────────────────────────
        <View style={{ flex: 1 }}>
          <View
            style={[
              styles.header,
              {
                backgroundColor: colors.headerBackground,
                borderBottomColor: colors.border,
                paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12),
                paddingHorizontal: 8,
              },
            ]}
          >
            <View style={{ width: hamburgerOffset + 4 }} />
            <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="aperture" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headerTitle, { color: colors.foreground }]}>Live Inspection</Text>
              <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>الفحص المباشر</Text>
            </View>
            {alerts.length > 0 && (
              <TouchableOpacity onPress={clearAlerts} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Feather name="trash-2" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.startSection}>
            <View style={[styles.startIconContainer, { backgroundColor: colors.primary + "15" }]}>
              <Feather name="aperture" size={60} color={colors.primary} />
            </View>
            <Text style={[styles.startTitle, { color: colors.foreground }]}>Live Camera Inspection</Text>
            <Text style={[styles.startTitleAr, { color: colors.primary }]}>الفحص المباشر بالكاميرا</Text>
            <Text style={[styles.startDesc, { color: colors.mutedForeground }]}>
              Point your camera at the site. SafeGPT will automatically scan every 10 seconds
              and speak hazard warnings aloud using Gemini Vision AI.
            </Text>

            <TouchableOpacity
              style={[styles.startButton, { backgroundColor: colors.primary }]}
              onPress={() => setIsActive(true)}
              activeOpacity={0.8}
            >
              <Feather name="aperture" size={20} color="#fff" />
              <Text style={styles.startButtonText}>Start Live Inspection</Text>
            </TouchableOpacity>
          </View>

          {alerts.length > 0 && (
            <ScrollView
              contentContainerStyle={[styles.alertsList, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 20 }]}
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.alertsTitle, { color: colors.foreground }]}>
                Detected Hazards ({alerts.length})
              </Text>
              {alerts.map((alert) => (
                <View
                  key={alert.id}
                  style={[
                    styles.alertItem,
                    { backgroundColor: colors.card, borderColor: severityColor(alert.severity) + "40", borderWidth: 1 },
                  ]}
                >
                  <View style={[styles.alertSeverityBar, { backgroundColor: severityColor(alert.severity) }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.alertItemText, { color: colors.foreground }]}>{alert.text}</Text>
                    <Text style={[styles.alertTime, { color: colors.mutedForeground }]}>
                      {new Date(alert.timestamp).toLocaleTimeString()}
                    </Text>
                  </View>
                  <View style={[styles.severityBadge, { backgroundColor: severityColor(alert.severity) + "20" }]}>
                    <Text style={[styles.severityBadgeText, { color: severityColor(alert.severity) }]}>
                      {alert.severity.toUpperCase()}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  permContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  permTitle: { fontSize: 20, fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  permSubtitle: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  permButton: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14 },
  permButtonText: { fontSize: 15, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
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
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular" },
  startSection: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  startIconContainer: { width: 130, height: 130, borderRadius: 65, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  startTitle: { fontSize: 22, fontWeight: "700", fontFamily: "Inter_700Bold", textAlign: "center" },
  startTitleAr: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center" },
  startDesc: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  startButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 16,
    marginTop: 8,
  },
  startButtonText: { fontSize: 16, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  alertsList: { padding: 16, gap: 10 },
  alertsTitle: { fontSize: 16, fontWeight: "700", fontFamily: "Inter_700Bold", marginBottom: 6 },
  alertItem: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    padding: 12,
    overflow: "hidden",
    gap: 10,
  },
  alertSeverityBar: { width: 4, height: "100%", borderRadius: 2, minHeight: 40 },
  alertItemText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  alertTime: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  severityBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, alignSelf: "flex-start" },
  severityBadgeText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold" },
  camera: { flex: 1 },
  cameraOverlay: { flex: 1, backgroundColor: "transparent", justifyContent: "space-between" },
  cameraHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  scanningIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  scanDot: { width: 8, height: 8, borderRadius: 4 },
  scanningText: { fontSize: 12, fontWeight: "700", color: "#fff", letterSpacing: 1 },
  closeCamera: { backgroundColor: "rgba(0,0,0,0.6)", padding: 10, borderRadius: 20 },
  alertsOverlay: { marginHorizontal: 16, gap: 6 },
  alertBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  alertBadgeText: { fontSize: 12, color: "#fff", fontFamily: "Inter_600SemiBold", flex: 1 },
  cameraControls: { gap: 10, paddingHorizontal: 16, paddingBottom: 40 },
  scanCounter: { fontSize: 11, color: "rgba(255,255,255,0.7)", textAlign: "center", fontFamily: "Inter_400Regular" },
  queryRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  cameraInput: { flex: 1, fontSize: 14, color: "#fff", fontFamily: "Inter_400Regular" },
  queryBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
