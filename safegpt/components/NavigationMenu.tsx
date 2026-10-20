import { Feather } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import React, { useRef, useEffect } from "react";
import {
  Animated, Dimensions, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { moderateScale } from "@/hooks/useResponsive";

const { width: SW } = Dimensions.get("window");
const PANEL_W = Math.min(SW * 0.82, 320);

export const NAV_ITEMS = [
  { name: "chat",      title: "Chat Assistant",      titleAr: "المحادثة",              icon: "message-circle", color: "#FF6B35" },
  { name: "emergency", title: "Emergency Response",  titleAr: "استجابة الطوارئ",      icon: "alert-triangle", color: "#ef4444" },
  { name: "toolkit",   title: "AI Safety Toolkit",   titleAr: "أدوات السلامة بالذكاء", icon: "tool",          color: "#FF6B35" },
  { name: "voice",     title: "Voice",               titleAr: "الصوت",                icon: "mic",            color: "#3b82f6" },
  { name: "image",     title: "Image Analysis",      titleAr: "تحليل الصور",          icon: "camera",         color: "#8b5cf6" },
  { name: "video",     title: "Video Analysis",      titleAr: "تحليل الفيديو",        icon: "video",          color: "#ec4899" },
  { name: "live",      title: "Live Inspection",     titleAr: "الكاميرا المباشرة",    icon: "aperture",       color: "#ef4444" },
  { name: "reports",   title: "Reports",             titleAr: "التقارير",             icon: "file-text",      color: "#f59e0b" },
  { name: "documents", title: "Documents / RAG",     titleAr: "المستندات",            icon: "book",           color: "#10b981" },
  { name: "analytics", title: "Analytics",           titleAr: "التحليلات",            icon: "bar-chart-2",    color: "#06b6d4" },
  { name: "models",    title: "Model Status",        titleAr: "حالة النماذج",         icon: "activity",       color: "#22d3ee" },
  { name: "settings",  title: "Settings",            titleAr: "الإعدادات",            icon: "settings",       color: "#64748b" },
];

// ─── Shared nav-item list renderer ────────────────────────────────────────────
function NavItemList({
  currentTab,
  onNavigate,
}: {
  currentTab: string;
  onNavigate: (name: string) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView
      style={{ flex: 1 }}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ gap: 4, paddingTop: 12 }}
    >
      {NAV_ITEMS.map((item) => {
        const isActive = currentTab === item.name;
        return (
          <TouchableOpacity
            key={item.name}
            style={[
              styles.navItem,
              { borderColor: isActive ? item.color + "40" : "transparent" },
              isActive && { backgroundColor: item.color + "18" },
            ]}
            onPress={() => onNavigate(item.name)}
            activeOpacity={0.75}
          >
            <View style={[styles.navIcon, { backgroundColor: item.color + "20" }]}>
              <Feather name={item.icon as any} size={moderateScale(17)} color={item.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.navTitle, { color: isActive ? item.color : colors.foreground }]}>
                {item.title}
              </Text>
              <Text style={[styles.navTitleAr, { color: colors.mutedForeground }]}>{item.titleAr}</Text>
            </View>
            {isActive && <Feather name="chevron-right" size={14} color={item.color} />}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Permanent sidebar (desktop) ──────────────────────────────────────────────
export function SideBarPanel({ width = 240 }: { width?: number }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const currentTab = pathname.split("/").pop() || "chat";

  const handleNavigate = (tabName: string) => {
    router.push(`/(tabs)/${tabName}` as any);
  };

  return (
    <View
      style={[
        sidebarStyles.container,
        {
          width,
          backgroundColor: colors.background,
          borderRightColor: colors.border,
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 16,
        },
      ]}
    >
      {/* Logo header */}
      <View style={[sidebarStyles.header, { borderBottomColor: colors.border }]}>
        <View style={[sidebarStyles.logoIcon, { backgroundColor: "#FF6B3520" }]}>
          <Feather name="shield" size={20} color="#FF6B35" />
        </View>
        <Text style={[sidebarStyles.logoText, { color: colors.foreground }]}>SafeGPT</Text>
      </View>

      <NavItemList currentTab={currentTab} onNavigate={handleNavigate} />

      {/* Footer */}
      <View style={[sidebarStyles.footer, { borderTopColor: colors.border }]}>
        <Text style={[sidebarStyles.footerText, { color: colors.mutedForeground }]}>
          SafeGPT · Construction H&S AI
        </Text>
      </View>
    </View>
  );
}

const sidebarStyles = StyleSheet.create({
  container: {
    borderRightWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  logoIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  logoText: { fontSize: 20, fontWeight: "700", fontFamily: "Inter_700Bold" },
  footer: { paddingHorizontal: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  footerText: { fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center" },
});

// ─── Hamburger slide-in modal (phone / tablet) ────────────────────────────────
interface NavigationMenuProps {
  visible: boolean;
  onClose: () => void;
}

export function NavigationMenu({ visible, onClose }: NavigationMenuProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const slideAnim = useRef(new Animated.Value(-PANEL_W)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const USE_NATIVE = Platform.OS !== "web";

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: USE_NATIVE }),
        Animated.spring(slideAnim, { toValue: 0, friction: 10, tension: 130, useNativeDriver: USE_NATIVE }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 160, useNativeDriver: USE_NATIVE }),
        Animated.timing(slideAnim, { toValue: -PANEL_W, duration: 200, useNativeDriver: USE_NATIVE }),
      ]).start();
    }
  }, [visible]);

  const handleNavigate = (tabName: string) => {
    onClose();
    setTimeout(() => router.push(`/(tabs)/${tabName}` as any), 120);
  };

  const currentTab = pathname.split("/").pop() || "chat";

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* Overlay */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: fadeAnim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      {/* Slide-in panel from LEFT */}
      <Animated.View
        style={[
          styles.panel,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 24,
            transform: [{ translateX: slideAnim }],
            width: PANEL_W,
            left: 0,
          },
        ]}
      >
        {/* Header */}
        <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
          <View style={styles.logoRow}>
            <View style={[styles.logoIcon, { backgroundColor: "#FF6B3520" }]}>
              <Feather name="shield" size={20} color="#FF6B35" />
            </View>
            <Text style={[styles.logoText, { color: colors.foreground }]}>SafeGPT</Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <NavItemList currentTab={currentTab} onNavigate={handleNavigate} />

        {/* Footer */}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            SafeGPT · Construction H&S AI
          </Text>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { backgroundColor: "rgba(0,0,0,0.5)" },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 20,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  logoIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  logoText: { fontSize: 20, fontWeight: "700", fontFamily: "Inter_700Bold" },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  navIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  navTitle: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_700Bold" },
  navTitleAr: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },
  footer: { paddingHorizontal: 20, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  footerText: { fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center" },
});
