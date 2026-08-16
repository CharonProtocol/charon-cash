import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useApp } from "../store";
import { Button, Card, Field, Pill } from "../ui/components";
import { theme, typography } from "../ui/theme";

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { backendUrl, circuitBase, cluster, setSettings } = useApp();
  const [be, setBe] = useState(backendUrl);
  const [cb, setCb] = useState(circuitBase);
  const [cl, setCl] = useState(cluster);
  const [saved, setSaved] = useState(false);

  function save() {
    setSettings({ backendUrl: be.replace(/\/$/, ""), circuitBase: cb.replace(/\/$/, ""), cluster: cl });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    // Filling root (flex:1 + bg) so the screen is full-bleed with no gray gap;
    // ScrollView(flex:1, flexGrow:1) keeps it scrollable on small keyboards.
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, padding: 20, paddingTop: 16 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ marginBottom: 16 }}>
          <Text style={[typography.small, { color: theme.textMuted }]}>{"< Back"}</Text>
        </Pressable>
        <Text style={[typography.title, { color: theme.text }]}>Settings</Text>
        <Text style={[typography.body, { color: theme.textSoft, marginTop: 8, marginBottom: 20 }]}>
          Defaults point at the live devnet stack (tunnel relayer + Vercel
          circuits). Override here to use your own backend or circuit host.
        </Text>

        <Card style={{ marginBottom: 16 }}>
          <Field label="Backend URL (relayer + indexer)" value={be} onChangeText={setBe} placeholder="https://...trycloudflare.com" mono />
          <Field label="Circuit base (serves /circuit/*.wasm,zkey)" value={cb} onChangeText={setCb} placeholder="https://...vercel.app" mono />

          <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>Cluster</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["devnet", "mainnet-beta", "testnet"] as const).map((c) => (
              <Pressable
                key={c}
                onPress={() => setCl(c)}
                style={{
                  flex: 1,
                  paddingVertical: 11,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: cl === c ? theme.accentLine : theme.hairline,
                  backgroundColor: cl === c ? theme.accentSoft : theme.bgElevated,
                  alignItems: "center",
                }}
              >
                <Text style={[typography.small, { color: cl === c ? theme.accent : theme.textSoft }]}>{c}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Button title={saved ? "Saved OK" : "Save"} onPress={save} />
        <View style={{ marginTop: 16, alignItems: "center" }}>
          <Pill tone="muted">defaults: live devnet tunnel + Vercel circuits</Pill>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
