import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, Text, View } from "react-native";
import { moderateScale, verticalScale } from "@/hooks/useResponsive";
import { AetherBackground } from "@/components/AetherBackground";

const USE_NATIVE_DRIVER = Platform.OS !== "web";

const ICON_SIZE = moderateScale(60);
const SHIELD_SIZE = moderateScale(120);

export function SplashLoadingScreen({ onDone }: { onDone: () => void }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.7)).current;
  const textFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 6,
          tension: 80,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ]),
      Animated.timing(textFade, {
        toValue: 1,
        duration: 500,
        useNativeDriver: USE_NATIVE_DRIVER,
      }),
      Animated.delay(1800),
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 600,
        useNativeDriver: USE_NATIVE_DRIVER,
      }),
    ]).start(() => onDone());
  }, []);

  return (
    <AetherBackground style={styles.container} hue={220} speed={0.12} intensity={0.75} complexity={6} warp={0.3}>
      <Animated.View
        style={[
          styles.content,
          { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
        ]}
      >
        <View style={styles.iconContainer}>
          <View
            style={[
              styles.shieldOuter,
              { width: SHIELD_SIZE, height: SHIELD_SIZE, borderRadius: SHIELD_SIZE / 2 },
            ]}
          >
            <View style={styles.shieldInner}>
              <Feather name="shield" size={ICON_SIZE} color="#FF6B35" />
              <View
                style={[
                  styles.aiDot,
                  {
                    width: moderateScale(18),
                    height: moderateScale(18),
                    borderRadius: moderateScale(9),
                  },
                ]}
              />
            </View>
          </View>
        </View>

        <Text style={styles.appName}>SafeGPT</Text>

        <View style={styles.taglineContainer}>
          <Text style={styles.taglineEn}>AI-Powered Health & Safety</Text>
          <Text style={styles.taglineAr}>نظام السلامة المهنية بالذكاء الاصطناعي</Text>
        </View>

        <Animated.View style={[styles.footer, { opacity: textFade }]}>
          <Text style={styles.builtBy}>Built by Muddaser Abbasi</Text>
          <Text style={styles.copyright}>All Rights Reserved © 2025</Text>
          <Text style={styles.email}>muddaserabbasi896@gmail.com</Text>
        </Animated.View>
      </Animated.View>
    </AetherBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingHorizontal: 24,
    gap: verticalScale(14),
    zIndex: 10,
  },
  iconContainer: {
    marginBottom: verticalScale(4),
  },
  shieldOuter: {
    backgroundColor: "rgba(255,107,53,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  shieldInner: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  aiDot: {
    position: "absolute",
    bottom: -4,
    right: -4,
    backgroundColor: "#FF6B35",
    borderWidth: 2,
    borderColor: "rgba(30,58,95,0.8)",
  },
  appName: {
    fontSize: moderateScale(48),
    fontWeight: "700",
    color: "#ffffff",
    letterSpacing: 3,
    fontFamily: "Inter_700Bold",
    textShadowColor: "rgba(255,107,53,0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
  },
  taglineContainer: {
    alignItems: "center",
    gap: 4,
  },
  taglineEn: {
    fontSize: moderateScale(13),
    color: "rgba(255,255,255,0.75)",
    fontFamily: "Inter_400Regular",
    letterSpacing: 1,
    textAlign: "center",
  },
  taglineAr: {
    fontSize: moderateScale(12),
    color: "rgba(255,107,53,0.9)",
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  footer: {
    marginTop: verticalScale(40),
    alignItems: "center",
    gap: 4,
  },
  builtBy: {
    fontSize: moderateScale(11),
    color: "rgba(255,255,255,0.5)",
    fontFamily: "Inter_400Regular",
  },
  copyright: {
    fontSize: moderateScale(10),
    color: "rgba(255,255,255,0.35)",
    fontFamily: "Inter_400Regular",
  },
  email: {
    fontSize: moderateScale(10),
    color: "rgba(255,107,53,0.6)",
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
