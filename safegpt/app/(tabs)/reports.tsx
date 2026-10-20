import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callAI } from "@/services/aiService";
import { readAsBase64, uploadFileToGemini } from "@/services/geminiUpload";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { TAB_BAR_HEIGHT, moderateScale, useLayoutConfig } from "@/hooks/useResponsive";

// ─── Saved Report type (stored independently in AsyncStorage) ─────────────────
interface SavedReport {
  id: string;
  type: string;
  typeName: string;
  content: string;
  fields: Record<string, string>;
  header: Record<string, string>;
  date: string;
  mode: "ai" | "manual";
  aiSuggestions?: {
    severity: string;
    immediateActions: string;
    preventiveActions: string;
    rootCause: string;
  };
}

const STORAGE_KEY = "hse_saved_reports_v2";
const CUSTOM_TYPES_KEY = "hse_custom_report_types_v1";

// ─── Custom report type (user-defined, AI-generated fields) ───────────────────
interface CustomReportType {
  id: string;
  name: string;
  nameAr: string;
  icon: string;
  color: string;
  desc: string;
  manualFields: string[];
  aiQuestions: string[];
}

const CUSTOM_TYPE_COLORS = [
  "#0ea5e9","#a855f7","#14b8a6","#f43f5e","#84cc16",
  "#fb923c","#06b6d4","#8b5cf6","#ec4899","#22c55e",
];
const CUSTOM_TYPE_ICONS = [
  "file","clipboard","activity","layers","cpu",
  "star","flag","award","book","package",
];

// ─── Report type definitions ──────────────────────────────────────────────────
const REPORT_TYPES: {
  id: string;
  name: string;
  nameAr: string;
  icon: string;
  color: string;
  desc: string;
}[] = [
  { id: "incident",             name: "Incident Report",                      nameAr: "تقرير حادثة",               icon: "alert-octagon",  color: "#ef4444", desc: "General workplace incident" },
  { id: "near_miss",            name: "Near Miss Report",                     nameAr: "تقرير حادثة وشيكة",         icon: "alert-triangle", color: "#f59e0b", desc: "Close call or near miss event" },
  { id: "accident",             name: "Accident Report",                      nameAr: "تقرير حادث",                icon: "alert-circle",   color: "#dc2626", desc: "Accident resulting in injury" },
  { id: "first_aid",            name: "First Aid / Medical Treatment",        nameAr: "تقرير الإسعافات الأولية",   icon: "heart",          color: "#ec4899", desc: "First aid or medical treatment" },
  { id: "property_damage",      name: "Property Damage Report",               nameAr: "تقرير تلف الممتلكات",       icon: "tool",           color: "#8b5cf6", desc: "Equipment or property damage" },
  { id: "environmental",        name: "Environmental Incident Report",        nameAr: "تقرير حادثة بيئية",         icon: "droplet",        color: "#10b981", desc: "Spill, emission, or env. impact" },
  { id: "unsafe_condition",     name: "Unsafe Condition Report",              nameAr: "تقرير حالة غير آمنة",       icon: "eye",            color: "#f97316", desc: "Physical hazard or unsafe state" },
  { id: "unsafe_act",           name: "Unsafe Act Report",                    nameAr: "تقرير فعل غير آمن",         icon: "user-x",         color: "#6366f1", desc: "Unsafe behavior or practice" },
  { id: "safety_observation",   name: "Safety Observation Report",            nameAr: "تقرير ملاحظة سلامة",        icon: "check-circle",   color: "#14b8a6", desc: "Positive or negative observation" },
  { id: "vehicle_equipment",    name: "Vehicle / Equipment Incident",         nameAr: "تقرير حادثة مركبة/معدة",   icon: "truck",          color: "#0ea5e9", desc: "Vehicle or equipment incident" },
  { id: "fire_incident",        name: "Fire Incident Report",                 nameAr: "تقرير حريق",                icon: "zap",            color: "#ff6b35", desc: "Fire or explosion incident" },
  { id: "security_incident",    name: "Security Incident Report",             nameAr: "تقرير حادثة أمنية",         icon: "shield",         color: "#64748b", desc: "Theft, vandalism, trespass" },
  { id: "occupational_illness", name: "Occupational Illness Report",          nameAr: "تقرير مرض مهني",            icon: "thermometer",    color: "#a855f7", desc: "Work-related illness or exposure" },
  { id: "emergency_event",      name: "Emergency Event Report",               nameAr: "تقرير حدث طارئ",            icon: "phone-call",     color: "#f43f5e", desc: "Emergency requiring response" },
];

// ─── Professional manual form fields per report type ─────────────────────────
const MANUAL_FIELDS: Record<string, string[]> = {
  incident: [
    "Date & Time of Incident",
    "Location / Area",
    "Type of Incident",
    "Description of Incident",
    "Persons Involved",
    "Witnesses",
    "Injuries / Illnesses",
    "First Aid / Medical Treatment",
    "Property Damage",
    "Immediate Actions Taken",
    "Direct Cause",
    "Root Cause",
    "Corrective Actions",
    "Preventive Actions",
    "Regulatory Notification Required",
    "Investigation Status",
  ],
  near_miss: [
    "Date & Time",
    "Location / Area",
    "Description of Near Miss",
    "Potential Consequences",
    "Persons Involved",
    "Witnesses",
    "Hazard Type",
    "Existing Controls at Time of Event",
    "Why Controls Failed",
    "Corrective Actions Implemented",
    "Preventive Actions Recommended",
    "Risk Level (Before / After Control)",
  ],
  accident: [
    "Date & Time of Accident",
    "Location / Area",
    "Description of Accident",
    "Injured Person(s) Name",
    "Job Title / Trade",
    "Nature of Injury",
    "Part of Body Affected",
    "Medical Treatment Required",
    "Type of Work Being Performed",
    "Equipment / Tools Involved",
    "Witnesses",
    "Immediate Cause",
    "Root Cause",
    "Corrective Actions",
    "Return to Work Date",
    "Regulatory Reporting Required",
  ],
  first_aid: [
    "Date & Time",
    "Location / Area",
    "Name of Injured / Ill Person",
    "Job Title / Trade",
    "Injury / Illness Description",
    "Part of Body Affected",
    "Mechanism of Injury",
    "First Aid Treatment Provided",
    "Treated By (Name / Role)",
    "Medical Referral Required",
    "Hospital / Clinic Attended",
    "Return to Work Status",
    "Follow-up Actions Required",
  ],
  property_damage: [
    "Date & Time",
    "Location / Area",
    "Description of Damage",
    "Item / Asset / Equipment Damaged",
    "Estimated Cost of Damage",
    "Cause of Damage",
    "Persons Involved",
    "Environmental Impact",
    "Immediate Actions Taken",
    "Repair / Replacement Required",
    "Insurance Claim Required",
    "Investigation Required",
  ],
  environmental: [
    "Date & Time",
    "Location / Area",
    "Incident Type (Spill / Emission / Waste / Other)",
    "Description of Incident",
    "Substance(s) Involved",
    "Quantity / Volume Released",
    "Environmental Media Affected (Soil / Water / Air)",
    "Immediate Containment Actions",
    "Notifications Made (Regulatory / Management)",
    "Cleanup Actions Taken",
    "Environmental Monitoring Required",
    "Corrective / Preventive Actions",
  ],
  unsafe_condition: [
    "Date & Time Observed",
    "Location / Area",
    "Hazard Description",
    "Hazard Type (Structural / Electrical / Chemical / Other)",
    "Risk Level (Low / Medium / High / Critical)",
    "Persons at Risk",
    "Existing Controls in Place",
    "Corrective Action Required",
    "Interim Controls Implemented",
    "Action Assigned To",
    "Target Completion Date",
    "Verification of Completion",
  ],
  unsafe_act: [
    "Date & Time Observed",
    "Location / Area",
    "Description of Unsafe Act / Behavior",
    "Person(s) Involved",
    "Job Title / Trade",
    "Task Being Performed",
    "PPE Compliance Status",
    "Root Cause of Unsafe Behavior",
    "Immediate Action Taken",
    "Corrective Action",
    "Training / Coaching Required",
    "Follow-up Required",
  ],
  safety_observation: [
    "Date & Time",
    "Location / Area",
    "Observer Name",
    "Observation Type (Positive / Negative / Both)",
    "Observation Details",
    "Positive Behaviors Noted",
    "Unsafe Conditions or Behaviors Observed",
    "Risk Level",
    "Immediate Feedback Given",
    "Recommendations",
    "Follow-up Required",
  ],
  vehicle_equipment: [
    "Date & Time",
    "Location / Area",
    "Type of Vehicle / Equipment",
    "Vehicle Registration / Equipment ID",
    "Driver / Operator Name",
    "License / Certification Status",
    "Description of Incident",
    "Damage to Vehicle / Equipment",
    "Other Property Damage",
    "Injuries Sustained",
    "Witnesses",
    "Immediate Actions Taken",
    "Root Cause",
    "Vehicle / Equipment Removed from Service",
    "Regulatory Reporting Required",
  ],
  fire_incident: [
    "Date & Time",
    "Location / Area of Fire",
    "Origin of Fire",
    "Suspected Cause",
    "Material / Substance Involved",
    "Fire Suppression Method Used",
    "Emergency Services Called",
    "Injuries / Fatalities",
    "Property / Asset Damage",
    "Evacuation Carried Out",
    "Fire Systems (Alarm / Sprinkler) Status",
    "Immediate Actions Taken",
    "Investigation Required",
    "Corrective / Preventive Actions",
  ],
  security_incident: [
    "Date & Time",
    "Location / Area",
    "Incident Type (Theft / Vandalism / Trespass / Threat / Other)",
    "Description of Incident",
    "Person(s) Involved / Suspect Description",
    "Items Stolen or Damaged",
    "Security Measures in Place at Time",
    "Response Actions Taken",
    "Reported to Authorities",
    "Case / Reference Number",
    "Damage Assessment",
    "Follow-up Actions Required",
  ],
  occupational_illness: [
    "Date of Report",
    "Date Symptoms First Noticed",
    "Location / Work Area",
    "Affected Person Name",
    "Job Title / Trade",
    "Symptoms Reported",
    "Work Activity / Task Associated",
    "Substance / Agent / Hazard Exposure",
    "Duration and Frequency of Exposure",
    "PPE in Use at Time",
    "Medical Diagnosis",
    "Treatment / Medication Required",
    "Work Restrictions Imposed",
    "Occupational Health Referral",
    "Investigation Required",
  ],
  emergency_event: [
    "Date & Time of Emergency",
    "Location / Area",
    "Type of Emergency",
    "Description of Event",
    "Persons Involved / Injured",
    "Injuries / Fatalities",
    "Evacuation Status",
    "Muster Point Used",
    "Emergency Services Deployed",
    "Incident Commander / Emergency Coordinator",
    "All Clear Time",
    "Communication Actions Taken",
    "Business Impact",
    "Post-Emergency Actions Required",
  ],
};

// ─── AI mode questions per report type ───────────────────────────────────────
const AI_QUESTIONS: Record<string, string[]> = {
  incident:             ["What happened?", "Where did it happen?", "When did it happen?", "Was anyone injured?"],
  near_miss:            ["What nearly happened?", "Where and when?", "What was the potential consequence?", "What prevented the incident?"],
  accident:             ["What happened?", "Where and when?", "Who was injured and how?", "What treatment was provided?"],
  first_aid:            ["Who was affected?", "What was the injury or illness?", "What first aid was given?", "Who treated them and where?"],
  property_damage:      ["What was damaged?", "Where and when?", "How did the damage occur?", "What is the estimated severity?"],
  environmental:        ["What type of incident occurred?", "Where and when?", "What substance was involved?", "What immediate action was taken?"],
  unsafe_condition:     ["What hazard was observed?", "Where was it found?", "What is the risk level?", "What interim controls were applied?"],
  unsafe_act:           ["What unsafe behavior was observed?", "Where and when?", "Who was involved?", "What action was taken?"],
  safety_observation:   ["What did you observe?", "Where and when?", "Was this positive, negative, or both?", "What feedback was given?"],
  vehicle_equipment:    ["What vehicle or equipment was involved?", "What happened?", "Where and when?", "Was anyone injured or was property damaged?"],
  fire_incident:        ["What caught fire?", "Where and when?", "Was anyone injured?", "Was emergency response activated?"],
  security_incident:    ["What security issue occurred?", "Where and when?", "Who or what was involved?", "What action was taken?"],
  occupational_illness: ["What are the symptoms?", "What work activity is associated?", "How long has the person been exposed?", "What treatment is required?"],
  emergency_event:      ["What type of emergency occurred?", "Where and when?", "What happened?", "Was evacuation required?"],
};

// ─── Generate full AI prompt per report type ──────────────────────────────────
function buildAIPrompt(
  typeName: string,
  typeId: string,
  answers: Record<string, string>,
  header: Record<string, string>,
  visionFindings: string,
  voiceText: string
): string {
  const headerLines = Object.entries(header).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
  const answerLines = Object.entries(answers).map(([k, v]) => `${k}: ${v || "Not specified"}`).join("\n");

  return `You are a senior NEBOSH/OSHA/HSE certified Safety Officer. Generate a complete, professional ${typeName} for a construction/industrial site.

${headerLines ? `REPORT HEADER:\n${headerLines}\n` : ""}
INCIDENT DETAILS PROVIDED:
${answerLines}
${visionFindings ? `\nIMAGE/VIDEO ANALYSIS FINDINGS:\n${visionFindings}\n` : ""}
${voiceText ? `\nVOICE DESCRIPTION:\n${voiceText}\n` : ""}

Respond in EXACTLY this format:

SEVERITY: [Low / Medium / High / Critical — with brief justification]

IMMEDIATE ACTIONS:
- [Action 1]
- [Action 2]
- [Action 3]

PREVENTIVE ACTIONS:
- [Action 1]
- [Action 2]
- [Action 3]

ROOT CAUSE:
[Root cause analysis — 2–3 sentences using the 5-Why or similar methodology]

FULL REPORT:
[Generate a complete professional ${typeName}. Include all standard HSE sections:
- Executive Summary
- Incident/Event Description
- Findings (expand from image analysis if available)
- Root Cause Analysis
- Corrective Actions
- Preventive Actions
- Recommendations
- Follow-Up Actions
Use professional Safety Officer language. Follow NEBOSH/OSHA/Saudi SHE standards. The report must be suitable for submission to management, HSE authorities, and legal records without further editing.
Include watermark at end: "Generated by SafeGPT — Built by Muddaser Abbasi — All Rights Reserved © 2025"]`;
}

function buildManualPrompt(
  typeName: string,
  fields: Record<string, string>,
  header: Record<string, string>,
  visionFindings: string
): string {
  const headerLines = Object.entries(header).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
  const fieldsLines = Object.entries(fields).map(([k, v]) => `${k}: ${v || "N/A"}`).join("\n");

  return `Generate a professional ${typeName} for a construction/industrial site.
Format as a real official safety report a Safety Officer would produce and submit.

${headerLines ? `Report Header:\n${headerLines}\n` : ""}
Report Details:
${fieldsLines}
${visionFindings ? `\nImage Analysis Findings:\n${visionFindings}\n` : ""}

Generate a complete, professional report with all standard H&S sections, proper formatting, and professional language.
Include all relevant sections with the provided data. Start with a formal header block.
Include all standard HSE report sections. Use NEBOSH/OSHA/HSE standards.
Include watermark at end: "Generated by SafeGPT — Built by Muddaser Abbasi — All Rights Reserved © 2025"`;
}

// ─── View / Step types ────────────────────────────────────────────────────────
type AppView = "home" | "create" | "history" | "viewReport";
type Step = "modeSelect" | "typeSelect" | "fill" | "preview";
type Mode = "ai" | "manual";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ReportsScreen() {
  const { projectInfo, activeSite, apiKeys, addAnalyticsRecord } = useApp();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hamburgerOffset } = useLayoutConfig();
  const params = useLocalSearchParams<{ mode?: string }>();

  // ── View state ──────────────────────────────────────────────────────────────
  const [view, setView]               = useState<AppView>("home");
  const [step, setStep]               = useState<Step>("modeSelect");
  const [mode, setMode]               = useState<Mode>("manual");

  // ── Report type selection ───────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<typeof REPORT_TYPES[0] | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [fields,       setFields]      = useState<Record<string, string>>({});
  const [header,       setHeader]      = useState<Record<string, string>>({});
  const [voiceText,    setVoiceText]   = useState("");

  // ── Images ──────────────────────────────────────────────────────────────────
  const [images, setImages] = useState<{ uri: string; file?: File; base64?: string; mime: string }[]>([]);

  // ── Generation ──────────────────────────────────────────────────────────────
  const [isGenerating,    setIsGenerating]    = useState(false);
  const [genPhase,        setGenPhase]        = useState("");
  const [generatedReport, setGeneratedReport] = useState<string | null>(null);
  const [aiSuggestions,   setAiSuggestions]   = useState<SavedReport["aiSuggestions"] | null>(null);

  // ── Saved reports ────────────────────────────────────────────────────────────
  const [savedReports,    setSavedReports]    = useState<SavedReport[]>([]);
  const [searchQuery,     setSearchQuery]     = useState("");
  const [viewingReport,   setViewingReport]   = useState<SavedReport | null>(null);

  // ── Edit / export modal state ─────────────────────────────────────────────
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [editingContent,  setEditingContent]  = useState(false);
  const [exportModal, setExportModal] = useState<{
    visible: boolean;
    forReport?: SavedReport;
  }>({ visible: false });

  // ── Custom report types ───────────────────────────────────────────────────
  const [customTypes,         setCustomTypes]         = useState<CustomReportType[]>([]);
  const [showAddTypeModal,    setShowAddTypeModal]    = useState(false);
  const [newTypeName,         setNewTypeName]         = useState("");
  const [isCreatingType,      setIsCreatingType]      = useState(false);
  const [createTypeError,     setCreateTypeError]     = useState("");

  // All report types combined (built-in + custom)
  const allReportTypes = useMemo(() => [
    ...REPORT_TYPES,
    ...customTypes.map((ct) => ({
      id: ct.id, name: ct.name, nameAr: ct.nameAr,
      icon: ct.icon, color: ct.color, desc: ct.desc,
    })),
  ], [customTypes]);

  // ── Load saved reports + custom types ────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try { setSavedReports(JSON.parse(raw)); } catch { /* ignore */ }
      }
    });
    AsyncStorage.getItem(CUSTOM_TYPES_KEY).then((raw) => {
      if (raw) {
        try { setCustomTypes(JSON.parse(raw)); } catch { /* ignore */ }
      }
    });
  }, []);

  const persistReports = useCallback((list: SavedReport[]) => {
    setSavedReports(list);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }, []);

  const persistCustomTypes = useCallback((list: CustomReportType[]) => {
    setCustomTypes(list);
    AsyncStorage.setItem(CUSTOM_TYPES_KEY, JSON.stringify(list));
  }, []);

  // ── Generate a new custom report type using AI ────────────────────────────
  const handleCreateCustomType = useCallback(async () => {
    const name = newTypeName.trim();
    if (!name) return;

    // Check for duplicates
    const allNames = [...REPORT_TYPES.map((r) => r.name.toLowerCase()), ...customTypes.map((c) => c.name.toLowerCase())];
    if (allNames.includes(name.toLowerCase())) {
      setCreateTypeError("A report type with this name already exists.");
      return;
    }

    setIsCreatingType(true);
    setCreateTypeError("");

    try {
      const prompt = `You are a senior NEBOSH/OSHA/HSE Safety Officer. A user wants to create a new safety report type called "${name}" for a construction/industrial site management system.

Generate the structure for this report type. Return ONLY valid JSON in exactly this format, no other text:
{
  "manualFields": ["Field Name 1", "Field Name 2", "Field Name 3"],
  "aiQuestions": ["Key question 1?", "Key question 2?", "Key question 3?", "Key question 4?"],
  "desc": "Short description (8-12 words)",
  "nameAr": "Arabic translation of the report name"
}

Rules:
- manualFields: 10-14 professional form field names that a Safety Officer would fill in for this type of report
- aiQuestions: Exactly 4 concise key questions for AI-assisted mode
- desc: A brief professional description of when this report is used
- nameAr: Accurate Arabic translation`;

      const { content } = await callAI(apiKeys, prompt, []);

      // Parse JSON from AI response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("AI did not return valid JSON. Please try again.");
      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed.manualFields) || !Array.isArray(parsed.aiQuestions)) {
        throw new Error("Invalid response format. Please try again.");
      }

      const colorIdx = customTypes.length % CUSTOM_TYPE_COLORS.length;
      const iconIdx  = customTypes.length % CUSTOM_TYPE_ICONS.length;

      const newType: CustomReportType = {
        id: `custom_${Date.now()}`,
        name,
        nameAr: parsed.nameAr || name,
        icon: CUSTOM_TYPE_ICONS[iconIdx],
        color: CUSTOM_TYPE_COLORS[colorIdx],
        desc: parsed.desc || `${name} for construction/industrial sites`,
        manualFields: parsed.manualFields.slice(0, 16),
        aiQuestions: parsed.aiQuestions.slice(0, 4),
      };

      persistCustomTypes([...customTypes, newType]);
      setNewTypeName("");
      setShowAddTypeModal(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setCreateTypeError(e?.message || "Failed to generate report structure. Check AI keys in Settings.");
    } finally {
      setIsCreatingType(false);
    }
  }, [newTypeName, customTypes, apiKeys, persistCustomTypes]);

  const deleteCustomType = useCallback((id: string) => {
    Alert.alert("Delete Custom Type", "Remove this custom report type? Existing reports using it will not be affected.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () => persistCustomTypes(customTypes.filter((c) => c.id !== id)),
      },
    ]);
  }, [customTypes, persistCustomTypes]);

  // ── Auto-fill header ────────────────────────────────────────────────────────
  const buildDefaultHeader = useCallback((): Record<string, string> => ({
    "Company Name":    projectInfo?.companyName   || "",
    "Site / Location": activeSite?.name || projectInfo?.siteName || "",
    "Project Name":    projectInfo?.projectName   || "",
    "Safety Officer":  projectInfo?.safetyOfficer || "",
    "Report Date":     new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    "Report Reference": "",
    "Reported By":     "",
    "Investigator":    "",
  }), [projectInfo, activeSite]);

  // ── Nav: enter create flow ──────────────────────────────────────────────────
  const startCreate = useCallback((preMode?: Mode) => {
    setView("create");
    setStep(preMode ? "typeSelect" : "modeSelect");
    if (preMode) setMode(preMode);
    setSelectedType(null);
    setFields({});
    setHeader(buildDefaultHeader());
    setVoiceText("");
    setImages([]);
    setGeneratedReport(null);
    setAiSuggestions(null);
  }, [buildDefaultHeader]);

  // Navigate from params (e.g. from Analytics tab)
  useEffect(() => {
    if (params.mode === "ai" || params.mode === "manual") {
      startCreate(params.mode as Mode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode]);

  const goBack = () => {
    if (view === "history")    { setView("home"); return; }
    if (view === "viewReport") { setView("history"); setViewingReport(null); return; }
    if (view === "create") {
      if (step === "preview")    { setStep("fill"); setGeneratedReport(null); setAiSuggestions(null); return; }
      if (step === "fill")       { setStep("typeSelect"); return; }
      if (step === "typeSelect") { setStep("modeSelect"); return; }
      if (step === "modeSelect") { setView("home"); return; }
    }
  };

  // ── Select type and go to fill ──────────────────────────────────────────────
  const handleSelectType = (type: typeof REPORT_TYPES[0]) => {
    setSelectedType(type);
    setFields({});
    setGeneratedReport(null);
    setAiSuggestions(null);
    setStep("fill");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // ── Image picker ─────────────────────────────────────────────────────────────
  const pickImages = async (fromCamera: boolean) => {
    if (images.length >= 6) {
      Alert.alert("Limit Reached", "Maximum 6 images per report.");
      return;
    }
    try {
      let res: ImagePicker.ImagePickerResult;
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert("Permission needed", "Camera permission is required."); return; }
        res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.65 });
      } else {
        res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], quality: 0.65,
          allowsMultipleSelection: true, selectionLimit: 6 - images.length,
        });
      }
      if (!res.canceled && res.assets.length > 0) {
        const newImgs = res.assets.map((a) => ({ uri: a.uri, mime: "image/jpeg" }));
        setImages((prev) => [...prev, ...newImgs].slice(0, 6));
      }
    } catch { /* ignore */ }
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Analyze images with Gemini Vision ─────────────────────────────────────
  const analyzeImagesWithVision = async (): Promise<string> => {
    if (images.length === 0) return "";
    const typeName = selectedType?.name || "safety incident";
    const findings: string[] = [];

    for (let i = 0; i < images.length; i++) {
      setGenPhase(`Uploading & analyzing image ${i + 1} of ${images.length}...`);
      try {
        const visionPrompt = `You are a certified HSE inspector. Analyze this image for a ${typeName}.
Identify all visible:
- Hazards and unsafe conditions
- PPE compliance (helmet, hi-vis, gloves, harness, footwear)
- Unsafe acts or behaviors
- Injuries, property damage, or fire evidence
- Environmental concerns
- Equipment conditions
Provide structured findings in 8–12 numbered points. Be specific about what you see.`;
        const source = images[i].file ?? images[i].uri;
        const fileUri = await uploadFileToGemini(source, images[i].mime, `image_${i + 1}.jpg`);
        let base64Fallback: string | undefined;
        if (!fileUri) base64Fallback = (await readAsBase64(source)) ?? undefined;
        const { content } = await callAI(
          apiKeys, visionPrompt, [],
          base64Fallback,
          undefined,
          { geminiFileUri: fileUri ?? undefined, visionMimeType: images[i].mime }
        );
        findings.push(`Image ${i + 1} findings:\n${content}`);
      } catch {
        findings.push(`Image ${i + 1}: Analysis unavailable.`);
      }
    }
    return findings.join("\n\n");
  };

  // ── AI Suggest generate ───────────────────────────────────────────────────
  const handleAISuggest = async () => {
    if (!selectedType) return;
    setIsGenerating(true);
    setGenPhase("Preparing...");
    try {
      const visionFindings = await analyzeImagesWithVision();
      setGenPhase("Generating professional report...");

      const questions = AI_QUESTIONS[selectedType.id] || [];
      const answers: Record<string, string> = {};
      questions.forEach((q) => { answers[q] = fields[q] || ""; });

      const prompt = buildAIPrompt(selectedType.name, selectedType.id, answers, header, visionFindings, voiceText);
      const { content } = await callAI(apiKeys, prompt, []);

      const sev      = content.match(/SEVERITY:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || "Medium";
      const immMatch = content.match(/IMMEDIATE ACTIONS:([\s\S]*?)(?:PREVENTIVE ACTIONS:|ROOT CAUSE:|FULL REPORT:)/i);
      const prevMatch= content.match(/PREVENTIVE ACTIONS:([\s\S]*?)(?:ROOT CAUSE:|FULL REPORT:)/i);
      const rootMatch= content.match(/ROOT CAUSE:([\s\S]*?)(?:FULL REPORT:)/i);
      const fullMatch= content.match(/FULL REPORT:([\s\S]*)/i);

      const suggestions = {
        severity:         sev,
        immediateActions: immMatch?.[1]?.trim() || "",
        preventiveActions:prevMatch?.[1]?.trim() || "",
        rootCause:        rootMatch?.[1]?.trim() || "",
      };
      const reportText = fullMatch?.[1]?.trim() || content;

      setAiSuggestions(suggestions);
      setGeneratedReport(reportText);

      const sevLevel: "low" | "medium" | "high" =
        sev.toLowerCase().includes("high") || sev.toLowerCase().includes("critical") ? "high"
        : sev.toLowerCase().includes("low") ? "low" : "medium";
      addAnalyticsRecord({
        type: (selectedType.id as any) || "other",
        description: fields[AI_QUESTIONS[selectedType.id]?.[0] || ""] || selectedType.name,
        date: new Date().toISOString(),
        location: header["Site / Location"] || undefined,
        severity: sevLevel,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("preview");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to generate report. Check API keys in Settings.");
    } finally {
      setIsGenerating(false);
      setGenPhase("");
    }
  };

  // ── Manual generate ──────────────────────────────────────────────────────
  const handleManualGenerate = async () => {
    if (!selectedType) return;
    setIsGenerating(true);
    setGenPhase("Preparing...");
    try {
      const visionFindings = await analyzeImagesWithVision();
      setGenPhase("Generating report...");
      const prompt = buildManualPrompt(selectedType.name, fields, header, visionFindings);
      const { content } = await callAI(apiKeys, prompt, []);
      setGeneratedReport(content);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("preview");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to generate report. Check API keys in Settings.");
    } finally {
      setIsGenerating(false);
      setGenPhase("");
    }
  };

  // ── Save current report ───────────────────────────────────────────────────
  const saveReport = useCallback(() => {
    if (!selectedType || !generatedReport) return;

    if (editingReportId) {
      // Update existing report in place
      const updated = savedReports.map((r) =>
        r.id === editingReportId
          ? { ...r, content: generatedReport, fields: { ...fields }, header: { ...header }, aiSuggestions: aiSuggestions || undefined }
          : r
      );
      persistReports(updated);
      setEditingReportId(null);
      setEditingContent(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Report Updated", "Your changes have been saved.", [
        { text: "View History", onPress: () => { setView("history"); setStep("modeSelect"); } },
        { text: "OK" },
      ]);
    } else {
      const report: SavedReport = {
        id: genId(),
        type: selectedType.id,
        typeName: selectedType.name,
        content: generatedReport,
        fields: { ...fields },
        header: { ...header },
        date: new Date().toISOString(),
        mode,
        aiSuggestions: aiSuggestions || undefined,
      };
      persistReports([report, ...savedReports]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Report Saved", "Report has been saved to History.", [
        { text: "View History", onPress: () => { setView("history"); setStep("modeSelect"); } },
        { text: "OK" },
      ]);
    }
  }, [selectedType, generatedReport, fields, header, mode, aiSuggestions, savedReports, persistReports, editingReportId]);

  // ── Edit a saved report ──────────────────────────────────────────────────
  const editReport = useCallback((report: SavedReport) => {
    const rt = allReportTypes.find((r) => r.id === report.type);
    if (!rt) return;
    setEditingReportId(report.id);
    setEditingContent(false);
    setSelectedType(rt);
    setMode(report.mode);
    setFields({ ...report.fields });
    setHeader({ ...report.header });
    setGeneratedReport(report.content);
    setAiSuggestions(report.aiSuggestions || null);
    setVoiceText("");
    setImages([]);
    setView("create");
    setStep("preview");
    setViewingReport(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [allReportTypes]);

  // ── Delete saved report ──────────────────────────────────────────────────
  const deleteReport = (id: string) => {
    Alert.alert("Delete Report", "Delete this report permanently?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () => {
          const updated = savedReports.filter((r) => r.id !== id);
          persistReports(updated);
          if (viewingReport?.id === id) { setViewingReport(null); setView("history"); }
        },
      },
    ]);
  };

  // ── Export: download / share text ─────────────────────────────────────────
  const doExport = useCallback((reports: SavedReport[], label: string) => {
    if (reports.length === 0) { Alert.alert("No Reports", "No reports found for the selected range."); return; }
    const text = reports.map((r) =>
      [`=== ${r.typeName} ===`, `Date: ${formatDate(r.date)}`, `Mode: ${r.mode === "ai" ? "AI Suggest" : "Manual"}`, "", r.content].join("\n")
    ).join("\n\n" + "=".repeat(60) + "\n\n");

    if (Platform.OS === "web") {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `SafeGPT-Reports-${label.replace(/\s/g, "-")}-${Date.now()}.txt`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } else {
      Share.share({ message: text, title: `SafeGPT Reports — ${label}` }).catch(() => {});
    }
  }, []);

  const openExportModal = useCallback((forReport?: SavedReport) => {
    setExportModal({ visible: true, forReport });
  }, []);

  // ── Export report (single, legacy compat) ─────────────────────────────────
  const exportReport = useCallback((report: SavedReport) => {
    setExportModal({ visible: true, forReport: report });
  }, []);

  // ── Filtered history ──────────────────────────────────────────────────────
  const filteredReports = useMemo(() => {
    if (!searchQuery.trim()) return savedReports;
    const q = searchQuery.toLowerCase();
    return savedReports.filter(
      (r) =>
        r.typeName.toLowerCase().includes(q) ||
        r.content.toLowerCase().includes(q) ||
        Object.values(r.fields).some((v) => v.toLowerCase().includes(q))
    );
  }, [savedReports, searchQuery]);

  // ── Active type meta ──────────────────────────────────────────────────────
  // Resolve fields for the selected type — handles both built-in and custom types
  const currentFields = useMemo(() => {
    if (!selectedType) return [];
    // Check built-in fields first
    if (mode === "ai") {
      if (AI_QUESTIONS[selectedType.id]) return AI_QUESTIONS[selectedType.id];
    } else {
      if (MANUAL_FIELDS[selectedType.id]) return MANUAL_FIELDS[selectedType.id];
    }
    // Fall back to custom type fields
    const custom = customTypes.find((c) => c.id === selectedType.id);
    if (custom) return mode === "ai" ? custom.aiQuestions : custom.manualFields;
    return [];
  }, [selectedType, mode, customTypes]);

  const showBack = view !== "home";

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={[styles.header, {
        backgroundColor: colors.headerBackground,
        borderBottomColor: colors.border,
        paddingTop: insets.top + (Platform.OS === "android" ? 14 : 12),
      }]}>
        <View style={{ width: hamburgerOffset + 4 }} />
        <View style={[styles.headerIcon, { backgroundColor: colors.primary + "20" }]}>
          <Feather name="file-text" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Safety Reports</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {view === "history" ? `History · ${savedReports.length} report${savedReports.length !== 1 ? "s" : ""}`
              : view === "viewReport" ? viewingReport?.typeName || ""
              : view === "create" && selectedType ? selectedType.name
              : "تقارير السلامة"}
          </Text>
        </View>
        {showBack ? (
          <TouchableOpacity onPress={goBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Feather name="arrow-left" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => { setView("history"); setSearchQuery(""); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Feather name="clock" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

      {/* ════════════════ HOME ════════════════ */}
      {view === "home" && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>
            HSE Report Management
          </Text>
          <Text style={[styles.pageSub, { color: colors.mutedForeground }]}>
            Create, save, search and export professional safety reports
          </Text>

          {/* New Report */}
          <TouchableOpacity
            style={[styles.homeActionCard, { backgroundColor: colors.card, borderColor: colors.primary + "50" }]}
            onPress={() => startCreate()}
            activeOpacity={0.8}
          >
            <LinearGradient
              colors={[colors.primary, "#FF8C60"]}
              style={styles.homeActionIcon}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              <Feather name="plus" size={26} color="#fff" />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={[styles.homeActionTitle, { color: colors.foreground }]}>Create New Report</Text>
              <Text style={[styles.homeActionSub, { color: colors.mutedForeground }]}>
                Manual entry or AI-assisted generation with photos & video analysis
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.primary} />
          </TouchableOpacity>

          {/* Quick shortcut: AI mode */}
          <TouchableOpacity
            style={[styles.homeActionCard, { backgroundColor: colors.card, borderColor: colors.primary + "25" }]}
            onPress={() => startCreate("ai")}
            activeOpacity={0.8}
          >
            <View style={[styles.homeActionIcon, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="cpu" size={26} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.homeActionTitle, { color: colors.foreground }]}>🤖 Quick AI Report</Text>
              <Text style={[styles.homeActionSub, { color: colors.mutedForeground }]}>
                Give basic details + photos — AI writes the full report
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.primary} />
          </TouchableOpacity>

          {/* History */}
          <TouchableOpacity
            style={[styles.homeActionCard, { backgroundColor: colors.card, borderColor: "#33415550" }]}
            onPress={() => { setView("history"); setSearchQuery(""); }}
            activeOpacity={0.8}
          >
            <View style={[styles.homeActionIcon, { backgroundColor: "#33415560" }]}>
              <Feather name="archive" size={26} color="#94a3b8" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.homeActionTitle, { color: colors.foreground }]}>Report History</Text>
              <Text style={[styles.homeActionSub, { color: colors.mutedForeground }]}>
                {savedReports.length > 0
                  ? `${savedReports.length} saved report${savedReports.length !== 1 ? "s" : ""} — search, edit & export`
                  : "No saved reports yet"}
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color="#64748b" />
          </TouchableOpacity>

          {/* Report types grid preview */}
          <View style={styles.sectionLabelRow}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              AVAILABLE REPORT TYPES ({allReportTypes.length})
            </Text>
            <TouchableOpacity
              style={[styles.addTypeBtn, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}
              onPress={() => { setNewTypeName(""); setCreateTypeError(""); setShowAddTypeModal(true); }}
              activeOpacity={0.8}
            >
              <Feather name="plus" size={13} color={colors.primary} />
              <Text style={[styles.addTypeBtnText, { color: colors.primary }]}>Add Custom Type</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.typeGrid}>
            {allReportTypes.map((rt) => {
              const isCustom = customTypes.some((c) => c.id === rt.id);
              return (
                <TouchableOpacity
                  key={rt.id}
                  style={[styles.typeChip, { backgroundColor: rt.color + "18", borderColor: rt.color + "40" }]}
                  onPress={() => startCreate()}
                  onLongPress={() => isCustom && deleteCustomType(rt.id)}
                  activeOpacity={0.7}
                >
                  <Feather name={rt.icon as any} size={13} color={rt.color} />
                  <Text style={[styles.typeChipText, { color: rt.color }]} numberOfLines={2}>{rt.name}</Text>
                  {isCustom && <Feather name="star" size={9} color={rt.color} style={{ opacity: 0.7 }} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
      )}

      {/* ════════════════ CREATE — Step: Mode Select ════════════════ */}
      {view === "create" && step === "modeSelect" && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>How to create this report?</Text>
          <Text style={[styles.pageSub, { color: colors.mutedForeground }]}>كيف تريد إنشاء التقرير؟</Text>

          <TouchableOpacity
            style={[styles.modeCard, { backgroundColor: colors.card, borderColor: colors.primary }]}
            onPress={() => { setMode("ai"); setStep("typeSelect"); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            activeOpacity={0.8}
          >
            <LinearGradient colors={[colors.primary, "#FF8C60"]} style={styles.modeIconBox} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Feather name="cpu" size={26} color="#fff" />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={[styles.modeTitle, { color: colors.foreground }]}>🤖 AI Suggestion Mode</Text>
              <Text style={[styles.modeSub, { color: colors.mutedForeground }]}>
                Provide basic details, photos & videos — AI generates the complete professional report
              </Text>
              <Text style={[styles.modeSub, { color: colors.primary, marginTop: 4 }]}>
                أدخل التفاصيل الأساسية والصور ويكتب الذكاء الاصطناعي التقرير الكامل
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeCard, { backgroundColor: colors.card, borderColor: "#334155" }]}
            onPress={() => { setMode("manual"); setStep("typeSelect"); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            activeOpacity={0.8}
          >
            <View style={[styles.modeIconBox, { backgroundColor: "#334155" }]}>
              <Feather name="edit-3" size={26} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.modeTitle, { color: colors.foreground }]}>✏️ Manual Entry Mode</Text>
              <Text style={[styles.modeSub, { color: colors.mutedForeground }]}>
                Fill professional industry-standard forms — full control over all sections
              </Text>
              <Text style={[styles.modeSub, { color: colors.mutedForeground, marginTop: 4 }]}>
                أملأ جميع الحقول المهنية بنفسك مع كامل التحكم
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color="#64748b" />
          </TouchableOpacity>

          <View style={[styles.infoBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}>
            <Feather name="info" size={14} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.primary }]}>
              No fields are mandatory. You can save incomplete reports and edit them later.
            </Text>
          </View>
        </ScrollView>
      )}

      {/* ════════════════ CREATE — Step: Type Select ════════════════ */}
      {view === "create" && step === "typeSelect" && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.modeBadge, { backgroundColor: mode === "ai" ? colors.primary + "20" : "#33415520" }]}>
            <Feather name={mode === "ai" ? "cpu" : "edit-3"} size={13} color={mode === "ai" ? colors.primary : "#64748b"} />
            <Text style={[styles.modeBadgeText, { color: mode === "ai" ? colors.primary : "#64748b" }]}>
              {mode === "ai" ? "AI Suggestion Mode" : "Manual Entry Mode"}
            </Text>
          </View>

          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Select Report Type</Text>
          <Text style={[styles.pageSub, { color: colors.mutedForeground }]}>اختر نوع التقرير</Text>

          {allReportTypes.map((rt) => {
            const isCustom = customTypes.some((c) => c.id === rt.id);
            return (
              <TouchableOpacity
                key={rt.id}
                style={[styles.typeRowCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => handleSelectType(rt)}
                activeOpacity={0.8}
              >
                <View style={[styles.typeRowIcon, { backgroundColor: rt.color + "20" }]}>
                  <Feather name={rt.icon as any} size={22} color={rt.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={[styles.typeRowName, { color: colors.foreground }]}>{rt.name}</Text>
                    {isCustom && (
                      <View style={[styles.customBadge, { backgroundColor: rt.color + "20" }]}>
                        <Text style={[styles.customBadgeText, { color: rt.color }]}>Custom</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.typeRowDesc, { color: colors.mutedForeground }]}>{rt.desc}</Text>
                  <Text style={[styles.typeRowAr, { color: rt.color }]}>{rt.nameAr}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* ════════════════ CREATE — Step: Fill ════════════════ */}
      {view === "create" && step === "fill" && selectedType && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Mode badge */}
          <View style={[styles.modeBadge, { backgroundColor: mode === "ai" ? colors.primary + "20" : "#33415520" }]}>
            <Feather name={mode === "ai" ? "cpu" : "edit-3"} size={13} color={mode === "ai" ? colors.primary : "#64748b"} />
            <Text style={[styles.modeBadgeText, { color: mode === "ai" ? colors.primary : "#64748b" }]}>
              {mode === "ai" ? "AI Suggestion — answer key questions, AI does the rest" : "Manual Entry — professional form"}
            </Text>
          </View>

          {/* Type header */}
          <View style={[styles.typeHeader, { backgroundColor: selectedType.color + "15", borderColor: selectedType.color + "35" }]}>
            <View style={[styles.typeHeaderIcon, { backgroundColor: selectedType.color + "25" }]}>
              <Feather name={selectedType.icon as any} size={22} color={selectedType.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.typeHeaderName, { color: selectedType.color }]}>{selectedType.name}</Text>
              <Text style={[styles.typeHeaderAr, { color: colors.mutedForeground }]}>{selectedType.nameAr}</Text>
            </View>
          </View>

          {/* Report info (auto-filled, all optional) */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeaderRow}>
              <Feather name="info" size={13} color={colors.primary} />
              <Text style={[styles.sectionHeaderText, { color: colors.primary }]}>Report Information</Text>
              <Text style={[styles.optTag, { color: colors.mutedForeground }]}>(all optional)</Text>
            </View>
            {Object.keys(header).map((hKey) => (
              <View key={hKey} style={styles.inlineField}>
                <Text style={[styles.inlineFieldLabel, { color: colors.mutedForeground }]}>{hKey}</Text>
                <View style={[styles.inlineFieldInput, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <TextInput
                    style={[styles.textInput, { color: colors.foreground, minHeight: 34 }]}
                    placeholder={`${hKey}...`}
                    placeholderTextColor={colors.mutedForeground + "70"}
                    value={header[hKey]}
                    onChangeText={(v) => setHeader((p) => ({ ...p, [hKey]: v }))}
                    autoCorrect={false}
                  />
                </View>
              </View>
            ))}
          </View>

          {/* Main form fields */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeaderRow}>
              <Feather name={mode === "ai" ? "cpu" : "list"} size={13} color={colors.primary} />
              <Text style={[styles.sectionHeaderText, { color: colors.primary }]}>
                {mode === "ai" ? "Key Questions" : "Report Details"}
              </Text>
              <Text style={[styles.optTag, { color: colors.mutedForeground }]}>(no mandatory fields)</Text>
            </View>
            {currentFields.map((fieldName) => (
              <View key={fieldName} style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{fieldName}</Text>
                <View style={[styles.fieldInput, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <TextInput
                    style={[styles.textInput, { color: colors.foreground }]}
                    placeholder={mode === "ai" ? "Your answer (optional)..." : `${fieldName.split("(")[0].trim()}...`}
                    placeholderTextColor={colors.mutedForeground + "70"}
                    value={fields[fieldName] || ""}
                    onChangeText={(v) => setFields((p) => ({ ...p, [fieldName]: v }))}
                    multiline
                    textAlignVertical="top"
                  />
                </View>
              </View>
            ))}
          </View>

          {/* Voice / additional notes */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeaderRow}>
              <Feather name="mic" size={13} color={colors.primary} />
              <Text style={[styles.sectionHeaderText, { color: colors.primary }]}>Additional Notes / Voice Description</Text>
              <Text style={[styles.optTag, { color: colors.mutedForeground }]}>(optional)</Text>
            </View>
            <View style={[styles.fieldInput, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <TextInput
                style={[styles.textInput, { color: colors.foreground, minHeight: 80 }]}
                placeholder="Describe the incident in your own words, add any additional context, observations, or voice-recorded notes here..."
                placeholderTextColor={colors.mutedForeground + "70"}
                value={voiceText}
                onChangeText={setVoiceText}
                multiline
                textAlignVertical="top"
              />
            </View>
          </View>

          {/* Image/Video attachment */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeaderRow}>
              <Feather name="camera" size={13} color={colors.primary} />
              <Text style={[styles.sectionHeaderText, { color: colors.primary }]}>
                Photos / Videos
              </Text>
              <Text style={[styles.optTag, { color: colors.mutedForeground }]}>(up to 6 — Gemini Vision analyzes)</Text>
            </View>

            {/* Image picker buttons */}
            <View style={styles.imagePickerRow}>
              {Platform.OS !== "web" && (
                <TouchableOpacity
                  style={[styles.imagePickerBtn, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}
                  onPress={() => pickImages(true)}
                  activeOpacity={0.8}
                >
                  <Feather name="camera" size={16} color={colors.primary} />
                  <Text style={[styles.imagePickerBtnText, { color: colors.primary }]}>Camera</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.imagePickerBtn, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}
                onPress={() => pickImages(false)}
                activeOpacity={0.8}
              >
                <Feather name="image" size={16} color={colors.primary} />
                <Text style={[styles.imagePickerBtnText, { color: colors.primary }]}>Gallery</Text>
              </TouchableOpacity>
            </View>

            {/* Image thumbnails */}
            {images.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                <View style={styles.imageRow}>
                  {images.map((img, idx) => (
                    <View key={idx} style={styles.thumbWrap}>
                      <Image source={{ uri: img.uri }} style={styles.thumb} />
                      <TouchableOpacity
                        style={styles.thumbDelete}
                        onPress={() => removeImage(idx)}
                      >
                        <Feather name="x" size={12} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}

            {images.length > 0 && (
              <View style={[styles.infoBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "25", marginTop: 8 }]}>
                <Feather name="info" size={12} color={colors.primary} />
                <Text style={[styles.infoText, { color: colors.primary, fontSize: 11 }]}>
                  {images.length} image{images.length > 1 ? "s" : ""} will be analyzed by Gemini Vision before report generation
                </Text>
              </View>
            )}
          </View>

          {/* Generate button */}
          <TouchableOpacity
            style={[styles.generateBtn, { opacity: isGenerating ? 0.7 : 1 }]}
            onPress={mode === "ai" ? handleAISuggest : handleManualGenerate}
            disabled={isGenerating}
            activeOpacity={0.8}
          >
            <LinearGradient
              colors={mode === "ai" ? [colors.primary, "#FF8C60"] : ["#334155", "#1e293b"]}
              style={styles.generateGradient}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            >
              {isGenerating ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.generateText}>{genPhase || "Generating..."}</Text>
                </>
              ) : (
                <>
                  <Feather name={mode === "ai" ? "cpu" : "file-text"} size={20} color="#fff" />
                  <Text style={styles.generateText}>
                    {mode === "ai" ? "Generate AI Report" : "Generate Report"}
                  </Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ════════════════ CREATE — Step: Preview ════════════════ */}
      {view === "create" && step === "preview" && generatedReport && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          {/* AI Suggestions panel */}
          {mode === "ai" && aiSuggestions && (
            <View style={[styles.aiCard, { backgroundColor: colors.card, borderColor: colors.primary + "40" }]}>
              <View style={styles.aiCardHeader}>
                <Feather name="cpu" size={15} color={colors.primary} />
                <Text style={[styles.aiCardTitle, { color: colors.primary }]}>AI Safety Analysis</Text>
              </View>
              <SuggestionRow label="⚠️ Severity" value={aiSuggestions.severity} colors={colors} />
              <SuggestionRow label="🚨 Immediate Actions" value={aiSuggestions.immediateActions} colors={colors} last={false} />
              <SuggestionRow label="🛡️ Preventive Actions" value={aiSuggestions.preventiveActions} colors={colors} last={false} />
              <SuggestionRow label="🔍 Root Cause" value={aiSuggestions.rootCause} colors={colors} last />
            </View>
          )}

          {/* Edit mode banner */}
          {editingReportId && (
            <View style={[styles.infoBox, { backgroundColor: "#f59e0b15", borderColor: "#f59e0b40" }]}>
              <Feather name="edit-2" size={14} color="#f59e0b" />
              <Text style={[styles.infoText, { color: "#f59e0b" }]}>
                Editing saved report — save to update it, or re-generate with new data.
              </Text>
            </View>
          )}

          {/* Action bar */}
          <View style={[styles.previewActions, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: colors.primary }]}
              onPress={saveReport}
            >
              <Feather name="save" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>{editingReportId ? "Save Changes" : "Save"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: "#334155" }]}
              onPress={() => openExportModal()}
            >
              <Feather name="download" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>Export</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: editingContent ? "#10b981" : "#1e293b" }]}
              onPress={() => setEditingContent((v) => !v)}
            >
              <Feather name={editingContent ? "eye" : "edit-2"} size={15} color="#fff" />
              <Text style={styles.previewBtnText}>{editingContent ? "View" : "Edit Text"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: "#475569" }]}
              onPress={() => { setStep("fill"); setEditingContent(false); }}
            >
              <Feather name="list" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>Fields</Text>
            </TouchableOpacity>
          </View>

          {/* Full report */}
          <View style={[styles.reportBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.reportBoxHeader}>
              <Feather name="file-text" size={14} color={colors.primary} />
              <Text style={[styles.reportBoxTitle, { color: colors.primary }]}>
                {selectedType?.name}
              </Text>
              {editingContent && (
                <View style={[styles.editingBadge, { backgroundColor: "#10b98120" }]}>
                  <Feather name="edit-2" size={10} color="#10b981" />
                  <Text style={[styles.editingBadgeText, { color: "#10b981" }]}>Editing</Text>
                </View>
              )}
            </View>
            {editingContent ? (
              <TextInput
                style={[styles.reportText, styles.reportEditInput, { color: colors.foreground, borderColor: colors.border }]}
                value={generatedReport || ""}
                onChangeText={(v) => setGeneratedReport(v)}
                multiline
                textAlignVertical="top"
                autoCorrect={false}
              />
            ) : (
              <Text style={[styles.reportText, { color: colors.foreground }]}>{generatedReport}</Text>
            )}
          </View>
        </ScrollView>
      )}

      {/* ════════════════ HISTORY ════════════════ */}
      {view === "history" && (
        <View style={{ flex: 1 }}>
          {/* Search bar */}
          <View style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              placeholder="Search reports..."
              placeholderTextColor={colors.mutedForeground + "80"}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery("")}>
                <Feather name="x" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
            showsVerticalScrollIndicator={false}
          >
            {/* New report button */}
            <TouchableOpacity
              style={[styles.newReportRow, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "30" }]}
              onPress={() => startCreate()}
              activeOpacity={0.8}
            >
              <Feather name="plus-circle" size={16} color={colors.primary} />
              <Text style={[styles.newReportRowText, { color: colors.primary }]}>Create New Report</Text>
            </TouchableOpacity>

            {filteredReports.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="archive" size={42} color={colors.mutedForeground + "60"} />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  {searchQuery ? "No matching reports" : "No saved reports yet"}
                </Text>
                <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
                  {searchQuery ? "Try a different search term" : "Create your first report to get started"}
                </Text>
              </View>
            ) : (
              filteredReports.map((report) => {
                const rt = REPORT_TYPES.find((r) => r.id === report.type);
                return (
                  <TouchableOpacity
                    key={report.id}
                    style={[styles.historyCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                    onPress={() => { setViewingReport(report); setView("viewReport"); }}
                    activeOpacity={0.8}
                  >
                    <View style={[styles.historyCardIcon, { backgroundColor: (rt?.color || colors.primary) + "20" }]}>
                      <Feather name={(rt?.icon || "file-text") as any} size={18} color={rt?.color || colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.historyCardTitle, { color: colors.foreground }]} numberOfLines={1}>
                        {report.typeName}
                      </Text>
                      <Text style={[styles.historyCardDate, { color: colors.mutedForeground }]}>
                        {formatDate(report.date)} · {report.mode === "ai" ? "AI" : "Manual"}
                      </Text>
                      <Text style={[styles.historyCardPreview, { color: colors.mutedForeground }]} numberOfLines={2}>
                        {report.content.slice(0, 120)}...
                      </Text>
                    </View>
                    <View style={styles.historyCardActions}>
                      <TouchableOpacity
                        onPress={() => exportReport(report)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ padding: 6 }}
                      >
                        <Feather name="share-2" size={16} color={colors.mutedForeground} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => deleteReport(report.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={{ padding: 6 }}
                      >
                        <Feather name="trash-2" size={16} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </View>
      )}

      {/* ════════════════ VIEW REPORT ════════════════ */}
      {view === "viewReport" && viewingReport && (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Meta */}
          <View style={[styles.viewReportMeta, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {(() => {
              const rt = REPORT_TYPES.find((r) => r.id === viewingReport.type);
              return (
                <View style={[styles.typeHeader, { backgroundColor: (rt?.color || colors.primary) + "15", borderColor: (rt?.color || colors.primary) + "30" }]}>
                  <View style={[styles.typeHeaderIcon, { backgroundColor: (rt?.color || colors.primary) + "25" }]}>
                    <Feather name={(rt?.icon || "file-text") as any} size={22} color={rt?.color || colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.typeHeaderName, { color: rt?.color || colors.primary }]}>{viewingReport.typeName}</Text>
                    <Text style={[styles.historyCardDate, { color: colors.mutedForeground }]}>
                      {formatDate(viewingReport.date)} · {viewingReport.mode === "ai" ? "AI Suggestion" : "Manual Entry"}
                    </Text>
                  </View>
                </View>
              );
            })()}
          </View>

          {/* AI suggestions if available */}
          {viewingReport.aiSuggestions && (
            <View style={[styles.aiCard, { backgroundColor: colors.card, borderColor: colors.primary + "40" }]}>
              <View style={styles.aiCardHeader}>
                <Feather name="cpu" size={15} color={colors.primary} />
                <Text style={[styles.aiCardTitle, { color: colors.primary }]}>AI Safety Analysis</Text>
              </View>
              <SuggestionRow label="⚠️ Severity" value={viewingReport.aiSuggestions.severity} colors={colors} />
              <SuggestionRow label="🚨 Immediate Actions" value={viewingReport.aiSuggestions.immediateActions} colors={colors} last={false} />
              <SuggestionRow label="🛡️ Preventive Actions" value={viewingReport.aiSuggestions.preventiveActions} colors={colors} last={false} />
              <SuggestionRow label="🔍 Root Cause" value={viewingReport.aiSuggestions.rootCause} colors={colors} last />
            </View>
          )}

          {/* Action buttons */}
          <View style={[styles.previewActions, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: colors.primary }]}
              onPress={() => editReport(viewingReport)}
            >
              <Feather name="edit-2" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: "#334155" }]}
              onPress={() => exportReport(viewingReport)}
            >
              <Feather name="download" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>Export</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtn, { backgroundColor: "#ef4444" }]}
              onPress={() => deleteReport(viewingReport.id)}
            >
              <Feather name="trash-2" size={15} color="#fff" />
              <Text style={styles.previewBtnText}>Delete</Text>
            </TouchableOpacity>
          </View>

          {/* Report content */}
          <View style={[styles.reportBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.reportBoxHeader}>
              <Feather name="file-text" size={14} color={colors.primary} />
              <Text style={[styles.reportBoxTitle, { color: colors.primary }]}>Full Report</Text>
            </View>
            <Text style={[styles.reportText, { color: colors.foreground }]}>{viewingReport.content}</Text>
          </View>
        </ScrollView>
      )}

      {/* ── Export Range Modal ─────────────────────────────────────────────── */}
      <ExportRangeModal
        visible={exportModal.visible}
        forReport={exportModal.forReport}
        allReports={savedReports}
        colors={colors}
        onClose={() => setExportModal({ visible: false })}
        onExport={doExport}
      />

      {/* ── Add Custom Report Type Modal ─────────────────────────────────────── */}
      <Modal visible={showAddTypeModal} transparent animationType="fade" onRequestClose={() => setShowAddTypeModal(false)}>
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 }}
          activeOpacity={1}
          onPress={() => !isCreatingType && setShowAddTypeModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={{ width: "100%", maxWidth: 400 }}>
            <View style={[styles.addTypeModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {/* Header */}
              <View style={styles.addTypeModalHeader}>
                <View style={[styles.addTypeModalIcon, { backgroundColor: colors.primary + "20" }]}>
                  <Feather name="plus-circle" size={22} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addTypeModalTitle, { color: colors.foreground }]}>Add Custom Report Type</Text>
                  <Text style={[styles.addTypeModalSub, { color: colors.mutedForeground }]}>
                    AI will generate the form fields automatically
                  </Text>
                </View>
                {!isCreatingType && (
                  <TouchableOpacity onPress={() => setShowAddTypeModal(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="x" size={18} color={colors.mutedForeground} />
                  </TouchableOpacity>
                )}
              </View>

              {/* How it works */}
              <View style={[styles.infoBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "25" }]}>
                <Feather name="info" size={13} color={colors.primary} />
                <Text style={[styles.infoText, { color: colors.primary }]}>
                  Enter any report type that doesn't already exist. AI will analyze it and generate all the required form fields, questions, and structure — ready to use immediately in both Manual and AI modes.
                </Text>
              </View>

              {/* Name input */}
              <Text style={[styles.addTypeInputLabel, { color: colors.mutedForeground }]}>Report Type Name</Text>
              <View style={[styles.addTypeInput, { backgroundColor: colors.muted || colors.background, borderColor: isCreatingType ? colors.border : colors.primary + "60" }]}>
                <TextInput
                  style={[{ flex: 1, fontSize: 15, fontFamily: "Inter_400Regular", color: colors.foreground }]}
                  placeholder='e.g. "Contractor Induction Report", "Hot Work Permit", "LOTO Checklist"'
                  placeholderTextColor={colors.mutedForeground + "80"}
                  value={newTypeName}
                  onChangeText={(v) => { setNewTypeName(v); setCreateTypeError(""); }}
                  autoCapitalize="words"
                  editable={!isCreatingType}
                  returnKeyType="done"
                  onSubmitEditing={handleCreateCustomType}
                />
              </View>

              {/* Error */}
              {createTypeError ? (
                <View style={[styles.errorRow, { backgroundColor: "#ef444415", borderColor: "#ef444430" }]}>
                  <Feather name="alert-circle" size={13} color="#ef4444" />
                  <Text style={{ flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: "#ef4444", lineHeight: 17 }}>
                    {createTypeError}
                  </Text>
                </View>
              ) : null}

              {/* Generate button */}
              <TouchableOpacity
                style={[styles.generateBtn, { opacity: !newTypeName.trim() || isCreatingType ? 0.5 : 1 }]}
                onPress={handleCreateCustomType}
                disabled={!newTypeName.trim() || isCreatingType}
                activeOpacity={0.8}
              >
                <LinearGradient
                  colors={[colors.primary, "#FF8C60"]}
                  style={styles.generateGradient}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                >
                  {isCreatingType ? (
                    <>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.generateText}>AI is generating form fields…</Text>
                    </>
                  ) : (
                    <>
                      <Feather name="cpu" size={18} color="#fff" />
                      <Text style={styles.generateText}>Generate with AI</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>

              <Text style={[styles.addTypeModalHint, { color: colors.mutedForeground }]}>
                Long-press a custom type in the grid to delete it
              </Text>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─── Export Range Modal ────────────────────────────────────────────────────────
function ExportRangeModal({
  visible,
  forReport,
  allReports,
  colors,
  onClose,
  onExport,
}: {
  visible: boolean;
  forReport?: SavedReport;
  allReports: SavedReport[];
  colors: any;
  onClose: () => void;
  onExport: (reports: SavedReport[], label: string) => void;
}) {
  const now = Date.now();
  const options: { label: string; labelAr: string; icon: string; color: string; getReports: () => SavedReport[] }[] = [
    ...(forReport ? [{
      label: "This Report Only", labelAr: "هذا التقرير فقط",
      icon: "file-text", color: "#FF6B35",
      getReports: () => [forReport],
    }] : []),
    {
      label: "Last 7 Days", labelAr: "آخر ٧ أيام",
      icon: "calendar", color: "#3b82f6",
      getReports: () => allReports.filter((r) => now - new Date(r.date).getTime() <= 7 * 86400000),
    },
    {
      label: "Last 15 Days", labelAr: "آخر ١٥ يوم",
      icon: "calendar", color: "#8b5cf6",
      getReports: () => allReports.filter((r) => now - new Date(r.date).getTime() <= 15 * 86400000),
    },
    {
      label: "Last 30 Days", labelAr: "آخر ٣٠ يوم",
      icon: "calendar", color: "#10b981",
      getReports: () => allReports.filter((r) => now - new Date(r.date).getTime() <= 30 * 86400000),
    },
    {
      label: "Last 3 Months", labelAr: "آخر ٣ أشهر",
      icon: "calendar", color: "#f59e0b",
      getReports: () => allReports.filter((r) => now - new Date(r.date).getTime() <= 90 * 86400000),
    },
    {
      label: "All Reports", labelAr: "جميع التقارير",
      icon: "archive", color: "#ef4444",
      getReports: () => allReports,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
        activeOpacity={1} onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1}>
          <View style={[exportModalStyles.sheet, { backgroundColor: colors.card }]}>
            <View style={exportModalStyles.handle} />
            <View style={exportModalStyles.sheetHeader}>
              <Feather name="download" size={18} color={colors.primary} />
              <Text style={[exportModalStyles.sheetTitle, { color: colors.foreground }]}>Export Reports</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <Text style={[exportModalStyles.sheetSub, { color: colors.mutedForeground }]}>
              Select the time range to export · اختر نطاق الوقت للتصدير
            </Text>
            {options.map((opt, i) => {
              const count = opt.getReports().length;
              return (
                <TouchableOpacity
                  key={i}
                  style={[exportModalStyles.optionRow, { borderColor: colors.border }]}
                  onPress={() => { onClose(); onExport(opt.getReports(), opt.label); }}
                  activeOpacity={0.75}
                >
                  <View style={[exportModalStyles.optIcon, { backgroundColor: opt.color + "20" }]}>
                    <Feather name={opt.icon as any} size={18} color={opt.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[exportModalStyles.optLabel, { color: colors.foreground }]}>{opt.label}</Text>
                    <Text style={[exportModalStyles.optAr, { color: colors.mutedForeground }]}>{opt.labelAr}</Text>
                  </View>
                  <View style={[exportModalStyles.countBadge, { backgroundColor: opt.color + "20" }]}>
                    <Text style={[exportModalStyles.countText, { color: opt.color }]}>{count}</Text>
                  </View>
                  <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              );
            })}
            <View style={{ height: 24 }} />
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const exportModalStyles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 12 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#334155", alignSelf: "center", marginBottom: 16 },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontFamily: "Inter_700Bold" },
  sheetSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 14, lineHeight: 18 },
  optionRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  optLabel: { fontSize: 14, fontFamily: "Inter_700Bold" },
  optAr: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  countBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  countText: { fontSize: 12, fontFamily: "Inter_700Bold" },
});

// ─── Reusable sub-component ───────────────────────────────────────────────────
function SuggestionRow({
  label, value, colors, last = false,
}: {
  label: string; value: string; colors: any; last?: boolean;
}) {
  if (!value) return null;
  return (
    <View style={[styles.suggestionRow, { borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
      <Text style={[styles.suggestionLabel, { color: colors.foreground }]}>{label}</Text>
      <Text style={[styles.suggestionValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 10,
  },
  headerIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontWeight: "700", fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular" },

  content: { padding: 16, gap: 14 },

  pageTitle: { fontSize: 18, fontWeight: "700", fontFamily: "Inter_700Bold" },
  pageSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: -8 },

  sectionLabel: {
    fontSize: 11, fontWeight: "700", fontFamily: "Inter_700Bold",
    letterSpacing: 0.8, textTransform: "uppercase", marginTop: 4,
  },

  // Home cards
  homeActionCard: {
    flexDirection: "row", alignItems: "center", gap: 14,
    borderRadius: 16, borderWidth: 1.5, padding: 16,
  },
  homeActionIcon: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  homeActionTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold", marginBottom: 4 },
  homeActionSub: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },

  // Section label row (label + add custom type button)
  sectionLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  addTypeBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4,
  },
  addTypeBtnText: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold" },

  // Type grid (home preview)
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  typeChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    borderRadius: 20, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6,
  },
  typeChipText: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold", flexShrink: 1 },

  // Custom type badge in type list
  customBadge: { borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  customBadgeText: { fontSize: 9, fontWeight: "700", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 },

  // Mode select
  modeCard: {
    flexDirection: "row", alignItems: "center", gap: 16,
    borderRadius: 16, borderWidth: 1.5, padding: 16,
  },
  modeIconBox: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  modeTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold", marginBottom: 4 },
  modeSub: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  modeBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
  },
  modeBadgeText: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },

  // Type row
  typeRowCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    borderRadius: 12, borderWidth: 1, padding: 14,
  },
  typeRowIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  typeRowName: { fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" },
  typeRowDesc: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  typeRowAr: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },

  // Type header (fill step)
  typeHeader: {
    flexDirection: "row", alignItems: "center", gap: 12,
    borderRadius: 12, borderWidth: 1, padding: 12,
  },
  typeHeaderIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  typeHeaderName: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  typeHeaderAr: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },

  // Section card
  section: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10 },
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  sectionHeaderText: { fontSize: 13, fontWeight: "700", fontFamily: "Inter_700Bold" },
  optTag: { fontSize: 11, fontFamily: "Inter_400Regular" },

  // Inline field (report header)
  inlineField: { gap: 3 },
  inlineFieldLabel: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.4 },
  inlineFieldInput: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },

  // Form fields
  field: { gap: 5 },
  fieldLabel: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  fieldInput: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, minHeight: 50 },
  textInput: { fontSize: 14, fontFamily: "Inter_400Regular", textAlignVertical: "top" },

  // Info box
  infoBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    borderRadius: 10, borderWidth: 1, padding: 10,
  },
  infoText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },

  // Image picker
  imagePickerRow: { flexDirection: "row", gap: 10 },
  imagePickerBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, borderRadius: 10, borderWidth: 1, paddingVertical: 10,
  },
  imagePickerBtnText: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  imageRow: { flexDirection: "row", gap: 8 },
  thumbWrap: { position: "relative" },
  thumb: { width: 80, height: 80, borderRadius: 10 },
  thumbDelete: {
    position: "absolute", top: 4, right: 4,
    backgroundColor: "#ef4444", borderRadius: 10,
    width: 20, height: 20, alignItems: "center", justifyContent: "center",
  },

  // Generate button
  generateBtn: { borderRadius: 14, overflow: "hidden" },
  generateGradient: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 16, gap: 10,
  },
  generateText: { fontSize: 16, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },

  // AI card
  aiCard: { borderRadius: 16, borderWidth: 1.5, overflow: "hidden" },
  aiCardHeader: { flexDirection: "row", alignItems: "center", gap: 8, padding: 14, paddingBottom: 10 },
  aiCardTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  suggestionRow: { paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  suggestionLabel: { fontSize: 12, fontWeight: "700", fontFamily: "Inter_700Bold" },
  suggestionValue: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 20 },

  // Preview actions
  previewActions: {
    flexDirection: "row", borderRadius: 12, borderWidth: 1,
    padding: 10, gap: 8,
  },
  previewBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 11, borderRadius: 10, gap: 6,
  },
  previewBtnText: { fontSize: 13, fontWeight: "600", color: "#fff", fontFamily: "Inter_600SemiBold" },

  // Report box
  reportBox: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  reportBoxHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#33415540",
  },
  reportBoxTitle: { fontSize: 13, fontWeight: "700", fontFamily: "Inter_700Bold", flex: 1 },
  reportText: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 22, padding: 14 },
  reportEditInput: { minHeight: 400, borderTopWidth: StyleSheet.hairlineWidth },

  // Editing badge
  editingBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  editingBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold" },

  // Search bar
  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    marginHorizontal: 16, marginVertical: 10,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },

  // New report row
  newReportRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, borderRadius: 12, borderWidth: 1, paddingVertical: 12,
  },
  newReportRowText: { fontSize: 14, fontWeight: "600", fontFamily: "Inter_600SemiBold" },

  // History card
  historyCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    borderRadius: 12, borderWidth: 1, padding: 14,
  },
  historyCardIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 },
  historyCardTitle: { fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" },
  historyCardDate: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  historyCardPreview: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 4, lineHeight: 17 },
  historyCardActions: { gap: 4, alignItems: "center" },

  // Empty state
  emptyState: { alignItems: "center", paddingVertical: 60, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: "700", fontFamily: "Inter_700Bold" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },

  // View report meta
  viewReportMeta: { borderRadius: 14, borderWidth: 1, padding: 4, overflow: "hidden" },

  // Add Custom Type Modal
  addTypeModal: {
    borderRadius: 20, borderWidth: 1, padding: 20, gap: 14,
  },
  addTypeModalHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  addTypeModalIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  addTypeModalTitle: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  addTypeModalSub: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17, marginTop: 2 },
  addTypeInputLabel: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  addTypeInput: {
    flexDirection: "row", alignItems: "center",
    borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 10,
    minHeight: 46,
  },
  errorRow: {
    flexDirection: "row", gap: 7, borderRadius: 10, borderWidth: 1,
    padding: 10, alignItems: "flex-start",
  },
  addTypeModalHint: {
    fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center", opacity: 0.7,
  },
});
