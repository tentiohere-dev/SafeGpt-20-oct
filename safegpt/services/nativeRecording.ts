import { Audio } from "expo-av";
import { Platform } from "react-native";

let active: Audio.Recording | null = null;

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error("Could not read recording"));
    reader.readAsArrayBuffer(blob);
  });
}

export async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS === "web") return true;
  const { status } = await Audio.requestPermissionsAsync();
  return status === "granted";
}

export async function startNativeRecording(): Promise<void> {
  if (active) {
    try {
      await active.stopAndUnloadAsync();
    } catch {
      /* ignore */
    }
    active = null;
  }
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
  const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  active = recording;
}

export async function stopNativeRecordingToBlob(): Promise<Blob> {
  if (!active) throw new Error("No recording");
  const rec = active;
  active = null;
  await rec.stopAndUnloadAsync();
  const uri = rec.getURI();
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
  if (!uri) throw new Error("No recording file");
  const res = await fetch(uri);
  const blob = await res.blob();
  const type = blob.type || "audio/m4a";
  const buffer = await blobToArrayBuffer(blob);
  return new Blob([buffer], { type: type.includes("audio") ? type : "audio/m4a" });
}
