/**
 * SafeGPT — Emergency Access Codes
 *
 * Generates and verifies one-time emergency codes that bypass the password check.
 * Use these when you've forgotten your password or triggered the 15-minute lockout.
 *
 * - 8 codes are generated at once; each is single-use (consumed after verification).
 * - Codes are displayed ONCE on generation — store them somewhere safe.
 * - Hashes (SHA-256) are stored in localStorage; plaintext is never persisted.
 * - Works on web (localStorage). On native, biometric is the recovery path.
 */

import { Platform } from "react-native";
import { sha256 } from "./authService";

const STORAGE_KEY = "safegpt_emergency_codes";
const CODE_COUNT  = 8;

// Unambiguous alphanumeric: no 0/O, 1/I/L to avoid read-errors when printed
const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ── Random code generation ────────────────────────────────────────────────────
function randomCode(): string {
  const arr = new Uint8Array(10);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 10; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  const chars = Array.from(arr).map(b => CHARSET[b % CHARSET.length]);
  return chars.slice(0, 5).join("") + "-" + chars.slice(5).join("");
}

// ── Storage helpers (localStorage — web only) ─────────────────────────────────
interface StoredData { hashes: string[]; generatedAt: number }

function readStorage(): StoredData | null {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return null;
}

function writeStorage(data: StoredData) {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch {}
}

// ── Normalise user input before hashing ──────────────────────────────────────
function normalise(input: string): string {
  return input.replace(/-/g, "").toUpperCase().trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate 8 new emergency codes.
 * Returns the plaintext codes (shown to user once).
 * Any previously generated codes are invalidated.
 */
export async function generateEmergencyCodes(): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < CODE_COUNT; i++) codes.push(randomCode());
  const hashes = await Promise.all(codes.map(c => sha256(normalise(c))));
  writeStorage({ hashes, generatedAt: Date.now() });
  return codes;
}

/**
 * Verify an emergency code. Consumes it on success (one-time use).
 * Returns true if valid, false otherwise.
 */
export async function verifyEmergencyCode(input: string): Promise<boolean> {
  if (!input.trim()) return false;
  const data = readStorage();
  if (!data || data.hashes.length === 0) return false;

  const inputHash = await sha256(normalise(input));
  const matchIdx = data.hashes.indexOf(inputHash);
  if (matchIdx === -1) return false;

  // Remove the used code — one-time use
  const newHashes = data.hashes.filter((_, i) => i !== matchIdx);
  writeStorage({ ...data, hashes: newHashes });
  return true;
}

/** Number of emergency codes remaining (not yet used). */
export function getEmergencyCodeCount(): number {
  return readStorage()?.hashes.length ?? 0;
}

/** True if at least one emergency code has been generated and not yet consumed. */
export function hasEmergencyCodes(): boolean {
  return getEmergencyCodeCount() > 0;
}
