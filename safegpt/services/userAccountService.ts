import AsyncStorage from "@react-native-async-storage/async-storage";
import { sha256 } from "./authService";

const ACCOUNTS_KEY = "safegpt_user_accounts_v1";

export interface StoredUserAccount {
  username: string;
  passwordHash: string;
  createdAt: number;
}

export async function getStoredUserAccounts(): Promise<StoredUserAccount[]> {
  try {
    const data = await AsyncStorage.getItem(ACCOUNTS_KEY);
    if (!data) return [];
    return JSON.parse(data) as StoredUserAccount[];
  } catch {
    return [];
  }
}

async function _saveAccounts(accounts: StoredUserAccount[]): Promise<void> {
  await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

/**
 * Create a new user account and return a base64 invite code the admin can share.
 * If an account for the same username already exists it is overwritten.
 */
export async function createUserAccount(
  username: string,
  password: string
): Promise<string> {
  const u = username.trim();
  const ph = await sha256(password.trim());
  const existing = await getStoredUserAccounts();
  const filtered = existing.filter(
    (a) => a.username.toLowerCase() !== u.toLowerCase()
  );
  filtered.push({ username: u, passwordHash: ph, createdAt: Date.now() });
  await _saveAccounts(filtered);
  // Produce an invite code the new user pastes on the login screen
  const payload = JSON.stringify({ u, ph, v: 1 });
  return btoa(unescape(encodeURIComponent(payload)));
}

export async function deleteUserAccount(username: string): Promise<void> {
  const existing = await getStoredUserAccounts();
  await _saveAccounts(
    existing.filter((a) => a.username.toLowerCase() !== username.toLowerCase())
  );
}

/**
 * Decode an invite code and register the account locally.
 * Safe to call multiple times — idempotent on same username.
 */
export async function importFromInviteCode(code: string): Promise<{
  success: boolean;
  username?: string;
  error?: string;
}> {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())));
    const payload = JSON.parse(json) as { u: string; ph: string; v: number };
    if (!payload.u || !payload.ph) return { success: false, error: "invalid_code" };
    const existing = await getStoredUserAccounts();
    const filtered = existing.filter(
      (a) => a.username.toLowerCase() !== payload.u.toLowerCase()
    );
    filtered.push({
      username: payload.u,
      passwordHash: payload.ph,
      createdAt: Date.now(),
    });
    await _saveAccounts(filtered);
    return { success: true, username: payload.u };
  } catch {
    return { success: false, error: "invalid_code" };
  }
}

/** Check if username + password match any stored user account. */
export async function verifyAnyUserAccount(
  username: string,
  password: string
): Promise<boolean> {
  const accounts = await getStoredUserAccounts();
  const ph = await sha256(password.trim());
  return accounts.some(
    (a) =>
      a.username.toLowerCase() === username.trim().toLowerCase() &&
      a.passwordHash === ph
  );
}
