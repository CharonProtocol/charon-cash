import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, RefreshControl } from "react-native";
import { useWallet } from "../wallet/WalletProvider";
import { useApp } from "../store";
import { useAccount } from "../hooks/useAccount";
import { Button, Card, ErrorBanner, MonoText } from "../ui/components";
import { AssetTabs } from "../ui/AssetTabs";
import { FadeIn } from "../ui/FadeIn";
import { Logo } from "../ui/Logo";
import { theme, typography } from "../ui/theme";
import { formatUnits } from "../lib/assets";

export type Action = "deposit" | "send" | "withdraw" | "swap";

const ACTIONS: { key: Action; label: string; glyph: string }[] = [
  { key: "deposit", label: "Deposit", glyph: "+" },
  { key: "send", label: "Send", glyph: "^" },
  { key: "withdraw", label: "Withdraw", glyph: "v" },
  { key: "swap", label: "Swap", glyph: "<>" },
];

function ActionButton({ label, glyph, onPress, disabled }: { label: string; glyph: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => ({ alignItems: "center", flex: 1, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: theme.accentSoft,
          borderWidth: 1,
          borderColor: theme.accentLine,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={[typography.h2, { color: theme.accent }]}>{glyph}</Text>
      </View>
      <Text style={[typography.small, { color: theme.textSoft, marginTop: 8 }]}>{label}</Text>
    </Pressable>
  );
}

export function HomeScreen({ asset, onAsset, onAction }: { asset: string; onAsset: (k: string) => void; onAction: (a: Action) => void }) {
  const { address, disconnect } = useWallet();
  const { start, refresh } = useAccount();
  const { bridgeReady, webcrypto, unlocked, assets, balances, walletBalances, busy, busyLabel, error, setError } = useApp();
  const [pulling, setPulling] = useState(false);

  // Sign in once the SDK bridge is up for this wallet.
  const didStart = useRef(false);
  useEffect(() => {
    if (!bridgeReady || didStart.current) return;
    didStart.current = true;
    start();
  }, [bridgeReady, start]);

  // New payments (salary, transfers) arrive while the app is open.
  useEffect(() => {
    if (!unlocked) return;
    const t = setInterval(() => refresh().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [unlocked, refresh]);

  const onPull = useCallback(async () => {
    setPulling(true);
    try {
      if (unlocked) await refresh();
      else await start();
    } catch (e: any) {
      setError(e?.message ?? "Refresh failed");
    } finally {
      setPulling(false);
    }
  }, [unlocked, refresh, start, setError]);

  const a = assets.find((x) => x.key === asset) ?? assets[0];
  const priv = balances[a.key]?.total ?? "0";
  const pub = walletBalances[a.key] ?? "0";

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={theme.accent} colors={[theme.accent]} />}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Logo size={28} />
          <Text style={[typography.h2, { color: theme.text }]}>Charon</Text>
          <View style={{ backgroundColor: theme.amberSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={[typography.micro, { color: theme.amber }]}>devnet</Text>
          </View>
        </View>
        <Pressable onPress={disconnect} hitSlop={8}>
          <Text style={[typography.small, { color: theme.textMuted }]}>Disconnect</Text>
        </Pressable>
      </View>

      <FadeIn>
        <Card style={{ marginTop: 22, padding: 20 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={[typography.micro, { color: theme.textMuted }]}>Private balance</Text>
            <AssetTabs assets={assets} value={a.key} onChange={onAsset} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 14 }}>
            <Text style={[typography.hero, { color: theme.text, fontSize: 44, lineHeight: 50 }]} numberOfLines={1} adjustsFontSizeToFit>
              {unlocked ? formatUnits(priv, a.decimals) : "--"}
            </Text>
            <Text style={[typography.h2, { color: theme.textSoft, marginLeft: 8 }]}>{a.symbol}</Text>
          </View>
          <View style={{ height: 1, backgroundColor: theme.hairline, marginVertical: 14 }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={[typography.small, { color: theme.textMuted }]}>In your wallet</Text>
            <Text style={[typography.small, { color: theme.textSoft }]}>
              {formatUnits(pub, a.decimals)} {a.symbol}
            </Text>
          </View>
          <MonoText style={{ marginTop: 6, color: theme.textMuted }}>
            {address ? address.slice(0, 6) + "..." + address.slice(-6) : ""}
          </MonoText>
        </Card>
      </FadeIn>

      <FadeIn delay={80}>
        <View style={{ flexDirection: "row", marginTop: 24 }}>
          {ACTIONS.map((x) => (
            <ActionButton key={x.key} label={x.label} glyph={x.glyph} onPress={() => onAction(x.key)} disabled={!unlocked || busy} />
          ))}
        </View>
      </FadeIn>

      {!webcrypto && bridgeReady ? (
        <View style={{ marginTop: 20 }}>
          <ErrorBanner message="This phone's web engine is missing Web Crypto, which Charon needs. Update Android System WebView and reopen the app." />
        </View>
      ) : null}

      {error ? (
        <View style={{ marginTop: 20 }}>
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
          {!unlocked ? <Button title="Try again" onPress={start} loading={busy} /> : null}
        </View>
      ) : null}

      {busy ? (
        <Text style={[typography.small, { color: theme.textMuted, marginTop: 20, textAlign: "center" }]}>{busyLabel}</Text>
      ) : null}

      <View style={{ flex: 1 }} />

      <FadeIn delay={160}>
        <Card style={{ marginTop: 28 }}>
          <Text style={[typography.micro, { color: theme.accent }]}>Payroll</Text>
          <Text style={[typography.body, { color: theme.text, marginTop: 6 }]}>Salary paid with Charon Payroll lands here, privately.</Text>
          <Text style={[typography.small, { color: theme.textMuted, marginTop: 4 }]}>
            Nothing to claim: it shows in your private balance. Withdraw to move it to your wallet.
          </Text>
        </Card>
      </FadeIn>
    </ScrollView>
  );
}
