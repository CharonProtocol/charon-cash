import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useBridge } from "../bridge/BridgeContext";
import { useApp } from "../store";
import { Button, Card, MonoText, Pill, ErrorBanner, Field } from "../ui/components";
import { theme, typography } from "../ui/theme";
import type { WithdrawResult } from "../lib/rpc";

function fmtSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function lamportsToSolString(lamports: number): string {
  return (lamports / 1e9).toFixed(Math.min(9, Math.max(0, 6)));
}

// Claim to wallet: spend shielded notes back to public SOL in the employee's
// own wallet, gasless (the relayer signs and takes a fee off the gross).
export function WithdrawScreen({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const { call } = useBridge();
  const {
    balanceLamports,
    publicBalanceLamports,
    feeBps,
    feeMinLamports,
    busy,
    busyLabel,
    error,
    setError,
    setBusy,
  } = useApp();

  const [amountSol, setAmountSol] = useState("");
  const [result, setResult] = useState<WithdrawResult | null>(null);

  const grossLamports = useMemo(() => {
    const n = Number(amountSol.trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 1e9);
  }, [amountSol]);

  // Same math as the web app: fee = max(minFee, floor(gross * bps / 10000)).
  const feeLamports = useMemo(() => {
    if (grossLamports <= 0) return 0;
    if (feeBps === null) return feeMinLamports;
    const byRate = Math.floor((grossLamports * feeBps) / 10000);
    return Math.max(feeMinLamports, byRate);
  }, [grossLamports, feeBps, feeMinLamports]);

  const netLamports = Math.max(0, grossLamports - feeLamports);
  const maxSol = lamportsToSolString(balanceLamports);

  const claim = async () => {
    if (grossLamports <= 0 || netLamports <= 0) return;
    setError(null);
    setBusy(true, "Claiming  -  building the zero-knowledge proof (can take a minute)...");
    try {
      const r = await call<WithdrawResult>("withdraw", [grossLamports]);
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? "Claim failed");
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
      <Pressable onPress={result ? onDone : onBack} hitSlop={8}>
        <Text style={[typography.small, { color: theme.textMuted }]}>{"<- Back"}</Text>
      </Pressable>
      <Text style={[typography.micro, { color: theme.textSoft, letterSpacing: 1.5 }]}>CLAIM</Text>
    </View>
  );

  if (result) {
    // Success state: the notes left the shielded pool; SOL is in the wallet.
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}>
        {header}
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Pill tone="accent">claimed</Pill>
            </View>
            <Text style={[typography.hero, { color: theme.text }]}>
              {fmtSol(result.recipientLamports)} SOL
            </Text>
            <Text style={[typography.body, { color: theme.textSoft, marginTop: 8 }]}>
              Moved out of the shielded pool into your wallet's public balance.
            </Text>
            <View style={{ marginTop: 16, gap: 6 }}>
              <MonoText>fee     {fmtSol(result.feeLamports)} SOL</MonoText>
              <MonoText>sig     {result.signature.slice(0, 22)}...</MonoText>
            </View>
          </Card>
        </ScrollView>
        <Button title="Done" onPress={onDone} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}>
      {header}
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <Text style={[typography.hero, { color: theme.text }]}>Claim to wallet</Text>
        <Text style={[typography.body, { color: theme.textSoft, marginTop: 10 }]}>
          Moves shielded notes out of the private pool into your normal SOL
          balance. The relayer broadcasts for you  -  no SOL needed in the
          wallet, the fee comes off the amount.
        </Text>

        {error ? (
          <View style={{ marginTop: 18 }}>
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </View>
        ) : null}

        <View style={{ marginTop: 22 }}>
          <Field
            label="Amount (SOL)"
            value={amountSol}
            onChangeText={setAmountSol}
            placeholder={`up to ${maxSol}`}
            keyboardType="decimal-pad"
            right={
              <Pressable
                hitSlop={8}
                onPress={() => setAmountSol(maxSol)}
                style={{ paddingHorizontal: 6, paddingVertical: 8 }}
              >
                <Text style={[typography.small, { color: theme.accent, fontWeight: "700" }]}>MAX</Text>
              </Pressable>
            }
          />
        </View>

        <Card style={{ padding: 16 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={[typography.small, { color: theme.textMuted }]}>Shielded balance</Text>
            <Text style={[typography.small, { color: theme.text }]}>{fmtSol(balanceLamports)} SOL</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={[typography.small, { color: theme.textMuted }]}>Relayer fee</Text>
            <Text style={[typography.small, { color: theme.text }]}>
              {grossLamports > 0 ? fmtSol(feeLamports) : "--"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={[typography.small, { color: theme.textSoft, fontWeight: "700" }]}>You receive</Text>
            <Text style={[typography.small, { color: theme.textSoft, fontWeight: "700" }]}>
              {grossLamports > 0 ? fmtSol(netLamports) : "--"}
            </Text>
          </View>
        </Card>

        {feeBps === null ? (
          <Text style={[typography.small, { color: theme.textMuted, marginTop: 10 }]}>
            Fee schedule not loaded yet (backend unreachable?)  -  the preview uses the
            minimum fee only.
          </Text>
        ) : null}

        <View style={{ marginTop: 18 }}>
          <Button
            title={busy ? busyLabel || "Claiming..." : "Claim"}
            onPress={claim}
            loading={busy}
            disabled={grossLamports <= 0 || netLamports <= 0 || grossLamports > balanceLamports}
          />
          {grossLamports > balanceLamports ? (
            <Text style={[typography.small, { color: theme.danger, marginTop: 10, textAlign: "center" }]}>
              More than your shielded balance ({fmtSol(balanceLamports)} SOL).
            </Text>
          ) : null}
        </View>

        <Text style={[typography.micro, { color: theme.textMuted, marginTop: 24 }]}>
          Wallet after claim (approx): {fmtSol(publicBalanceLamports + netLamports)} SOL
        </Text>
      </ScrollView>
    </View>
  );
}
