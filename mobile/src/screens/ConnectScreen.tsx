import React from "react";
import { View, Text } from "react-native";
import { useWallet } from "../wallet/WalletProvider";
import { Button } from "../ui/components";
import { Logo } from "../ui/Logo";
import { theme, typography } from "../ui/theme";

export function ConnectScreen() {
  const { connect, connecting } = useWallet();

  return (
    // Plain View root: direct flex:1 child of a bounded parent -> guaranteed to
    // fill the screen. The flex:1 spacer pushes the footer to the bottom.
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 20 }}>
      <Logo size={64} />

      <Text style={[typography.micro, { color: theme.accent, marginTop: 22, letterSpacing: 2 }]}>CHARON</Text>
      <Text style={[typography.hero, { color: theme.text, marginTop: 8 }]}>
        Your money,{"\n"}private by default.
      </Text>
      <Text style={[typography.body, { color: theme.textSoft, marginTop: 16, maxWidth: 320 }]}>
        Hold, send and get paid in SOL and USDC without putting your balance or your payments on public display.
      </Text>

      <View style={{ marginTop: 28, gap: 10 }}>
        {[
          "Send to anyone, privately",
          "Receive salary from Charon Payroll",
          "Proofs are made on your phone",
        ].map((t) => (
          <View key={t} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent }} />
            <Text style={[typography.small, { color: theme.textSoft }]}>{t}</Text>
          </View>
        ))}
      </View>

      <View style={{ flex: 1 }} />

      <Button title={connecting ? "Opening wallet..." : "Connect wallet"} onPress={connect} loading={connecting} />
      <Text style={[typography.small, { color: theme.textMuted, marginTop: 12, textAlign: "center" }]}>
        Works with Phantom, Solflare and other Solana wallets. Devnet.
      </Text>
    </View>
  );
}
