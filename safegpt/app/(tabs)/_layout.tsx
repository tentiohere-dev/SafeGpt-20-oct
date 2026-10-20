import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { NavigationMenu, SideBarPanel } from "@/components/NavigationMenu";
import { AppSmokeBackground } from "@/components/AppSmokeBackground";

// ─── Inject Puter.js for natural English TTS (web only) ──────────────────────
function PuterLoader() {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    if ((window as any).puter) return;
    const script = document.createElement("script");
    script.src = "https://js.puter.com/v2/";
    script.async = true;
    document.head.appendChild(script);
    return () => { try { document.head.removeChild(script); } catch {} };
  }, []);
  return null;
}

const TABS = [
  "chat", "voice", "image", "video", "live",
  "toolkit", "reports", "documents", "analytics", "models", "settings", "emergency",
];

const TabScreens = () => (
  <Tabs screenOptions={{ headerShown: false, tabBarStyle: { display: "none" } }}>
    {TABS.map(tab => <Tabs.Screen key={tab} name={tab} />)}
  </Tabs>
);

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const { width } = useWindowDimensions();
  const isDesktop = width >= 1024;

  // ── Desktop: permanent sidebar + content pane side-by-side ────────────────
  if (isDesktop) {
    return (
      <AppSmokeBackground style={{ flex: 1, flexDirection: "row" }}>
        <PuterLoader />
        <SideBarPanel width={240} />
        <View style={{ flex: 1, overflow: "hidden", backgroundColor: colors.background }}>
          <TabScreens />
        </View>
      </AppSmokeBackground>
    );
  }

  // ── Phone / Tablet: hamburger button + slide-in modal menu ────────────────
  return (
    <AppSmokeBackground style={{ flex: 1 }}>
      <PuterLoader />
      <TabScreens />

      {/* ── HAMBURGER — fixed TOP LEFT corner ─────────────────────────────── */}
      <TouchableOpacity
        style={[
          styles.hamburger,
          {
            backgroundColor: colors.primary,
            top: insets.top + (Platform.OS === "android" ? 10 : 8),
            left: 12,
          },
        ]}
        onPress={() => setMenuOpen(true)}
        activeOpacity={0.82}
      >
        <Feather name="menu" size={20} color="#fff" />
        <Text style={styles.hamburgerLabel}>MENU</Text>
      </TouchableOpacity>

      <NavigationMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
    </AppSmokeBackground>
  );
}

const styles = StyleSheet.create({
  hamburger: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    zIndex: 200,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 12,
  },
  hamburgerLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
});
