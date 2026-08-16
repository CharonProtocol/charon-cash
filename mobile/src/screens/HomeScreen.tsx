import React, { useCallback, useEffect, useRef } from "react";
import { View, Text, Pressable } from "react-native";
import { useWallet } from "../wallet/WalletProvider";
import { useBridge } from "../bridge/BridgeContext";
import { useApp } from "../store";
import { Button, Card, MonoText, Pill, ErrorBanner } from "../ui/components";
import { Logo } from "../ui/Logo";
import { theme, typography } from "../ui/theme";
import type { BalanceResult, DiagResult, NoteLike, RefreshResult } from "../lib/rpc";
import { fetchSolBalance } from "../lib/solana";

function fmtSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

// Turn a raw unlock failure into an actionable message. The unlock step
// prompts ONE wallet signature; if it's missed/declined it times out  -  the
// single most common reason balance "won't load".
function unlockHint(e: any): string {
  const m = String(e?.message ?? e);
  if (/timed?\s*out/i.test(m))
    return "Unlock timed out  -  open your wallet, approve the signature request, then tap Refresh.";
  if (/declin|reject|cancel|abort/i.test(m))
    return "The unlock signature was declined in the wallet. Tap Refresh and approve it.";
  return `Unlock failed: ${m}`;
}

// Explain a zero balance precisely: no notes on devnet vs. none owned by this
// wallet vs. a transient indexer/network hiccup.
function refreshHint(r: RefreshResult, onChain: number | null, owned: number): string {
  if (owned > 0) return r.added > 0 ? `Found ${r.added} new note(s)` : "Up to date";
  if (onChain === 0) return "No notes on devnet yet  -  deposit on the web app first.";
  if (r.scanned === 0)
    return "Reached the relayer but scanned 0 notes (indexer/network hiccup)  -  tap Refresh again.";
  return `Scanned ${r.scanned} note(s) on devnet; none belong to this wallet. Deposit with this same wallet on the web app.`;
}

export function HomeScreen({
  onSend,
  onSendNote,
  onOpenSettings,
}: {
  onSend: () => void;
  onSendNote: () => void;
  onOpenSettings: () => void;
}) {
  const { address, disconnect } = useWallet();
  const { call } = useBridge();
  const {
    cluster,
    balanceLamports,
    publicBalanceLamports,
    notes,
    webcrypto,
    bridgeReady,
    busy,
    busyLabel,
    error,
    setBalance,
    setPublicBalance,
    setNotes,
    setBusy,
    setError,
    setToast,
  } = useApp();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // 1. Probe the backend from inside the WebView (same fetch path the SDK
      //    uses). A wrong/dead Backend URL is the #1 cause of a flat 0  -  catch
      //    it before the wallet signature so the message is exact.
      let diag: DiagResult | null = null;
      try {
        diag = await call<DiagResult>("diag");
      } catch {}
      if (diag && !diag.reachable) {
        setError(
          `Backend unreachable  -  ${diag.backendUrl || "(empty)"}` +
            (diag.fetchError ? `  -  ${diag.fetchError}` : "") +
            `. Set the correct Backend URL in Settings, then tap Refresh.`,
        );
        return;
      }

      // 2. Unlock  -  derives the spending key from ONE wallet signature. A wallet
      //    prompt appears; it MUST be approved or this hangs and times out.
      setBusy(true, "Unlock  -  approve the signature in your wallet...");
      try {
        await call<unknown>("unlock");
      } catch (e: any) {
        throw new Error(unlockHint(e));
      }

      // 3. Scan devnet for owned notes + hydrate from the encrypted backend blob.
      setBusy(true, "Scanning devnet for your shielded notes...");
      const r = await call<RefreshResult>("refresh");
      const b = await call<BalanceResult>("balance");
      const n = await call<NoteLike[]>("getNotes");
      setBalance(b.lamports);
      setNotes(n);
      setToast(refreshHint(r, diag?.treeNextLeaf ?? null, b.noteCount));
      // Wallet's public SOL balance: what's available to deposit-and-send.
      fetchSolBalance(cluster, address ?? "").then(setPublicBalance).catch(() => {});
    } catch (e: any) {
      setError(e?.message ?? "Sync failed");
    } finally {
      setBusy(false);
    }
  }, [call, cluster, address, setBalance, setPublicBalance, setNotes, setBusy, setError, setToast]);

  // Auto-load the shielded balance once the SDK bridge is ready for this wallet,
  // so a freshly-connected user sees their notes instead of a flat 0. unlock()
  // derives the spending key and needs one wallet signature (same as web).
  const didInit = useRef(false);
  useEffect(() => {
    if (!bridgeReady || didInit.current) return;
    didInit.current = true;
    refresh();
  }, [bridgeReady, refresh]);

  // Public SOL balance shows as soon as the wallet connects (no bridge/unlock
  // needed), and refreshes whenever the connected address or cluster changes.
  useEffect(() => {
    if (!address) return;
    fetchSolBalance(cluster, address).then(setPublicBalance).catch(() => {});
  }, [address, cluster, setPublicBalance]);

  const unspent = notes.filter((n) => !n.spent);

  return (
    // Plain View root (NOT a ScrollView): as a direct flex:1 child of a bounded
    // parent it is GUARANTEED to fill the screen. ScrollView's contentContainer
    // flexGrow was not expanding on some devices -> content bunched at the top.
    // The hero (flex:1) absorbs free space so balance sits centered and the
    // actions/notes anchor to the bottom  -  full screen, no empty half.
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Logo size={30} />
          <Text style={[typography.micro, { color: theme.textSoft, letterSpacing: 1.5 }]}>PRIVACY CASH</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 18 }}>
          <Pressable onPress={onOpenSettings} hitSlop={8}>
            <Text style={[typography.small, { color: theme.textMuted }]}>Settings</Text>
          </Pressable>
          <Pressable onPress={disconnect} hitSlop={8}>
            <Text style={[typography.small, { color: theme.textMuted }]}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ flex: 1, justifyContent: "center" }}>
        <Text style={[typography.micro, { color: theme.textMuted }]}>
          Shielded balance
        </Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 6 }}>
          <Text style={[typography.hero, { color: theme.text, fontSize: 52 }]}>{fmtSol(balanceLamports)}</Text>
          <Text style={[typography.h2, { color: theme.textSoft, marginLeft: 10 }]}>SOL</Text>
        </View>
        <MonoText style={{ marginTop: 10 }}>
          {address ? address.slice(0, 6) + "..." + address.slice(-6) : ""}
        </MonoText>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 14,
          }}
        >
          <Text style={[typography.small, { color: theme.textMuted }]}>
            Wallet (deposit funds)
          </Text>
          <Text style={[typography.body, { color: theme.textSoft }]}>
            {fmtSol(publicBalanceLamports)} SOL
          </Text>
        </View>

        {!webcrypto && bridgeReady ? (
          <View style={{ marginTop: 20 }}>
            <ErrorBanner message="WebCrypto (crypto.subtle) is unavailable in this WebView. The SDK cannot run without a secure context  -  see bridge/README.md -> secure-context fallback." />
          </View>
        ) : null}

        {error ? (
          <View style={{ marginTop: 20 }}>
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </View>
        ) : null}
      </View>

      <View style={{ gap: 10 }}>
        <Button title="Send private transfer" onPress={onSend} subtitle="to any address  -  gasless via relayer" />
        <Button title="Send payment note" onPress={onSendNote} subtitle="share a redeemable note" variant="ghost" />
        <Button title={busy ? busyLabel || "Working..." : "Refresh balance"} variant="ghost" onPress={refresh} loading={busy} />
      </View>

      <Text style={[typography.micro, { color: theme.textMuted, marginTop: 24, marginBottom: 10 }]}>
        Shielded notes ({unspent.length})
      </Text>
      <View>
        {unspent.length === 0 ? (
          <Card>
            <Text style={[typography.body, { color: theme.textSoft }]}>No shielded notes yet.</Text>
            <Text style={[typography.small, { color: theme.textMuted, marginTop: 6 }]}>
              Deposit on the web app with this wallet, then tap Refresh balance.
            </Text>
          </Card>
        ) : (
          unspent
            .slice()
            .sort((a, b) => Number(b.amount) - Number(a.amount))
            .map((n) => (
              <Card key={n.id} style={{ marginBottom: 10, padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View>
                  <Text style={[typography.h2, { color: theme.text }]}>{fmtSol(Number(n.amount))} SOL</Text>
                  <MonoText style={{ marginTop: 2 }}>index {n.index}</MonoText>
                </View>
                <Pill tone="accent">unspent</Pill>
              </Card>
            ))
        )}
      </View>
    </View>
  );
}
