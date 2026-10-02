import React from "react";
import { View, Text, Pressable } from "react-native";
import { useWallet } from "../wallet/WalletProvider";
import { Button } from "../ui/components";
import { Logo } from "../ui/Logo";
import { theme, typography } from "../ui/theme";

export function ConnectScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { connect, connecting } = useWallet();

  return (
    // Plain View root: direct flex:1 child of a bounded parent -> guaranteed to
    // fill the screen. The flex:1 spacer pushes the footer to the bottom.
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 20 }}>
      <Logo size={64} />

      <Text style={[typography.micro, { color: theme.accent, marginTop: 22, letterSpacing: 2 }]}>
        CHARON PAY
      </Text>
      <Text style={[typography.hero, { color: theme.text, marginTop: 8 }]}>
        Send SOL{"\n"}without a trace.
      </Text>
      <Text style={[typography.body, { color: theme.textSoft, marginTop: 16, maxWidth: 300 }]}>
        A private, shielded wallet. Spend your deposited notes to any address  -  the
        source is unlinkable, proven by a Groth16 zero-knowledge proof.
      </Text>

      <View style={{ marginTop: 36 }}>
        <Button
          title={connecting ? "Opening wallet..." : "Connect Wallet"}
          onPress={connect}
          loading={connecting}
        />
        <Text style={[typography.small, { color: theme.textMuted, marginTop: 12, textAlign: "center" }]}>
          Mobile Wallet Adapter  -  Phantom / Solflare
        </Text>
      </View>

      <View
        style={{
          marginTop: 40,
          backgroundColor: theme.surface,
          borderRadius: theme.radius,
          borderWidth: 1,
          borderColor: theme.hairline,
          padding: 16,
        }}
      >
        <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>
          Before you test
        </Text>
        <Text style={[typography.small, { color: theme.textSoft }]}>
          You need shielded SOL first. Deposit on the web app with this same wallet,
          then return here to transfer.
        </Text>
        <Pressable onPress={onOpenSettings} hitSlop={8} style={{ marginTop: 10 }}>
          <Text style={[typography.small, { color: theme.accent, fontWeight: "700" }]}>
            {"Open settings ->"}
          </Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }} />
      <Text style={[typography.micro, { color: theme.textMuted, textAlign: "center", marginTop: 20 }]}>
        deposit &amp; withdraw live on web  -  this app is transfer-only
      </Text>
    </View>
  );
}
