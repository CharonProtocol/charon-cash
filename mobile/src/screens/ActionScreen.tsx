import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, KeyboardAvoidingView, Platform, Animated, Linking } from "react-native";
import { useBridge } from "../bridge/BridgeContext";
import { useApp } from "../store";
import { useAccount } from "../hooks/useAccount";
import { Button, Card, Field, ErrorBanner } from "../ui/components";
import { AssetTabs } from "../ui/AssetTabs";
import { theme, typography } from "../ui/theme";
import { formatUnits, parseUnits, type Asset } from "../lib/assets";
import { EXPLORER_TX, SWAP_AVAILABLE } from "../lib/config";
import type { TxResult } from "../lib/rpc";
import type { Action } from "./HomeScreen";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Kept in the wallet on a max SOL deposit, for this and later network fees.
const SOL_RESERVE = 10_000_000n;

type Source = "private" | "wallet";

const TITLES: Record<Action, { title: string; blurb: string }> = {
  deposit: { title: "Deposit", blurb: "Move funds from your wallet into your private balance." },
  send: { title: "Send", blurb: "Pay anyone. Charon users receive it privately." },
  withdraw: { title: "Withdraw", blurb: "Move private funds to a wallet. No link back to you." },
  swap: { title: "Swap", blurb: "Trade inside your private balance." },
};

function Success({ title, signature, onDone }: { title: string; signature: string; onDone: () => void }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start();
  }, [v]);
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
      <Animated.View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: theme.accentSoft,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ scale: v }],
        }}
      >
        <Text style={[typography.title, { color: theme.accent }]}>OK</Text>
      </Animated.View>
      <Text style={[typography.title, { color: theme.text, marginTop: 20, textAlign: "center" }]}>{title}</Text>
      <Pressable onPress={() => Linking.openURL(EXPLORER_TX(signature))} hitSlop={8} style={{ marginTop: 12 }}>
        <Text style={[typography.small, { color: theme.accent, fontWeight: "700" }]}>View on Explorer</Text>
      </Pressable>
      <View style={{ alignSelf: "stretch", marginTop: 36 }}>
        <Button title="Done" onPress={onDone} />
      </View>
    </View>
  );
}

export function ActionScreen({ action, initialAsset, onDone }: { action: Action; initialAsset: string; onDone: () => void }) {
  const { call } = useBridge();
  const { refresh } = useAccount();
  const { assets, balances, walletBalances, feeBps } = useApp();

  const [assetKey, setAssetKey] = useState(initialAsset);
  const [toKey, setToKey] = useState(() => assets.find((a) => a.key !== initialAsset)?.key ?? initialAsset);
  const [source, setSource] = useState<Source>("private");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; signature: string } | null>(null);

  const asset = assets.find((a) => a.key === assetKey) ?? assets[0];
  const toAsset = assets.find((a) => a.key === toKey);
  const fromWallet = action === "deposit" || (action === "send" && source === "wallet");

  // What this action can spend at most, in raw units.
  const max = useMemo(() => {
    if (fromWallet) {
      const w = BigInt(walletBalances[asset.key] ?? "0");
      return asset.key === "SOL" ? (w > SOL_RESERVE ? w - SOL_RESERVE : 0n) : w;
    }
    return BigInt(balances[asset.key]?.maxSingle ?? "0");
  }, [fromWallet, asset, balances, walletBalances]);

  const raw = parseUnits(amount, asset.decimals);
  const tooMuch = raw != null && BigInt(raw) > max;
  const needsRecipient = action === "send" || action === "withdraw";
  const recipientOk = !needsRecipient || (action === "withdraw" && recipient.trim() === "") || B58.test(recipient.trim());
  const swapBlocked = action === "swap" && (!SWAP_AVAILABLE || !toAsset || toAsset.key === asset.key);
  const canGo = !busy && raw != null && !tooMuch && recipientOk && !swapBlocked;

  // Who is on the other end of a send decides how it travels.
  useEffect(() => {
    setNote(null);
    const to = recipient.trim();
    if (action !== "send" || !B58.test(to)) return;
    let live = true;
    call<{ registered: boolean }>("isRegistered", [to])
      .then((r) => {
        if (!live) return;
        if (r.registered) setNote("Charon user: they receive it privately.");
        else if (source === "wallet") setNote("Not on Charon yet. Sending from your wallet needs them to open Charon once.");
        else setNote("Not on Charon yet: it arrives in their wallet. Your side stays private.");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [action, recipient, source, call]);

  const go = async () => {
    if (!raw) return;
    setError(null);
    setBusy(true);
    const to = recipient.trim();
    try {
      let res: TxResult;
      let title: string;
      const shown = `${formatUnits(raw, asset.decimals, asset.decimals)} ${asset.symbol}`;
      if (action === "deposit") {
        setPhase("Approve the deposit in your wallet");
        res = await call<TxResult>("deposit", [asset.key, raw]);
        title = `${shown} is now private`;
      } else if (action === "withdraw") {
        setPhase("Proving and sending");
        res = await call<TxResult>("withdraw", [asset.key, raw, to || undefined]);
        title = `${shown} withdrawn`;
      } else if (action === "send") {
        const { registered } = await call<{ registered: boolean }>("isRegistered", [to]);
        if (source === "wallet") {
          if (!registered) throw new Error("They need to open Charon once before you can send to them from your wallet.");
          setPhase("Approve the payment in your wallet");
          res = await call<TxResult>("depositTo", [asset.key, raw, to]);
        } else {
          setPhase("Proving and sending");
          res = await call<TxResult>(registered ? "transferPrivate" : "withdraw", [asset.key, raw, to]);
        }
        title = `${shown} sent`;
      } else {
        setPhase("Finding a route and proving");
        res = await call<TxResult>("swap", [asset.key, toKey, raw]);
        title = `Swapped ${shown}`;
      }
      setDone({ title, signature: res.signature });
      refresh().catch(() => {});
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
      setPhase("");
    }
  };

  if (done) return <Success title={done.title} signature={done.signature} onDone={onDone} />;

  const { title, blurb } = TITLES[action];
  const spendsPrivate = !fromWallet;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onDone} hitSlop={10} disabled={busy}>
          <Text style={[typography.small, { color: theme.textMuted }]}>{"<  Back"}</Text>
        </Pressable>
        <Text style={[typography.title, { color: theme.text, marginTop: 16 }]}>{title}</Text>
        <Text style={[typography.small, { color: theme.textMuted, marginTop: 4, marginBottom: 22 }]}>{blurb}</Text>

        {action === "swap" && !SWAP_AVAILABLE ? (
          <Card style={{ marginBottom: 18, borderColor: theme.amber }}>
            <Text style={[typography.small, { color: theme.amber }]}>
              Private swaps are coming with mainnet. On devnet there is no market to route through.
            </Text>
          </Card>
        ) : null}

        <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>{action === "swap" ? "From" : "Asset"}</Text>
        <AssetTabs assets={assets} value={asset.key} onChange={setAssetKey} />
        {action === "swap" ? (
          <>
            <Text style={[typography.micro, { color: theme.textMuted, marginTop: 16, marginBottom: 8 }]}>To</Text>
            <AssetTabs assets={assets.filter((x: Asset) => x.key !== asset.key)} value={toKey} onChange={setToKey} />
          </>
        ) : null}

        {action === "send" ? (
          <>
            <Text style={[typography.micro, { color: theme.textMuted, marginTop: 16, marginBottom: 8 }]}>Pay from</Text>
            <AssetTabs
              assets={[
                { key: "private", symbol: "Private balance", decimals: 0 },
                { key: "wallet", symbol: "Wallet", decimals: 0 },
              ]}
              value={source}
              onChange={(k) => setSource(k as Source)}
            />
          </>
        ) : null}

        <View style={{ height: 18 }} />
        <Field
          label={`Amount (${asset.symbol})`}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.0"
          keyboardType="decimal-pad"
          right={
            <Pressable onPress={() => setAmount(formatUnits(max, asset.decimals, asset.decimals).replace(/,/g, ""))} hitSlop={8}>
              <Text style={[typography.micro, { color: theme.accent }]}>Max</Text>
            </Pressable>
          }
        />
        <Text style={[typography.small, { color: tooMuch ? theme.danger : theme.textMuted, marginTop: -8, marginBottom: 16 }]}>
          {tooMuch ? "More than you can send in one go. " : ""}
          Available {formatUnits(max, asset.decimals)} {asset.symbol}
          {spendsPrivate ? ` - ${feeBps / 100}% network fee included` : ""}
        </Text>

        {needsRecipient ? (
          <Field
            label={action === "withdraw" ? "To wallet (empty = yours)" : "To (wallet address)"}
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Solana address"
            mono
          />
        ) : null}
        {note ? <Text style={[typography.small, { color: theme.textSoft, marginTop: -6, marginBottom: 16 }]}>{note}</Text> : null}

        {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

        <View style={{ flex: 1 }} />
        <Button title={busy ? phase || "Working" : title} onPress={go} loading={busy} disabled={!canGo} />
        {busy ? <Text style={[typography.small, { color: theme.textMuted, textAlign: "center", marginTop: 10 }]}>{phase}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
