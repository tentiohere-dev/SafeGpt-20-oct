import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

export function OnboardingScreen() {
  const { completeOnboarding } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [companyName, setCompanyName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [safetyOfficer, setSafetyOfficer] = useState("");
  const [additionalDetails, setAdditionalDetails] = useState("");

  const handleComplete = () => {
    completeOnboarding({
      companyName,
      siteName,
      projectName,
      startDate,
      safetyOfficer,
      additionalDetails,
    });
  };

  const handleSkip = () => {
    completeOnboarding({
      companyName: "",
      siteName: "",
      projectName: "",
      startDate: "",
      safetyOfficer: "",
      additionalDetails: "",
    });
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background },
      ]}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={[styles.iconContainer, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="settings" size={36} color={colors.primary} />
            </View>
            <Text style={[styles.title, { color: colors.foreground }]}>Project Setup</Text>
            <Text style={[styles.titleAr, { color: colors.primary }]}>إعداد المشروع</Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Fill in your project details to personalize SafeGPT. You can update these anytime in Settings.
            </Text>
          </View>

          <View style={styles.form}>
            <InputField
              label="Company Name / اسم الشركة"
              placeholder="Enter company name"
              value={companyName}
              onChangeText={setCompanyName}
              colors={colors}
              icon="briefcase"
            />
            <InputField
              label="Site Name / اسم الموقع"
              placeholder="Enter construction site name"
              value={siteName}
              onChangeText={setSiteName}
              colors={colors}
              icon="map-pin"
            />
            <InputField
              label="Project Name / اسم المشروع"
              placeholder="Enter project name"
              value={projectName}
              onChangeText={setProjectName}
              colors={colors}
              icon="folder"
            />
            <InputField
              label="Project Start Date / تاريخ البدء"
              placeholder="DD/MM/YYYY"
              value={startDate}
              onChangeText={setStartDate}
              colors={colors}
              icon="calendar"
            />
            <InputField
              label="Safety Officer Name / مسؤول السلامة"
              placeholder="Enter safety officer name"
              value={safetyOfficer}
              onChangeText={setSafetyOfficer}
              colors={colors}
              icon="user"
            />
            <InputField
              label="Additional Details / تفاصيل إضافية"
              placeholder="Any other relevant project information..."
              value={additionalDetails}
              onChangeText={setAdditionalDetails}
              colors={colors}
              icon="file-text"
              multiline
            />
          </View>

          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }]}
              onPress={handleComplete}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryButtonText}>Start SafeGPT / ابدأ</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.skipButton} onPress={handleSkip} activeOpacity={0.8}>
              <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
                Skip for now / تخطي
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function InputField({
  label,
  placeholder,
  value,
  onChangeText,
  colors,
  icon,
  multiline,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  colors: any;
  icon: any;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{label}</Text>
      <View
        style={[
          styles.inputContainer,
          { backgroundColor: colors.card, borderColor: colors.border },
          multiline && { height: 80, alignItems: "flex-start" },
        ]}
      >
        <Feather name={icon} size={16} color={colors.mutedForeground} style={multiline ? { marginTop: 2 } : {}} />
        <TextInput
          style={[
            styles.input,
            { color: colors.foreground },
            multiline && { height: 70, textAlignVertical: "top" },
          ]}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          value={value}
          onChangeText={onChangeText}
          multiline={multiline}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 24 },
  header: { alignItems: "center", marginBottom: 32, gap: 10 },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: { fontSize: 28, fontWeight: "700", fontFamily: "Inter_700Bold" },
  titleAr: { fontSize: 16, fontFamily: "Inter_400Regular", marginTop: -4 },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  form: { gap: 16, marginBottom: 24 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 10,
  },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  buttons: { gap: 12 },
  primaryButton: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ffffff",
    fontFamily: "Inter_700Bold",
  },
  skipButton: { alignItems: "center", paddingVertical: 12 },
  skipText: { fontSize: 14, fontFamily: "Inter_400Regular" },
});
