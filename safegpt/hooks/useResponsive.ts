import { Dimensions, Platform, PixelRatio, useWindowDimensions } from "react-native";

// Static values (use in StyleSheet.create)
const { width: INIT_W, height: INIT_H } = Dimensions.get("window");
const BASE_WIDTH = 375;
const BASE_HEIGHT = 812;

export const isSmallPhone = INIT_W < 360;
export const isTablet = INIT_W >= 768;
export const isWeb = Platform.OS === "web";

// Scales based on initial dimensions (for StyleSheet)
export function wp(percentage: number): number {
  return (INIT_W * percentage) / 100;
}
export function hp(percentage: number): number {
  return (INIT_H * percentage) / 100;
}
export function scale(size: number): number {
  return Math.round((INIT_W / BASE_WIDTH) * size);
}
export function verticalScale(size: number): number {
  return Math.round((INIT_H / BASE_HEIGHT) * size);
}
export function moderateScale(size: number, factor = 0.45): number {
  const s = scale(size);
  const result = size + (s - size) * factor;
  // Clamp: never smaller than 10 or larger than 1.6× base
  return Math.round(Math.max(10, Math.min(result, size * 1.6)));
}
export function normalizeFontSize(size: number): number {
  const scaled = (size * INIT_W) / BASE_WIDTH;
  return Math.round(
    Platform.OS === "ios"
      ? PixelRatio.roundToNearestPixel(scaled)
      : PixelRatio.roundToNearestPixel(scaled) - 2
  );
}

export const TAB_BAR_HEIGHT = 0; // We use a FAB + drawer navigation, no tab bar
export const TAB_ICON_SIZE = isSmallPhone ? 18 : isTablet ? 26 : 22;
export const TAB_LABEL_SIZE = isSmallPhone ? 9 : isTablet ? 12 : 10;
export const TAB_ITEM_MIN_WIDTH = isTablet ? 90 : 72;

// Hook for dynamic screen dimensions (handles rotation, resize)
export function useScreenSize() {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    isSmall: width < 360,
    isTablet: width >= 768,
    isLandscape: width > height,
    safeHorizontalPad: width < 360 ? 12 : width >= 768 ? 28 : 16,
    inputMaxWidth: Math.min(width - 32, 640),
  };
}

/**
 * Full responsive layout config — use this hook in screens/components
 * that need to adapt between phone / tablet / desktop.
 *
 * Desktop  ≥ 1024px  → permanent sidebar, no hamburger button
 * Tablet   ≥ 768px   → hamburger modal, wider grids
 * Phone    < 768px   → hamburger modal, single-column
 */
export function useLayoutConfig() {
  const { width, height } = useWindowDimensions();
  const isDesktop = width >= 1024;
  const isTabletW = width >= 768;
  const isPhone = width < 768;
  const isLandscape = width > height;

  // How many grid columns fit given a min card width
  const cols = (cardMinWidth: number) =>
    Math.max(1, Math.floor(width / cardMinWidth));

  return {
    width,
    height,
    isDesktop,
    isTablet: isTabletW,
    isPhone,
    isLandscape,
    /** Width of the permanent left sidebar (0 when no sidebar) */
    sidebarWidth: isDesktop ? 240 : 0,
    /** How much to offset screen headers left to clear the hamburger button */
    hamburgerOffset: isDesktop ? 0 : 100,
    /** Max content width for centering on very large screens */
    contentMaxWidth: isDesktop ? 1100 : undefined,
    /** Standard horizontal padding for screen content */
    horizontalPad: isDesktop ? 28 : isTabletW ? 20 : 16,
    /** Responsive grid helper */
    cols,
  };
}
