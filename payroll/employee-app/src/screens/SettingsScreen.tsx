import React, { useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useApp } from "../store";
import { Button, Card, Field } from "../ui/components";
import { theme, typography } from "../ui/theme";

const CLUSTERS = ["devnet", "testnet", "mainnet-beta"] as const;

// Employee settings: backend (relayer) URL, circuit artifact host, cluster.
// Saving persists immediately AND remounts the hidden SDK WebView (its React
// key includes backendUrl/circuitBase), so a new URL takes effect without
// reconnecting the wallet.
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { backendUrl, circuitBase, cluster, setSettings, walletAddress } = useApp();
  const [bUrl, setBUrl] = useState(backendUrl);
  const [cUrl, setCUrl] = useState(circuitBase);
  const [cl, setCl] = useState(cluster);
  const [saved, setSaved] = useState(false);

  const dirty = bUrl !== backendUrl || cUrl !== circuitBase || cl !== cluster;

  const save = () => {
    setSettings({
      backendUrl: bUrl.trim().replace(/\/$/, ""),
      circuitBase: cUrl.trim().replace(/\/$/, ""),
      cluster: cl,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={[typography.small, { color: theme.textMuted }]}>{"<- Back"}</Text>
        </Pressable>
        <Text style={[typography.micro, { color: theme.textSoft, letterSpacing: 1.5 }]}>SETTINGS</Text>
      </View>

      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <Field
          label="Backend URL (relayer)"
          value={bUrl}
          onChangeText={setBUrl}
          placeholder="https://your-relayer.example"
          mono
        />
        <Field
          label="Circuit host (serves /circuit/*.wasm + .zkey)"
          value={cUrl}
          onChangeText={setCUrl}
          placeholder="https://your-frontend.example"
          mono
        />

        <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>Cluster</Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
          {CLUSTERS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setCl(c)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: cl === c ? theme.accentLine : theme.hairline,
                backgroundColor: cl === c ? theme.accentSoft : theme.surfaceMuted,
              }}
            >
              <Text style={[typography.small, { color: cl === c ? theme.accent : theme.textSoft }]}>{c}</Text>
            </Pressable>
          ))}
        </View>

        <Button title={saved ? "Saved" : "Save"} onPress={save} disabled={!dirty && !saved} />

        <Card style={{ marginTop: 24 }}>
          <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>
            Local payroll testing
          </Text>
          <Text style={[typography.small, { color: theme.textSoft }]}>
            To test against a local surfpool payroll chain, set the Backend URL
            to your dev machine's LAN address (e.g. http://192.168.x.x:8787)
            and the Circuit host to the same machine's web app. The phone and
            the dev machine must be on the same network. Wallet public SOL
            balances are always read from the real cluster RPC.
          </Text>
        </Card>

        {walletAddress ? (
          <Card style={{ marginTop: 16 }}>
            <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>
              Connected wallet
            </Text>
            <Text style={[typography.mono, { color: theme.textSoft }]}>{walletAddress}</Text>
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}
