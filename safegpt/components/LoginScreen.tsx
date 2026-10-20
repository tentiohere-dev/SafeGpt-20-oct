import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/context/AppContext";
import { verifyEmergencyCode } from "@/services/emergencyCodeService";
import { useColors } from "@/hooks/useColors";
import { moderateScale, verticalScale } from "@/hooks/useResponsive";
import { importFromInviteCode } from "@/services/userAccountService";
import { AetherBackground } from "@/components/AetherBackground";

export function LoginScreen() {
  const { login, emergencyUnlock } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isSmall = height < 680;
  const isTablet = width >= 600;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [inviteMsg, setInviteMsg] = useState("");
  const [showEmergencyInput, setShowEmergencyInput] = useState(false);
  const [emergencyCode, setEmergencyCode] = useState("");
  const [emergencyError, setEmergencyError] = useState("");

  useEffect(() => {
    if (Platform.OS !== "web" && typeof window !== "undefined") {
      const hash = window.location.hash;
      const match = hash.match(/#invite:(.+)/);
      if (match) {
        const code = decodeURIComponent(match[1]);
        setInviteCodeInput(code);
        setShowInviteModal(true);
      }
    }
  }, []);

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError("Please enter username and password");
      return;
    }
    setIsLoading(true);
    setError("");
    await new Promise((resolve) => setTimeout(resolve, 500));
    let success: boolean;
    try {
      success = await login(username.trim(), password.trim());
    } catch (e: any) {
      setIsLoading(false);
      setError(e?.message || "Sign-in service is unavailable. Try again.");
      return;
    }
    setIsLoading(false);

    if (!success) {
      setError("Invalid username or password.");
    }
  };

  const handleEmergencyLogin = async () => {
    const code = emergencyCode.trim();
    if (!code) return;
    const valid = await verifyEmergencyCode(code);
    if (valid) {
      emergencyUnlock();
      setEmergencyCode("");
      setEmergencyError("");
    } else {
      setEmergencyError("Invalid or already-used emergency code. / الرمز غير صحيح أو استُخدم مسبقاً");
      setEmergencyCode("");
    }
  };

  const handleForgotPassword = () => {
    Alert.alert(
      "Password Reset",
      "Password resets are managed by your administrator.\n\nContact your admin to receive a new invite code or have your password reset.\n\nإعادة تعيين كلمة المرور تتم عبر المشرف.",
      [{ text: "OK" }]
    );
  };

  return (
    <AetherBackground style={styles.container} hue={220} speed={0.12} intensity={0.75} complexity={6} warp={0.3}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingTop: insets.top + (isSmall ? 20 : 40),
              paddingBottom: insets.bottom + 24,
              minHeight: height - insets.top - insets.bottom,
              paddingHorizontal: isTablet ? Math.max(24, (width - 480) / 2) : (width < 360 ? 16 : 24),
              gap: verticalScale(isSmall ? 16 : 22),
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Logo + App name */}
          <View style={styles.header}>
            <View style={styles.logoRing}>
              <View style={styles.logoInner}>
                <Feather name="shield" size={moderateScale(44)} color="#FF6B35" />
                <View style={styles.aiDot} />
              </View>
            </View>
            <Text style={styles.appName}>SafeGPT</Text>
            <Text style={styles.subtitle}>Health & Safety Assistant</Text>
            <Text style={styles.subtitleAr}>مساعد السلامة والصحة المهنية</Text>
          </View>

          {/* Glass form card */}
          <View style={[styles.formCard, isTablet && { maxWidth: 480, alignSelf: "center", width: "100%" }]}>
            <Text style={styles.welcomeText}>Welcome Back</Text>
            <Text style={styles.welcomeAr}>مرحباً بعودتك</Text>

            {/* Username */}
            <View style={styles.inputContainer}>
              <View style={styles.inputIcon}>
                <Feather name="user" size={16} color="rgba(255,255,255,0.5)" />
              </View>
              <TextInput
                style={styles.input}
                placeholder="Username / اسم المستخدم"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            {/* Password */}
            <View style={styles.inputContainer}>
              <View style={styles.inputIcon}>
                <Feather name="lock" size={16} color="rgba(255,255,255,0.5)" />
              </View>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Password / كلمة المرور"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={styles.eyeBtn}
              >
                <Feather
                  name={showPassword ? "eye-off" : "eye"}
                  size={16}
                  color="rgba(255,255,255,0.4)"
                />
              </TouchableOpacity>
            </View>

            {error ? (
              <View style={styles.errorRow}>
                <Feather name="alert-circle" size={13} color="#f87171" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Sign In button */}
            <TouchableOpacity
              style={[styles.loginButton, isLoading && { opacity: 0.7 }]}
              onPress={handleLogin}
              disabled={isLoading}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={["#FF6B35", "#e8521f"]}
                style={styles.loginGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                {isLoading ? (
                  <View style={styles.loginBtnInner}>
                    <Feather name="loader" size={16} color="#fff" />
                    <Text style={styles.loginButtonText}>Signing in…</Text>
                  </View>
                ) : (
                  <View style={styles.loginBtnInner}>
                    <Feather name="log-in" size={16} color="#fff" />
                    <Text style={styles.loginButtonText}>Sign In  /  تسجيل الدخول</Text>
                  </View>
                )}
              </LinearGradient>
            </TouchableOpacity>

            {Platform.OS !== "web" && (
              <>
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>
                <TouchableOpacity
                  style={styles.inviteButton}
                  onPress={() => { setInviteCodeInput(""); setInviteMsg(""); setShowInviteModal(true); }}
                  activeOpacity={0.8}
                >
                  <Feather name="user-plus" size={15} color="#FF6B35" />
                  <Text style={styles.inviteButtonText}>Have an Invite Code? / لديك رمز دعوة؟</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              onPress={handleForgotPassword}
              style={styles.forgotButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.forgotText}>Forgot Password?  /  نسيت كلمة المرور؟</Text>
            </TouchableOpacity>

            {Platform.OS !== "web" && (
              <>
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>emergency</Text>
                  <View style={styles.dividerLine} />
                </View>
                <TouchableOpacity
                  style={styles.emergencyToggle}
                  onPress={() => { setShowEmergencyInput(v => !v); setEmergencyCode(""); setEmergencyError(""); }}
                  activeOpacity={0.8}
                >
                  <Feather name="shield" size={14} color="rgba(255,255,255,0.3)" />
                  <Text style={styles.emergencyToggleText}>
                    {showEmergencyInput ? "Hide Emergency Code / إخفاء" : "Use Emergency Code / رمز الطوارئ"}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {Platform.OS !== "web" && showEmergencyInput && (
              <>
                <View style={styles.inputContainer}>
                  <View style={styles.inputIcon}>
                    <Feather name="shield" size={16} color="rgba(255,255,255,0.5)" />
                  </View>
                  <TextInput
                    style={[styles.input, { letterSpacing: 4 }]}
                    placeholder="XXXXX-XXXXX"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={emergencyCode}
                    onChangeText={(v) => { setEmergencyCode(v.toUpperCase()); setEmergencyError(""); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={handleEmergencyLogin}
                  />
                </View>
                {emergencyError ? (
                  <View style={styles.errorRow}>
                    <Feather name="alert-circle" size={13} color="#f87171" />
                    <Text style={styles.errorText}>{emergencyError}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[styles.loginButton, { opacity: !emergencyCode.trim() ? 0.5 : 1 }]}
                  onPress={handleEmergencyLogin}
                  disabled={!emergencyCode.trim()}
                  activeOpacity={0.85}
                >
                  <LinearGradient
                    colors={["#475569", "#334155"]}
                    style={styles.loginGradient}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                  >
                    <View style={styles.loginBtnInner}>
                      <Feather name="shield" size={16} color="#fff" />
                      <Text style={styles.loginButtonText}>Access with Emergency Code</Text>
                    </View>
                  </LinearGradient>
                </TouchableOpacity>
              </>
            )}
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Built by Muddaser Abbasi • All Rights Reserved © 2025
            </Text>
            <Text style={styles.footerEmail}>muddaserabbasi896@gmail.com</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Invite Code Modal */}
      <Modal visible={Platform.OS !== "web" && showInviteModal} animationType="slide" presentationStyle="formSheet">
        <LinearGradient colors={["#1e3a5f", "#0a0f1e"]} style={{ flex: 1, padding: 28, paddingTop: Math.max(56, insets.top + 20) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>
              Join with Invite Code
            </Text>
            <TouchableOpacity
              onPress={() => { setShowInviteModal(false); setInviteCodeInput(""); setInviteMsg(""); }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Feather name="x" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", marginBottom: 20, fontFamily: "Inter_400Regular", lineHeight: 20 }}>
            Paste the invite code you received from the admin. This registers your account on this device.
          </Text>
          <TextInput
            style={{
              borderRadius: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)",
              backgroundColor: "rgba(255,255,255,0.08)", color: "#fff", padding: 14,
              fontFamily: "Inter_400Regular", fontSize: 13, marginBottom: 10, minHeight: 90,
            }}
            placeholder="Paste invite code here..."
            placeholderTextColor="rgba(255,255,255,0.35)"
            value={inviteCodeInput}
            onChangeText={setInviteCodeInput}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          {inviteMsg ? (
            <Text style={{
              fontSize: 13, marginBottom: 12, fontFamily: "Inter_500Medium",
              color: inviteMsg.startsWith("✓") ? "#4ade80" : "#f87171",
            }}>
              {inviteMsg}
            </Text>
          ) : null}
          <TouchableOpacity
            style={{ backgroundColor: "#FF6B35", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 4 }}
            onPress={async () => {
              if (!inviteCodeInput.trim()) return;
              const result = await importFromInviteCode(inviteCodeInput.trim());
              if (result.success) {
                setInviteMsg(`✓ Account registered for "${result.username}". Enter your password below to sign in.`);
                setUsername(result.username || "");
                setTimeout(() => {
                  setShowInviteModal(false);
                  setInviteCodeInput("");
                  setInviteMsg("");
                }, 2000);
              } else {
                setInviteMsg("✗ Invalid invite code. Please check and try again.");
              }
            }}
            activeOpacity={0.85}
          >
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" }}>
              Register Account
            </Text>
          </TouchableOpacity>
        </LinearGradient>
      </Modal>
    </AetherBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    gap: 8,
  },
  logoRing: {
    width: moderateScale(96),
    height: moderateScale(96),
    borderRadius: moderateScale(48),
    backgroundColor: "rgba(255,107,53,0.12)",
    borderWidth: 1.5,
    borderColor: "rgba(255,107,53,0.25)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  logoInner: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  aiDot: {
    position: "absolute",
    bottom: -3,
    right: -3,
    width: moderateScale(16),
    height: moderateScale(16),
    borderRadius: moderateScale(8),
    backgroundColor: "#FF6B35",
    borderWidth: 2,
    borderColor: "rgba(10,15,30,0.9)",
  },
  appName: {
    fontSize: moderateScale(38),
    fontWeight: "700",
    color: "#ffffff",
    fontFamily: "Inter_700Bold",
    letterSpacing: 3,
    textShadowColor: "rgba(255,107,53,0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  subtitle: {
    fontSize: moderateScale(13),
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Inter_400Regular",
    letterSpacing: 0.5,
  },
  subtitleAr: {
    fontSize: moderateScale(12),
    color: "rgba(255,107,53,0.75)",
    fontFamily: "Inter_400Regular",
  },
  formCard: {
    backgroundColor: "rgba(10,15,30,0.6)",
    borderRadius: 22,
    padding: moderateScale(22),
    gap: moderateScale(12),
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    // Glass effect via backdrop not available in RN, using dark bg instead
  },
  welcomeText: {
    fontSize: moderateScale(20),
    fontWeight: "700",
    color: "#ffffff",
    fontFamily: "Inter_700Bold",
  },
  welcomeAr: {
    fontSize: moderateScale(12),
    color: "rgba(255,255,255,0.45)",
    fontFamily: "Inter_400Regular",
    marginTop: -6,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 12,
    paddingVertical: moderateScale(12),
    gap: 10,
  },
  inputIcon: {
    width: 28,
    alignItems: "center",
  },
  input: {
    flex: 1,
    fontSize: moderateScale(14),
    color: "#ffffff",
    fontFamily: "Inter_400Regular",
  },
  eyeBtn: {
    padding: 4,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  errorText: {
    color: "#f87171",
    fontSize: moderateScale(12),
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  loginButton: {
    borderRadius: 13,
    overflow: "hidden",
    marginTop: 4,
    shadowColor: "#FF6B35",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  loginGradient: {
    paddingVertical: moderateScale(14),
    alignItems: "center",
    justifyContent: "center",
  },
  loginBtnInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loginButtonText: {
    fontSize: moderateScale(15),
    fontWeight: "700",
    color: "#ffffff",
    fontFamily: "Inter_700Bold",
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 2,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  dividerText: {
    fontSize: 12,
    color: "rgba(255,255,255,0.3)",
    fontFamily: "Inter_400Regular",
  },
  inviteButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,107,53,0.1)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,107,53,0.25)",
    paddingVertical: moderateScale(12),
  },
  inviteButtonText: {
    fontSize: moderateScale(13),
    color: "#FF6B35",
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  forgotButton: {
    alignItems: "center",
    paddingBottom: 2,
  },
  forgotText: {
    fontSize: moderateScale(12),
    color: "rgba(255,255,255,0.35)",
    fontFamily: "Inter_400Regular",
  },
  emergencyToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  emergencyToggleText: {
    fontSize: moderateScale(12),
    color: "rgba(255,255,255,0.28)",
    fontFamily: "Inter_400Regular",
  },
  footer: {
    alignItems: "center",
    marginTop: verticalScale(4),
    gap: 3,
  },
  footerText: {
    fontSize: moderateScale(10),
    color: "rgba(255,255,255,0.2)",
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  footerEmail: {
    fontSize: moderateScale(10),
    color: "rgba(255,107,53,0.45)",
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
