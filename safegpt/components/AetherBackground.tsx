import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { StyleSheet, ViewStyle } from "react-native";

interface AetherBackgroundProps {
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  hue?: number;
  speed?: number;
  intensity?: number;
  complexity?: number;
  warp?: number;
}

export function AetherBackground({ children, style }: AetherBackgroundProps) {
  return (
    <LinearGradient colors={["#1e3a5f", "#0a0f1e"]} style={[styles.container, style as ViewStyle]}>
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
