import { useContext } from "react";
import { useColorScheme } from "react-native";

import { AppContext } from "@/context/AppContext";
import colors from "@/constants/colors";

/**
 * Returns the design tokens for the current color scheme.
 *
 * Priority:
 *  1. AppContext.darkMode (user-controlled toggle in Settings)
 *  2. System color scheme (fallback when AppContext is not yet mounted)
 */
export function useColors() {
  const ctx = useContext(AppContext);
  const systemScheme = useColorScheme();

  const isDark = ctx !== null
    ? ctx.darkMode
    : systemScheme === "dark";

  const palette = isDark && "dark" in colors
    ? (colors as unknown as Record<string, typeof colors.light>).dark
    : colors.light;

  return { ...palette, radius: colors.radius };
}
