import React, { useCallback, useEffect, useRef } from "react";
import { View, Text, ScrollView } from "react-native";
import { useWallet } from "../wallet/WalletProvider";
import { useBridge } from "../bridge/BridgeContext";
import { useApp } from "../store";
import { Button, Card, MonoText, Pill, ErrorBanner } from "../ui/components";
import { Logo } from "../ui/Logo";
import { theme, typography } from "../ui/theme";
import type {
  BalanceResult,
  DiagResult,
  NoteLike,
  RefreshResult,
  RegisteredResult,
  RelayerInfoResult,
} from "../lib/rpc";
import { fetchSolBalance } from "../lib/solana";

function fmtSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

function fmtDate(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

// Turn a raw unlock failure into an actionable message. The unlock step
// prompts ONE wallet signature; if it's missed/declined it times out  -  the
// single most common reason the balance "won't load".
function unlockHint(e: any): string {
  const m = String(e?.message ?? e);
  if (/timed?\s*out/i.test(m))
    return "Unlock timed out  -  open your wallet, approve the signature request, then tap Scan again.";
  if (/declin|reject|cancel|abort/i.test(m))
    return "The unlock signature was declined in the wallet. Tap Scan and approve it.";
  return `Unlock failed: ${m}`;
}

// Explain a zero balance precisely: no notes on-chain yet vs. none owned by
// this wallet vs. a transient indexer/network hiccup.
function scanHint(r: RefreshResult, onChain: number | null, owned: number): string {
  if (owned > 0) return r.added > 0 ? `Found ${r.added} new payment(s)` : "Up to date";
  if (onChain === 0) return "No notes on-chain yet  -  payments appear after your employer's next payroll run.";
  if (r.scanned === 0)
    return "Reached the relayer but scanned 0 notes (indexer/network hiccup)  -  tap Scan again.";
  return `Scanned ${r.scanned} note(s); none belong to this wallet yet.`;
}

export function HomeScreen({
  onClaim,
  onOpenSettings,
}: {
  onClaim: () => void;
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
    setFees,
    setBusy,
    setError,
    setToast,
  } = useApp();

  // Full employee load: probe backend -> fee schedule -> registry check ->
  // (if enrolled) unlock + scan + balance. `enabling` covers the one-time
  // enrollment pass (three wallet signatures) and then falls through to the
  // normal unlock+scan.
  const load = useCallback(
    async (opts?: { afterEnable?: boolean }) => {
      setError(null);
      try {
        // 1. Probe the backend from inside the WebView (same fetch path the SDK
        //    uses). A wrong/dead Backend URL is the #1 cause of a flat 0  -  catch
        //    it before any wallet signature so the message is exact.
        let diag: DiagResult | null = null;
        try {
          diag = await call<DiagResult>("diag");
        } catch {}
        if (diag && !diag.reachable) {
          setError(
            `Backend unreachable  -  ${diag.backendUrl || "(empty)"}` +
              (diag.fetchError ? `  -  ${diag.fetchError}` : "") +
              `. Set the correct Backend URL in Settings, then tap Scan.`,
          );
          return;
        }

        // 2. Relayer fee schedule (for the claim preview on the Withdraw screen).
        try {
          const info = await call<RelayerInfoResult>("relayerInfo");
          setFees(info.bps, info.minFee);
        } catch {}

        // 3. Registry check: has this wallet enrolled for private receiving?
        //    (404 -> registered=false; network errors reject with a message.)
        const reg = await call<RegisteredResult>("registered");
        useApp.setState({ registered: reg.registered });
        if (!reg.registered) return; // the Enable card takes over

        // 4. Unlock  -  derives the spending key from ONE wallet signature. A
        //    wallet prompt appears; it MUST be approved or this times out.
        setBusy(
          true,
          opts?.afterEnable
            ? "Finishing setup  -  approve the last signature..."
            : "Unlock  -  approve the signature in your wallet...",
        );
        try {
          await call<unknown>("unlock");
        } catch (e: any) {
          throw new Error(unlockHint(e));
        }

        // 5. Scan for owned notes + hydrate from the encrypted backend blob.
        setBusy(true, "Scanning for your payments...");
        const r = await call<RefreshResult>("refresh");
        const b = await call<BalanceResult>("balance");
        const n = await call<NoteLike[]>("getNotes");
        setBalance(b.lamports);
        setNotes(n);
        setToast(scanHint(r, diag?.treeNextLeaf ?? null, b.noteCount));
        fetchSolBalance(cluster, address ?? "").then(setPublicBalance).catch(() => {});
      } catch (e: any) {
        setError(e?.message ?? "Sync failed");
      } finally {
        setBusy(false);
      }
    },
    [call, cluster, address, setBalance, setPublicBalance, setNotes, setFees, setBusy, setError, setToast],
  );

  // Auto-load once the SDK bridge is ready for this wallet.
  const didInit = useRef(false);
  useEffect(() => {
    if (!bridgeReady || didInit.current) return;
    didInit.current = true;
    load();
  }, [bridgeReady, load]);

  // Public SOL balance shows as soon as the wallet connects (no bridge/unlock
  // needed), and refreshes whenever the connected address or cluster changes.
  useEffect(() => {
    if (!address) return;
    fetchSolBalance(cluster, address).then(setPublicBalance).catch(() => {});
  }, [address, cluster, setPublicBalance]);

  const registered = useApp((s) => s.registered);
  const enablingRef = useRef(false);

  // One-time enrollment: THREE wallet signatures (spending key, receive key,
  // registry binding), then the normal unlock+scan pass.
  const enable = useCallback(async () => {
    if (enablingRef.current) return;
    enablingRef.current = true;
    try {
      setBusy(true, "Enabling  -  approve the signature requests in your wallet (3 total)...");
      await call<unknown>("enableReceiving");
      useApp.setState({ registered: true });
      await load({ afterEnable: true });
    } catch (e: any) {
      setError(`Could not enable private receiving: ${e?.message ?? e}`);
    } finally {
      enablingRef.current = false;
      setBusy(false);
    }
  }, [call, load, setBusy, setError]);

  const unspent = notes.filter((n) => !n.spent);

  return (
    // Plain View root (NOT a ScrollView): as a direct flex:1 child of a bounded
    // parent it is GUARANTEED to fill the screen. The payments list scrolls in
    // its own nested ScrollView at the bottom.
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Logo size={30} />
          <Text style={[typography.micro, { color: theme.textSoft, letterSpacing: 1.5 }]}>PAYROLL</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 18 }}>
          <Text style={[typography.small, { color: theme.textMuted }]} onPress={onOpenSettings}>
            Settings
          </Text>
          <Text style={[typography.small, { color: theme.textMuted }]} onPress={disconnect}>
            Disconnect
          </Text>
        </View>
      </View>

      {registered === false ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Card>
            <Text style={[typography.h2, { color: theme.text }]}>Enable private receiving</Text>
            <Text style={[typography.body, { color: theme.textSoft, marginTop: 10 }]}>
              Your employer can pay you with a private note  -  invisible on-chain  -  instead
              of a public transfer. One-time setup: approve three signature requests to
              publish your receiving keys. Until then, payouts arrive as normal public SOL
              transfers.
            </Text>
            <View style={{ marginTop: 18 }}>
              <Button title="Enable private receiving" onPress={enable} loading={busy} />
            </View>
          </Card>
        </View>
      ) : (
        <>
          <View style={{ marginTop: 28 }}>
            <Text style={[typography.micro, { color: theme.textMuted }]}>Shielded pay balance</Text>
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
                Wallet (where claims land)
              </Text>
              <Text style={[typography.body, { color: theme.textSoft }]}>
                {fmtSol(publicBalanceLamports)} SOL
              </Text>
            </View>
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

          <View style={{ gap: 10, marginTop: 24 }}>
            <Button title="Claim to wallet" onPress={onClaim} subtitle="move notes out of the shielded pool" />
            <Button
              title={busy ? busyLabel || "Working..." : "Scan for payments"}
              variant="ghost"
              onPress={() => load()}
              loading={busy}
            />
          </View>

          <Text style={[typography.micro, { color: theme.textMuted, marginTop: 20, marginBottom: 10 }]}>
            Received payments ({unspent.length})
          </Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 4 }}>
            {unspent.length === 0 ? (
              <Card>
                <Text style={[typography.body, { color: theme.textSoft }]}>No private payments yet.</Text>
                <Text style={[typography.small, { color: theme.textMuted, marginTop: 6 }]}>
                  When your employer runs a shielded payroll they appear here after a scan.
                </Text>
              </Card>
            ) : (
              unspent
                .slice()
                .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
                .map((n) => (
                  <Card
                    key={n.id}
                    style={{ marginBottom: 10, padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <View style={{ flexShrink: 1 }}>
                      <Text style={[typography.h2, { color: theme.text }]}>{fmtSol(Number(n.amount))} SOL</Text>
                      <MonoText style={{ marginTop: 2 }}>
                        leaf #{n.index}
                        {n.createdAt ? "  -  " + fmtDate(n.createdAt) : ""}
                      </MonoText>
                    </View>
                    <Pill tone="accent">unspent</Pill>
                  </Card>
                ))
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}
