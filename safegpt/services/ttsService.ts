/**
 * TTS Service
 *
 * English (web):   Web Speech API (SpeechSynthesis).
 *
 * Arabic (web):    Groq playai-tts-arabic API (voice: Aaliya-PlayAI).
 *                  Falls back to Web Speech API if the Groq key is absent or the
 *                  request fails.
 *
 * English (native): expo-speech.
 *
 * Arabic (native):  Groq playai-tts-arabic → MP3 written to cache → expo-av
 *                   playback. Falls back to expo-speech if Groq is unavailable.
 */

import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import * as Speech from "expo-speech";
import { Platform } from "react-native";
import { getConfigApiKeys } from "@/config/apiKeys";
import { getProviderKeyPool } from "@/services/keyManager";

function envValue(name: string): string {
  try {
    const g: any = globalThis as any;
    const v = g.process?.env?.[name];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function shouldUseServerProxy(): boolean {
  return envValue("EXPO_PUBLIC_USE_SERVER_PROXY") === "1";
}

function proxyBaseUrl(): string {
  const base = envValue("EXPO_PUBLIC_PROXY_BASE_URL");
  return base ? base.replace(/\/+$/, "") : "";
}

// ─── Text chunker ──────────────────────────────────────────────────────────────
export function splitTextForSpeech(text: string, maxLen = 450): string[] {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  const raw = cleaned.match(/[^.!?؟،\n]+[.!?؟،\n]*/g) ?? [cleaned];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of raw) {
    const s = sentence.trimStart();
    if (!s) continue;
    if ((current + s).length <= maxLen) {
      current += s;
    } else {
      if (current.trim()) chunks.push(current.trim());
      if (s.length <= maxLen) {
        current = s;
      } else {
        const words = s.split(/\s+/);
        current = "";
        for (const word of words) {
          if ((current + " " + word).length > maxLen) {
            if (current.trim()) chunks.push(current.trim());
            current = word;
          } else {
            current = current ? current + " " + word : word;
          }
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

function chunkGapMs(): number {
  return 300 + Math.floor(Math.random() * 201);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== "undefined") return btoa(binary);
  const g: any = globalThis as any;
  if (g.Buffer) return g.Buffer.from(buffer).toString("base64");
  return "";
}

// ─── TTS state ─────────────────────────────────────────────────────────────────
export type TtsUiState = "idle" | "playing" | "paused";
export type TtsListenerPayload = { state: TtsUiState; messageId: string | null };

const _subscribers = new Set<(p: TtsListenerPayload) => void>();
let _state: TtsUiState = "idle";
let _activeMessageId: string | null = null;
let _lastTtsEngine = "";
let _groqKey = "";
let _groqKeyPool: string[] = [];

export function subscribeTts(fn: (p: TtsListenerPayload) => void): () => void {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}
export function getActiveTtsMessageId(): string | null { return _activeMessageId; }
export function getLastTtsEngine(): string { return _lastTtsEngine; }
export function isTtsSpeaking(): boolean { return _state === "playing"; }
export function isTtsPaused(): boolean { return _state === "paused"; }

function emit(state: TtsUiState): void {
  _state = state;
  const p: TtsListenerPayload = { state, messageId: _activeMessageId };
  _subscribers.forEach((fn) => { try { fn(p); } catch { /* ignore */ } });
}

// ─── Playback handles ──────────────────────────────────────────────────────────
let _running = false;
let _paused = false;
let _lang: "en" | "ar" = "en";
let _pauseWaiters: Array<() => void> = [];
let _webAudio: HTMLAudioElement | null = null;
let _nativeSound: Audio.Sound | null = null;

function resolvePauseWaiters(): void {
  const w = _pauseWaiters.splice(0);
  w.forEach((fn) => fn());
}
function waitUntilUnpaused(): Promise<void> {
  if (!_paused) return Promise.resolve();
  return new Promise((r) => _pauseWaiters.push(r));
}

async function unloadNativeSound(): Promise<void> {
  if (_nativeSound) {
    try { await _nativeSound.stopAsync(); } catch { /* ignore */ }
    try { await _nativeSound.unloadAsync(); } catch { /* ignore */ }
    _nativeSound = null;
  }
}

function hardStopWebAudio(): void {
  if (_webAudio) {
    try { _webAudio.pause(); _webAudio.src = ""; } catch { /* ignore */ }
    _webAudio = null;
  }
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}

// ─── Stop / Pause / Resume ────────────────────────────────────────────────────
export async function stopSpeech(): Promise<void> {
  _running = false;
  _paused = false;
  _activeMessageId = null;
  resolvePauseWaiters();
  hardStopWebAudio();
  if (Platform.OS !== "web") {
    try { await Speech.stop(); } catch { /* ignore */ }
    await unloadNativeSound();
  }
  emit("idle");
}

export function pauseSpeech(): void {
  if (!_running || _paused) return;
  _paused = true;
  emit("paused");
  if (Platform.OS === "web") {
    try { _webAudio?.pause(); } catch { /* ignore */ }
    try { window.speechSynthesis?.pause(); } catch { /* ignore */ }
  } else if (_lang === "en") {
    if (Platform.OS === "ios") Speech.pause().catch(() => {});
    else void Speech.stop();
  } else {
    if (_nativeSound) void _nativeSound.pauseAsync();
    else if (Platform.OS === "ios") Speech.pause().catch(() => {});
    else void Speech.stop();
  }
}

export function resumeSpeech(): void {
  if (!_paused || !_running) return;
  _paused = false;
  emit("playing");
  resolvePauseWaiters();
  if (Platform.OS === "web") {
    try { _webAudio?.play().catch(() => {}); } catch { /* ignore */ }
    try { window.speechSynthesis?.resume(); } catch { /* ignore */ }
  } else if (_lang === "en") {
    if (Platform.OS === "ios") Speech.resume().catch(() => {});
  } else {
    if (_nativeSound) void _nativeSound.playAsync();
    else if (Platform.OS === "ios") Speech.resume().catch(() => {});
  }
}

// ─── Web audio blob player ────────────────────────────────────────────────────
function playBlobWeb(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") { resolve(); return; }
    const url = URL.createObjectURL(blob);
    const audio = new window.Audio(url);
    _webAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (_webAudio === audio) _webAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (_webAudio === audio) _webAudio = null;
      resolve();
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      if (_webAudio === audio) _webAudio = null;
      resolve();
    });
  });
}

// ─── Web Speech API (English, browser) ────────────────────────────────────────
function webSpeechEnglish(chunk: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) { resolve(); return; }
    const utter = new SpeechSynthesisUtterance(chunk);
    utter.lang = "en-US";
    utter.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang.startsWith("en"));
    if (v) utter.voice = v;
    utter.onend  = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

// ─── Groq Arabic TTS ──────────────────────────────────────────────────────────
async function fetchGroqMp3(chunk: string): Promise<ArrayBuffer | null> {
  if (shouldUseServerProxy()) {
    try {
      const base = proxyBaseUrl();
      const url = `${base}/api/tts`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, lang: "ar" }),
      });
      if (!res.ok) return null;
      return await res.arrayBuffer();
    } catch {
      return null;
    }
  }

  if (!_groqKey) return null;
  const pool = _groqKeyPool.length ? _groqKeyPool : [_groqKey];
  for (const key of pool) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "playai-tts-arabic",
          input: chunk,
          voice: "Aaliya-PlayAI",
          response_format: "mp3",
        }),
      });
      if (res.ok) return await res.arrayBuffer();
      const err = await res.text().catch(() => "");
      // Try next key on common auth/quota/rate-limit/server failures.
      if (![401, 403, 408, 409, 429].includes(res.status) && res.status < 500) return null;
      if (!/quota|rate|limit|insufficient/i.test(err) && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
        return null;
      }
    } catch {
      // network/timeout -> try next key
    }
  }
  return null;
}

// Arabic Web Speech fallback (used only when Groq is unavailable)
function arabicWebSpeech(chunk: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) { resolve(); return; }
    const utter = new SpeechSynthesisUtterance(chunk);
    utter.lang = "ar-SA";
    utter.rate = 0.88;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang.startsWith("ar"));
    if (v) utter.voice = v;
    utter.onend  = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

// Browser Arabic: Groq → Web Speech fallback
async function groqArabicWebChunk(chunk: string): Promise<void> {
  const buf = await fetchGroqMp3(chunk);
  if (buf) {
    _lastTtsEngine = "Groq Orpheus Arabic";
    await playBlobWeb(new Blob([buf], { type: "audio/mpeg" }));
  } else {
    _lastTtsEngine = "Web Speech (Arabic)";
    await arabicWebSpeech(chunk);
  }
}

// expo-speech Arabic fallback for native
function speakArabicExpoSpeech(chunk: string): Promise<void> {
  return new Promise((resolve) => {
    Speech.speak(chunk, {
      language: "ar-SA",
      rate: 0.88,
      onDone: () => resolve(),
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

// Native Arabic: Groq MP3 → expo-av file playback → expo-speech fallback
async function groqArabicNativeChunk(chunk: string): Promise<void> {
  const buf = await fetchGroqMp3(chunk);
  if (!buf) {
    await speakArabicExpoSpeech(chunk);
    return;
  }
  await unloadNativeSound();
  const b64 = arrayBufferToBase64(buf);
  const base = FileSystem.cacheDirectory || "";
  const path = `${base}safegpt-tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(path, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const { sound } = await Audio.Sound.createAsync({ uri: path }, { shouldPlay: false });
  _nativeSound = sound;
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
  await sound.playAsync();
  for (;;) {
    if (!_running) break;
    await waitUntilUnpaused();
    if (!_running) break;
    const st = await sound.getStatusAsync();
    if (st.isLoaded && (st as any).didJustFinish) break;
    await sleep(80);
  }
  await unloadNativeSound();
  try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch { /* ignore */ }
}

// ─── Native English TTS (expo-speech) ────────────────────────────────────────
function nativeSpeakEnglish(chunk: string): Promise<void> {
  return new Promise((resolve) => {
    Speech.speak(chunk, {
      language: "en-US",
      rate: 0.95,
      onDone: () => resolve(),
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function runLoop(chunks: string[], lang: "en" | "ar"): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    await waitUntilUnpaused();
    if (!_running) break;
    if (i > 0) await sleep(chunkGapMs());
    await waitUntilUnpaused();
    if (!_running) break;

    const chunk = chunks[i];
    if (Platform.OS === "web") {
      if (lang === "en") {
        _lastTtsEngine = "Web Speech";
        await webSpeechEnglish(chunk);
      } else {
        await groqArabicWebChunk(chunk);
      }
    } else {
      if (lang === "en") {
        _lastTtsEngine = "System TTS";
        await nativeSpeakEnglish(chunk);
      } else {
        _lastTtsEngine = "Groq Orpheus Arabic";
        await groqArabicNativeChunk(chunk);
      }
    }
    if (!_running) break;
  }
  if (_running) {
    _running = false;
    _activeMessageId = null;
    emit("idle");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function speakText(
  text: string,
  lang: "en" | "ar",
  groqApiKey = "",
  messageId?: string | null,
  groqApiKey2 = ""
): void {
  void (async () => {
    await stopSpeech();
    const pool = getProviderKeyPool("groq", {
      groqApiKey: (groqApiKey || "").trim(),
      groqApiKey2: (groqApiKey2 || "").trim(),
    } as any);
    _groqKeyPool = pool;
    _groqKey = pool[0] || (groqApiKey || "").trim();
    _lang = lang;
    const chunks = splitTextForSpeech(text, 450);
    if (!chunks.length) { emit("idle"); return; }
    _activeMessageId = messageId ?? null;
    _running = true;
    _paused = false;
    emit("playing");
    await runLoop(chunks, lang);
  })();
}

export function speakEnglish(text: string, messageId?: string | null): void {
  speakText(text, "en", "", messageId);
}

export function speakArabic(text: string, groqApiKey?: string, messageId?: string | null): void {
  speakText(text, "ar", groqApiKey || "", messageId);
}
