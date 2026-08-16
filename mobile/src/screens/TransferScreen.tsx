import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useBridge } from "../bridge/BridgeContext";
import { useWallet } from "../wallet/WalletProvider";
import { useApp } from "../store";
import { Button, Card, Field, MonoText, ErrorBanner, Pill } from "../ui/components";
import { theme, typography } from "../ui/theme";
import { fetchSolBalance, fetchSplBalance, fetchMintDecimals } from "../lib/solana";
import type { TransferResult } from "../lib/rpc";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Format an integer-raw amount (lamports for SOL, base units for SPL) at the
// given decimals into a human string.
function fmtRaw(raw: number, decimals: number): string {
  return (raw / Math.pow(10, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: decimals > 4 ? 4 : decimals,
  });
}

type Token = "sol" | "spl";
type Mode = "wallet" | "shielded";

export function TransferScreen({ onDone }: { onDone: () => void }) {
  const { call } = useBridge();
  const { address } = useWallet();
  const cluster = useApp((s) => s.cluster);
  const balanceLamports = useApp((s) => s.balanceLamports); // shielded SOL
  const publicBalanceLamports = useApp((s) => s.publicBalanceLamports); // wallet SOL
  const notes = useApp((s) => s.notes);
  const setBalance = useApp((s) => s.setBalance);
  const setPublicBalance = useApp((s) => s.setPublicBalance);
  const setNotes = useApp((s) => s.setNotes);

  const [token, setToken] = useState<Token>("sol");
  const [mode, setMode] = useState<Mode>("wallet");
  const [mint, setMint] = useState("");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);
  const [splWalletRaw, setSplWalletRaw] = useState(0);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When SPL is selected and a valid mint is entered, fetch its decimals + the
  // wallet's token balance so the Available/MAX values are correct.
  useEffect(() => {
    if (token !== "spl" || !address) return;
    if (!B58.test(mint.trim())) {
      setMintDecimals(null);
      setSplWalletRaw(0);
      return;
    }
    const m = mint.trim();
    let cancelled = false;
    fetchMintDecimals(cluster, m).then((d) => !cancelled && setMintDecimals(d));
    fetchSplBalance(cluster, address, m).then(
      (b) => !cancelled && setSplWalletRaw(b.raw),
    );
    return () => {
      cancelled = true;
    };
  }, [token, mint, address, cluster]);

  const decimals = token === "sol" ? 9 : mintDecimals ?? 0;

  // Shielded SPL balance for this mint (notes hold raw amounts).
  const shieldedSplRaw = notes
    .filter((n) => !n.spent && n.mintAddress === mint.trim())
    .reduce((s, n) => s + Number(n.amount || "0"), 0);

  const availableRaw =
    token === "sol"
      ? mode === "wallet"
        ? publicBalanceLamports
        : balanceLamports
      : mode === "wallet"
        ? splWalletRaw
        : shieldedSplRaw;

  const amountRaw = Math.round((parseFloat(amount) || 0) * Math.pow(10, decimals));
  const recipientOk = B58.test(recipient.trim());
  const amountOk = amountRaw > 0 && amountRaw <= availableRaw;
  const canSend = recipientOk && amountOk && !sending;
  const unit = token === "sol" ? "SOL" : "SPL";

  async function send() {
    setError(null);
    setResult(null);
    setSending(true);
    setPhase(
      mode === "wallet"
        ? "Depositing + sending -- approve the deposit in your wallet..."
        : "Sending from your shielded balance -- approve the signature...",
    );
    try {
      let res: TransferResult;
      if (token === "sol") {
        // SOL: deposit-then-withdraw (sendPrivateSOL) from wallet, or spend a
        // shielded note (transferSOL). Both relay the final withdraw gaslessly.
        res =
          mode === "wallet"
            ? await call<TransferResult>("send", [amountRaw, recipient.trim()])
            : await call<TransferResult>("transfer", [amountRaw, recipient.trim()]);
      } else {
        res =
          mode === "wallet"
            ? await call<TransferResult>("sendSpl", [mint.trim(), amountRaw, recipient.trim()])
            : await call<TransferResult>("transferSpl", [mint.trim(), amountRaw, recipient.trim()]);
      }
      setResult(res);
      setPhase("");
      // Refresh both balances after the spend.
      try {
        const b = await call<{ lamports: number }>("balance");
        const n = await call<unknown[]>("getNotes");
        setBalance(b.lamports);
        setNotes(n as any);
        if (token === "sol" && address) {
          fetchSolBalance(cluster, address).then(setPublicBalance).catch(() => {});
        } else if (token === "spl" && address) {
          fetchSplBalance(cluster, address, mint.trim()).then(
            (sb) => setSplWalletRaw(sb.raw),
          );
        }
      } catch {}
    } catch (e: any) {
      setError(e?.message ?? "Transfer failed");
    } finally {
      setSending(false);
      setPhase("");
    }
  }

  const refresh = useCallback(() => {
    if (token === "sol" && address) {
      fetchSolBalance(cluster, address).then(setPublicBalance).catch(() => {});
    } else if (token === "spl" && address && B58.test(mint.trim())) {
      fetchSplBalance(cluster, address, mint.trim()).then((b) => setSplWalletRaw(b.raw));
    }
  }, [token, mint, address, cluster, setPublicBalance]);

  if (result) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: 16, justifyContent: "center" }}>
        <View style={{ alignItems: "center", marginBottom: 28 }}>
          <View
            style={{
              width: 64, height: 64, borderRadius: 32,
              backgroundColor: theme.accentSoft, alignItems: "center", justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 32 }}>OK</Text>
          </View>
          <Text style={[typography.title, { color: theme.text, marginTop: 16 }]}>
            Sent privately
          </Text>
          <Text style={[typography.body, { color: theme.textSoft, marginTop: 6, textAlign: "center" }]}>
            {fmtRaw(result.recipientLamports, decimals)} {unit} delivered to the recipient.
          </Text>
        </View>
        <Card style={{ gap: 10 }}>
          <Row label="Signature">
            <MonoText>{result.signature.slice(0, 10)}...{result.signature.slice(-6)}</MonoText>
          </Row>
          <Row label="Fee">
            <Text style={[typography.body, { color: theme.text }]}>{fmtRaw(result.feeLamports, decimals)} {unit}</Text>
          </Row>
          {result.nullifiers?.length ? (
            <Row label="Nullifiers">
              <MonoText>{result.nullifiers.length} spent</MonoText>
            </Row>
          ) : null}
        </Card>
        <View style={{ marginTop: 24 }}>
          <Button title="Done" onPress={onDone} />
        </View>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, padding: 20, paddingTop: 16 }}>
        <Pressable onPress={onDone} hitSlop={8} style={{ alignSelf: "flex-start", marginBottom: 16 }}>
          <Text style={[typography.small, { color: theme.textMuted }]}>{"< Back"}</Text>
        </Pressable>

        <Text style={[typography.title, { color: theme.text }]}>Send</Text>
        <Text style={[typography.body, { color: theme.textSoft, marginTop: 8 }]}>
          {mode === "wallet"
            ? "Deposit fresh from your wallet, then withdraw to the recipient. The deposit stays unlinked to the recipient via ZK."
            : "Spend your shielded notes to pay an address. Relayed gaslessly -- the source note stays unlinkable."}
        </Text>

        {/* Token toggle */}
        <Segmented
          style={{ marginTop: 20 }}
          options={[
            { value: "sol", label: "SOL" },
            { value: "spl", label: "SPL" },
          ]}
          value={token}
          onChange={(v) => setToken(v as Token)}
        />

        {token === "spl" ? (
          <Field
            label="Token mint"
            value={mint}
            onChangeText={setMint}
            placeholder="Base58 mint address"
            mono
          />
        ) : null}

        {/* Source toggle: deposit-and-send (from wallet) vs spend shielded */}
        <Segmented
          style={{ marginTop: token === "spl" ? 0 : 20 }}
          options={[
            { value: "wallet", label: "From wallet" },
            { value: "shielded", label: "From shielded" },
          ]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />

        <View style={{ marginTop: 20 }}>
          {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

          <Field
            label="Recipient address"
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Base58 Solana address"
            mono
          />
          <Field
            label={`Amount (${unit})`}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.0"
            keyboardType="decimal-pad"
            right={
              <Pressable
                onPress={() => setAmount((availableRaw / Math.pow(10, decimals)).toString())}
                hitSlop={8}
                style={{ paddingHorizontal: 4 }}
              >
                <Text style={[typography.small, { color: theme.accent, fontWeight: "700" }]}>MAX</Text>
              </Pressable>
            }
          />

          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
            <Pressable onPress={refresh} hitSlop={8}>
              <Text style={[typography.small, { color: theme.textMuted }]}>Available</Text>
            </Pressable>
            <Text style={[typography.small, { color: theme.textSoft }]}>
              {fmtRaw(availableRaw, decimals)} {unit}
            </Text>
          </View>

          {recipient.length > 0 && !recipientOk ? (
            <Text style={[typography.small, { color: theme.danger, marginBottom: 10, marginTop: 8 }]}>
              That doesn't look like a valid address.
            </Text>
          ) : null}
          {parseFloat(amount) > 0 && !amountOk ? (
            <Text style={[typography.small, { color: theme.amber, marginBottom: 10, marginTop: 8 }]}>
              {amountRaw > availableRaw
                ? "Not enough available balance."
                : "Enter a valid amount."}
            </Text>
          ) : null}
          {token === "spl" && mint.length > 0 && mintDecimals === null ? (
            <Text style={[typography.small, { color: theme.textMuted, marginBottom: 10, marginTop: 8 }]}>
              Enter a valid mint to load its balance.
            </Text>
          ) : null}

          <View style={{ marginTop: 8 }}>
            <Button
              title={sending ? "Working..." : mode === "wallet" ? "Deposit + send" : "Send transfer"}
              onPress={send}
              loading={sending}
              disabled={!canSend}
            />
          </View>
          {sending && phase ? (
            <Text style={[typography.small, { color: theme.textMuted, marginTop: 12, textAlign: "center" }]}>
              {phase}
            </Text>
          ) : null}
        </View>

        <View style={{ marginTop: 24 }}>
          <Pill tone="muted">zero-knowledge - groth16 - bn254</Pill>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Segmented({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  style?: any;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          backgroundColor: theme.surfaceMuted,
          borderRadius: theme.radiusSm,
          padding: 4,
        },
        style,
      ]}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: theme.radiusSm - 2,
              alignItems: "center",
              backgroundColor: active ? theme.accent : "transparent",
            }}
          >
            <Text
              style={[
                typography.small,
                { color: active ? "#0C0E12" : theme.textSoft, fontWeight: "700" },
              ]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <Text style={[typography.small, { color: theme.textMuted }]}>{label}</Text>
      {children}
    </View>
  );
}
