import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

type Colors = ReturnType<typeof useColors>;

export function ScreenHeader({
  title,
  subtitle,
  right,
  colors: colorsProp,
  paddingTopExtra,
}: {
  title: string;
  subtitle?: string | null;
  right?: React.ReactNode;
  colors?: Colors;
  paddingTopExtra?: number;
}) {
  const defaultColors = useColors();
  const colors = colorsProp ?? defaultColors;
  const insets = useSafeAreaInsets();
  const { isDesktop, hamburgerOffset } = useLayoutConfig();
  const pt =
    insets.top +
    (paddingTopExtra ?? (Platform.OS === "android" ? 14 : 12));

  // Desktop: permanent sidebar, no hamburger slot needed
  // Mobile: equal left/right slots so title is centred on screen
  const slotWidth = isDesktop ? 0 : hamburgerOffset + 4;

  return (
    <View
      style={[
        styles.header,
        {
          backgroundColor: colors.headerBackground,
          paddingTop: pt,
          borderBottomColor: colors.border,
          paddingLeft: isDesktop ? 16 : 4,
          shadowColor: "#FF6B35",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.08,
          shadowRadius: 12,
        },
      ]}
    >
      {!isDesktop && <View style={{ width: slotWidth }} />}
      <View style={styles.center}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.rightSlot, { width: slotWidth }]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
  },
  title: {
    fontSize: moderateScale(16),
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    width: "100%",
  },
  subtitle: {
    fontSize: moderateScale(10),
    fontFamily: "Inter_400Regular",
    marginTop: 1,
    textAlign: "center",
    width: "100%",
  },
  rightSlot: {
    alignItems: "flex-end",
    justifyContent: "center",
  },
});
