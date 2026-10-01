import { useCallback, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowRight, Wallet } from "lucide-react"
import { totalBalance } from "privacy-cash-sdk"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { HistoryCard } from "@/components/HistoryCard"
import { PlanReviewCard } from "@/components/PlanReviewCard"
import { RunProgressCard } from "@/components/RunProgressCard"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { UploadCard } from "@/components/UploadCard"
import { WalletBar } from "@/components/WalletBar"
import { useConnectWallet } from "@/components/WalletProvider"
import { usePayrollClient } from "@/hooks/usePayrollClient"
import { browserProverInfo, ensureBrowserProver } from "@/lib/browserProver"
import { createEngine, type RunSnapshot } from "@/lib/engine"
import { failedEntriesOf, storageOk } from "@/lib/store"
import type { Asset, ParsedFile, RunMode, RunReceipt } from "@/lib/types"

export function EmployerApp() {
  const { open: openModal } = useConnectWallet()
  const { publicKey } = useWallet()
  const { client, ready, busy, error, vaultSolRaw, bps, minTransferFee, refreshVault } = usePayrollClient()
  const [storageWarn] = useState(() => !storageOk())

  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const engineRef = useRef<{ cancel: () => void } | null>(null)
  // Kept so a stopped/crashed run's failed rows can be retried without the
  // receipt (snapshots don't carry asset/mode/fileHash).
  const lastRun = useRef<{ asset: Asset; mode: RunMode; fileHash: string } | null>(null)

  const startRun = useCallback(
    async (
      asset: Asset,
      entries = parsed?.entries,
      fileHash = parsed?.fileHash,
      mode: RunMode = "public",
    ) => {
      if (!client || !entries || !fileHash || bps === null) return
      lastRun.current = { asset, mode, fileHash }
      setReceipt(null)
      setSnapshot({ phase: "funding", rows: entries.map((e) => ({ ...e, status: "queued" as const, attempts: 0 })) })
      const engine = createEngine(client)
      engineRef.current = engine
      try {
        // Prove client-side on the wasm-arkworks engine (standard circuit);
        // falls back to in-page snarkjs if the worker pool can't start.
        try {
          const info = await ensureBrowserProver()
          if (!browserProverInfo()?.proves) toast.success(`Browser prover ready (${info.workers} workers)`)
        } catch (e) {
          toast.warning(`Browser prover unavailable, using snarkjs: ${(e as Error).message}`)
        }
        let vaultRaw = vaultSolRaw ?? 0n
        if (asset.kind === "spl") {
          await client.syncNotes(asset.mint)
          vaultRaw = totalBalance(client.publicKey, asset.mint)
        }
        const r = await engine.run(
          { fileHash, asset, entries, bps, vaultRaw, mode, minTransferFee },
          setSnapshot,
        )
        await refreshVault()
        setReceipt(r)
        if (r.summary.failed > 0) toast.warning(`${r.summary.failed} payout(s) failed — resume available`)
        else toast.success("Payroll run complete")
      } catch (e) {
        toast.error(`Run crashed: ${(e as Error).message}`)
        // Keep the rows on screen and mark the run stopped so the failed
        // ones can be retried; clearing the snapshot would hide the state.
        setSnapshot((s) => (s ? { ...s, phase: "aborted" } : null))
      }
    },
    [client, parsed, bps, minTransferFee, vaultSolRaw, refreshVault],
  )

  const resumeFailed = useCallback(
    (r: RunReceipt) => {
      const entries = failedEntriesOf(r)
      if (!entries.length) return
      setParsed({ entries, fileHash: r.fileHash })
      startRun(r.asset, entries, r.fileHash, r.mode)
    },
    [startRun],
  )

  const resumeAbortedSnapshot = useCallback(() => {
    const cfg = lastRun.current
    if (!cfg || !snapshot) return
    const entries = snapshot.rows
      .filter((r) => r.status === "failed")
      .map((r) => ({ address: r.address, amountHuman: r.amountHuman, memo: r.memo }))
    if (!entries.length) return
    startRun(cfg.asset, entries, cfg.fileHash, cfg.mode)
  }, [snapshot, startRun])

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <p className="eyebrow">treasury console</p>
        <h1 className="h-display -mt-2 text-2xl">Payroll runs</h1>
      </div>
      <WalletBar
        vaultSolRaw={vaultSolRaw}
        relayerOk={bps !== null}
        onOpenSettings={() => setSettingsOpen(true)}
        onFunded={refreshVault}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {storageWarn && (
        <p className="text-sm text-muted-foreground">
          Browser storage is unavailable — runs will work but receipts won't persist.
        </p>
      )}

      {!publicKey ? (
        <Card className="card-lift border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl border border-zinc-200 bg-secondary">
              <Wallet className="size-7 text-primary" />
            </div>
            <div>
              <p className="h-display text-lg">Connect the treasury wallet</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                One signature unlocks the vault — then pay everyone from this screen, gasless.
              </p>
            </div>
            <Button size="lg" className="btn-glow" onClick={openModal}>
              Connect wallet <ArrowRight className="ml-1 size-4" />
            </Button>
          </CardContent>
        </Card>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">Unlocking vault… (approve the signature request)</p>
      ) : (
        <>
          <UploadCard onParsed={setParsed} />
          <PlanReviewCard
            parsed={parsed}
            bps={bps}
            minTransferFee={minTransferFee}
            vaultSolRaw={vaultSolRaw}
            disabled={!ready}
            onRun={(asset, mode) => startRun(asset, undefined, undefined, mode)}
          />
          <RunProgressCard
            snapshot={snapshot}
            receipt={receipt}
            onCancel={() => engineRef.current?.cancel()}
            onDone={() => { setSnapshot(null); setReceipt(null); setParsed(null) }}
            onResumeFailed={() => receipt && resumeFailed(receipt)}
            onResumeSnapshot={resumeAbortedSnapshot}
          />
        </>
      )}

      <HistoryCard onResumeFailed={resumeFailed} />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
