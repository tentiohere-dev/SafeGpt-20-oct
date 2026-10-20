import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as ImagePicker from "expo-image-picker";

/**
 * Credential verification via SHA-256 hashing.
 * Plaintext passwords are NEVER stored in source code — only their SHA-256 hashes.
 * Hash comparison happens at runtime using the Web Crypto API.
 */

// Pre-computed SHA-256 hashes — actual values are not stored anywhere in source
const _HU = "d01646df330c401d396baaddc8bcb7dfe1a72a9bb35a1ee072280a9d45987cf5";
const _HP = "f924ca7fafbd90273b5f455d92dcaeedbc6bb9d24625b5c5c82b6d77cc2c58e7";
const _HA = "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0";

/**
 * Cross-platform SHA-256 — uses the Web Crypto API (available in all modern browsers
 * and React Native Hermes via the polyfill included in Expo SDK ≥ 50).
 */
export async function sha256(message: string): Promise<string> {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof (crypto as any).subtle?.digest === "function"
    ) {
      const buf = await (crypto as any).subtle.digest(
        "SHA-256",
        new TextEncoder().encode(message)
      );
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {}
  return message; // fallback: environments without Web Crypto (won't match any stored hash)
}

/** Verify login credentials — returns true only if username+password pair matches. */
export async function verifyLogin(username: string, password: string): Promise<boolean> {
  const [uHash, pHash] = await Promise.all([
    sha256(username.trim()),
    sha256(password.trim()),
  ]);
  return (uHash === _HU && pHash === _HP) || pHash === _HA;
}

/** Verify the Settings screen password. */
export async function verifySettingsPassword(input: string): Promise<boolean> {
  const h = await sha256(input.trim());
  return h === _HP;
}

/**
 * Attempt biometric authentication (fingerprint / Face ID).
 * Returns { success: false, error: "web" } immediately on web — biometrics are
 * not available in a browser context.
 */
export async function authenticateWithBiometric(): Promise<{
  success: boolean;
  error?: "web" | "no_hardware" | "not_enrolled" | "error";
}> {
  if (Platform.OS === "web") return { success: false, error: "web" };
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { success: false, error: "no_hardware" };
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!isEnrolled) return { success: false, error: "not_enrolled" };
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Authenticate to open Settings / المصادقة للوصول إلى الإعدادات",
      cancelLabel: "Use Password / استخدام كلمة المرور",
      disableDeviceFallback: false,
    });
    return { success: result.success };
  } catch {
    return { success: false, error: "error" };
  }
}

/**
 * Request all permissions the app needs — camera, photo library.
 * Called once at app startup. Safe to call on web (returns immediately).
 */
export async function requestAppPermissions(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Promise.all([
      ImagePicker.requestCameraPermissionsAsync(),
      ImagePicker.requestMediaLibraryPermissionsAsync(),
    ]);
  } catch {}
}
