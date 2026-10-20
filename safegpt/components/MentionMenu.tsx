import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";

export type DirectTarget = {
  id: string;
  label: string;
};

type MenuItem = {
  id: string;
  label: string;
  sublabel?: string;
};

type MenuCategory = {
  id: string;
  label: string;
  icon: string;
  color: string;
  items: MenuItem[];
  direct?: boolean;
};

const CHAT_CATEGORIES: MenuCategory[] = [
  {
    id: "groq",
    label: "Groq",
    icon: "zap",
    color: "#f97316",
    items: [
      { id: "groq-gpt-oss-120b",     label: "GPT-OSS 120B",     sublabel: "Ultra-fast" },
      { id: "groq-llama-3.3-70b",    label: "Llama 3.3 70B",    sublabel: "Versatile" },
      { id: "groq-llama-3.1-8b",     label: "Llama 3.1 8B",     sublabel: "Instant" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    icon: "shuffle",
    color: "#8b5cf6",
    items: [
      { id: "openrouter-hermes-405b",    label: "Hermes 3 405B",    sublabel: "Most capable" },
      { id: "openrouter-llama-3.3-70b",  label: "Llama 3.3 70B",    sublabel: "Balanced" },
      { id: "openrouter-qwen3-plus",     label: "Qwen3 235B Plus",  sublabel: "Reasoning" },
    ],
  },
  {
    id: "rag",
    label: "RAG Document",
    icon: "file-text",
    color: "#10b981",
    items: [],
    direct: true,
  },
  {
    id: "online",
    label: "Online Queries",
    icon: "globe",
    color: "#3b82f6",
    items: [
      { id: "tavily",     label: "Tavily Search",  sublabel: "AI-powered web" },
      { id: "duckduckgo", label: "DuckDuckGo",     sublabel: "Private search" },
    ],
  },
  {
    id: "local",
    label: "Local Ollama",
    icon: "server",
    color: "#64748b",
    items: [
      { id: "local-llama3.1-8b", label: "Llama 3.1 8B", sublabel: "Requires ngrok URL" },
    ],
  },
  {
    id: "nvidia",
    label: "Nvidia",
    icon: "cpu",
    color: "#22d3ee",
    items: [
      { id: "nvidia-free", label: "Llama 3.3 70B", sublabel: "Nvidia NIM" },
    ],
  },
];

const EMERGENCY_ITEMS: MenuItem[] = [
  { id: "cerebras",  label: "Cerebras GPT-OSS 120B",  sublabel: "Quick Response tab" },
  { id: "deepseek",  label: "DeepSeek R1-0528",        sublabel: "Deep Analysis tab" },
];

type Props = {
  visible: boolean;
  type: "chat" | "emergency";
  colors: any;
  onSelect: (target: DirectTarget) => void;
  onClose: () => void;
};

export function MentionMenu({ visible, type, colors, onSelect, onClose }: Props) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  if (!visible) return null;

  function handleCategoryPress(cat: MenuCategory) {
    if (cat.direct) {
      onSelect({ id: cat.id, label: cat.label });
      setExpandedCategory(null);
      return;
    }
    setExpandedCategory((prev) => (prev === cat.id ? null : cat.id));
  }

  function handleItemPress(item: MenuItem) {
    onSelect({ id: item.id, label: item.label });
    setExpandedCategory(null);
  }

  function handleClose() {
    setExpandedCategory(null);
    onClose();
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={handleClose}
    >
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.menu, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.menuHeader, { borderBottomColor: colors.border }]}>
                <View style={styles.menuTitleRow}>
                  <Feather name="at-sign" size={14} color={colors.primary} style={{ marginRight: 6 }} />
                  <Text style={[styles.menuTitle, { color: colors.foreground }]}>Route to…</Text>
                </View>
                <TouchableOpacity onPress={handleClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
                {type === "emergency" ? (
                  EMERGENCY_ITEMS.map((item, idx) => (
                    <TouchableOpacity
                      key={item.id}
                      style={[
                        styles.item,
                        { borderBottomColor: colors.border },
                        idx === EMERGENCY_ITEMS.length - 1 && { borderBottomWidth: 0 },
                      ]}
                      onPress={() => handleItemPress(item)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.dot, { backgroundColor: "#ef4444" }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{item.label}</Text>
                        {item.sublabel && (
                          <Text style={[styles.itemSublabel, { color: colors.mutedForeground }]}>{item.sublabel}</Text>
                        )}
                      </View>
                      <Feather name="arrow-right" size={14} color="#ef4444" />
                    </TouchableOpacity>
                  ))
                ) : (
                  CHAT_CATEGORIES.map((cat) => (
                    <View key={cat.id}>
                      <TouchableOpacity
                        style={[
                          styles.category,
                          { borderBottomColor: colors.border },
                          expandedCategory === cat.id && { backgroundColor: colors.muted },
                        ]}
                        onPress={() => handleCategoryPress(cat)}
                        activeOpacity={0.75}
                      >
                        <View style={[styles.catIcon, { backgroundColor: cat.color + "22" }]}>
                          <Feather name={cat.icon as any} size={14} color={cat.color} />
                        </View>
                        <Text style={[styles.catLabel, { color: colors.foreground }]}>{cat.label}</Text>
                        {cat.direct ? (
                          <View style={[styles.directBadge, { backgroundColor: cat.color + "22" }]}>
                            <Text style={[styles.directBadgeText, { color: cat.color }]}>Direct</Text>
                          </View>
                        ) : (
                          <Feather
                            name={expandedCategory === cat.id ? "chevron-up" : "chevron-right"}
                            size={14}
                            color={colors.mutedForeground}
                          />
                        )}
                      </TouchableOpacity>

                      {expandedCategory === cat.id &&
                        cat.items.map((item, idx) => (
                          <TouchableOpacity
                            key={item.id}
                            style={[
                              styles.subItem,
                              { borderBottomColor: colors.border + "80" },
                              idx === cat.items.length - 1 && { borderBottomWidth: 0 },
                            ]}
                            onPress={() => handleItemPress(item)}
                            activeOpacity={0.75}
                          >
                            <View style={[styles.subDot, { backgroundColor: cat.color }]} />
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.subLabel, { color: colors.foreground }]}>{item.label}</Text>
                              {item.sublabel && (
                                <Text style={[styles.subSublabel, { color: colors.mutedForeground }]}>{item.sublabel}</Text>
                              )}
                            </View>
                            <Feather name="corner-down-right" size={12} color={cat.color} />
                          </TouchableOpacity>
                        ))}
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
    paddingHorizontal: 12,
    paddingBottom: 90,
  },
  menu: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 12,
  },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuTitleRow: { flexDirection: "row", alignItems: "center" },
  menuTitle: { fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" },

  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  itemLabel: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  itemSublabel: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },

  category: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  catIcon: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  catLabel: { flex: 1, fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  directBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  directBadgeText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold" },

  subItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 54,
    paddingRight: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subDot: { width: 6, height: 6, borderRadius: 3 },
  subLabel: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  subSublabel: { fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 1 },
});
