import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

interface AppSmokeBackgroundProps {
  children?: React.ReactNode;
  style?: ViewStyle;
}

export function AppSmokeBackground({ children, style }: AppSmokeBackgroundProps) {
  return (
    <View style={[styles.root, style]}>
      <LinearGradient
        colors={["#060912", "#08101f", "#060912"]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
