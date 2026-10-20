/**
 * SpeakerButton — shared TTS control used in both Chat and Voice Assistant.
 *
 * Tap:       idle → speak (auto lang)  |  speaking → pause  |  paused → resume
 * Long-press: open language menu (English / Arabic switch + Restart)
 */

import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated, Pressable, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import {
  speakText, pauseSpeech, resumeSpeech, stopSpeech,
  subscribeTts, TtsUiState,
} from "@/services/aiService";
import { moderateScale } from "@/hooks/useResponsive";

interface SpeakerButtonProps {
  /** Full response text (English or mixed). */
  text: string;
  /** Arabic portion of the response, if bilingual. */
  arText?: string | null;
  /** Unique message ID so the TTS subscription can scope state per-bubble. */
  messageId: string;
  /** Groq API Key 1 — used for Arabic TTS (Orpheus playai-tts-arabic). */
  groqApiKey?: string;
  /** Groq API Key 2 — auto-rotates when Key 1 hits rate limit. */
  groqApiKey2?: string;
  colors: {
    primary: string;
    mutedForeground: string;
    foreground: string;
    card: string;
    border: string;
  };
  /** Default language: "en" or "ar". Falls back to "en" if not provided. */
  defaultLang?: "en" | "ar";
}

export function SpeakerButton({
  text,
  arText,
  messageId,
  groqApiKey = "",
  groqApiKey2 = "",
  colors,
  defaultLang = "en",
}: SpeakerButtonProps) {
  const [ttsState, setTtsState] = useState<TtsUiState>("idle");
  const [activeLang, setActiveLang] = useState<"en" | "ar">(defaultLang);
  const [menuOpen, setMenuOpen] = useState(false);

  // Pulse animation while speaking
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  const startPulse = useCallback(() => {
    pulseRef.current?.stop();
    pulseRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.35, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 500, useNativeDriver: true }),
      ])
    );
    pulseRef.current.start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseRef.current?.stop();
    pulseAnim.setValue(1);
  }, [pulseAnim]);

  // Subscribe to global TTS state — filter by this message's ID
  useEffect(() => {
    return subscribeTts(({ state, messageId: mid }) => {
      if (mid !== messageId) {
        setTtsState((prev) => (prev === "idle" ? "idle" : "idle"));
        stopPulse();
        return;
      }
      if (state === "playing") { setTtsState("playing"); startPulse(); }
      else if (state === "paused") { setTtsState("paused"); stopPulse(); }
      else { setTtsState("idle"); stopPulse(); }
    });
  }, [messageId, startPulse, stopPulse]);

  const textFor = (lang: "en" | "ar") =>
    lang === "ar" ? (arText || text) : text;

  const doSpeak = (lang: "en" | "ar") => {
    setActiveLang(lang);
    void stopSpeech();
    speakText(textFor(lang), lang, groqApiKey, messageId, groqApiKey2);
  };

  // Single tap: play / pause / resume
  const handleTap = () => {
    setMenuOpen(false);
    if (ttsState === "playing") { pauseSpeech(); return; }
    if (ttsState === "paused") { resumeSpeech(); return; }
    doSpeak(defaultLang);
  };

  // Long press: open language menu
  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMenuOpen((o) => !o);
  };

  const icon: any =
    ttsState === "playing" ? "volume-2" :
    ttsState === "paused"  ? "pause-circle" :
    "volume-1";
  const iconColor = ttsState !== "idle" ? colors.primary : colors.mutedForeground;

  return (
    <View style={styles.wrap}>
      {/* Floating language menu */}
      {menuOpen && (
        <View style={[styles.menu, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.menuTitle, { color: colors.mutedForeground }]}>Voice language</Text>

          <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); doSpeak("en"); }}>
            <Feather name="globe" size={13} color={colors.primary} />
            <Text style={[styles.menuLabel, { color: colors.foreground }]}>English</Text>
          </TouchableOpacity>

          {arText && (
            <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); doSpeak("ar"); }}>
              <Feather name="globe" size={13} color="#10b981" />
              <Text style={[styles.menuLabel, { color: colors.foreground }]}>Arabic / العربية</Text>
            </TouchableOpacity>
          )}

          {ttsState !== "idle" && (
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                void stopSpeech();
                // Restart from beginning
                setTimeout(() => speakText(textFor(activeLang), activeLang, groqApiKey, messageId, groqApiKey2), 80);
              }}
            >
              <Feather name="rotate-ccw" size={13} color={colors.mutedForeground} />
              <Text style={[styles.menuLabel, { color: colors.foreground }]}>Restart</Text>
            </TouchableOpacity>
          )}

          {ttsState === "playing" && (
            <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); pauseSpeech(); }}>
              <Feather name="pause" size={13} color={colors.mutedForeground} />
              <Text style={[styles.menuLabel, { color: colors.foreground }]}>Pause</Text>
            </TouchableOpacity>
          )}
          {ttsState === "paused" && (
            <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); resumeSpeech(); }}>
              <Feather name="play" size={13} color={colors.mutedForeground} />
              <Text style={[styles.menuLabel, { color: colors.foreground }]}>Resume</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {ttsState !== "idle" && (
        <Text style={[styles.statusLabel, { color: colors.primary }]}>
          {ttsState === "playing" ? "▶ Speaking" : "⏸ Paused"}
        </Text>
      )}

      <Pressable
        onPress={handleTap}
        onLongPress={handleLongPress}
        delayLongPress={450}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.btn}
      >
        <Animated.View style={{ transform: [{ scale: ttsState === "playing" ? pulseAnim : 1 }] }}>
          <Feather name={icon} size={moderateScale(15)} color={iconColor} />
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end", marginBottom: 6, zIndex: 10 },
  btn: { padding: 2 },
  statusLabel: { fontSize: moderateScale(9), fontStyle: "italic", marginBottom: 3 },
  menu: {
    position: "absolute",
    right: 0,
    top: 26,
    minWidth: 170,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 10,
  },
  menuTitle: { fontSize: moderateScale(9), paddingHorizontal: 10, paddingBottom: 4, fontStyle: "italic" },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  menuLabel: { fontSize: moderateScale(13), flex: 1 },
});
