import { useCallback, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowRight, History, Play, Settings, Users, Wallet } from "lucide-react"
import { totalBalance } from "privacy-cash-sdk"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { HistoryPage } from "@/components/HistoryPage"
import { PlanReviewCard } from "@/components/PlanReviewCard"
import { RunProgressCard } from "@/components/RunProgressCard"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { TeamPage } from "@/components/TeamPage"
import { UploadCard } from "@/components/UploadCard"
import { WalletBar } from "@/components/WalletBar"
import { useConnectWallet } from "@/components/WalletProvider"
import { usePayrollClient } from "@/hooks/usePayrollClient"
import { browserProverInfo, ensureBrowserProver } from "@/lib/browserProver"
import { createEngine, type RunSnapshot } from "@/lib/engine"
import { failedEntriesOf, storageOk } from "@/lib/store"
import type { Asset, ParsedFile, RunMode, RunReceipt } from "@/lib/types"

type Page = "payroll" | "history" | "team"

export function EmployerApp() {
  const { open: openModal } = useConnectWallet()
  const { publicKey } = useWallet()
  const { client, ready, busy, error, vaultSolRaw, bps, minTransferFee, refreshVault, unlocked, unlockBusy, unlockNow } =
    usePayrollClient()
  const [storageWarn] = useState(() => !storageOk())
  const [page, setPage] = useState<Page>("payroll")

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
      setSnapshot({ phase: "funding", rows: entries.map((e) => ({ ...e, status: "queued" as const, attempts: 0 })), startedAt: Date.now() })
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
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:flex-row">
      {/* Sidebar nav (top tab bar on phones) */}
      <aside className="lg:w-52 lg:flex-none">
        <div className="flex items-center justify-between gap-2 lg:sticky lg:top-6 lg:flex-col lg:items-stretch lg:gap-1">
          <div className="hidden lg:block">
            <div className="mb-4 flex items-center gap-2">
              <img src="/charon-mark.png" alt="Charon" className="size-7 rounded-md" />
              <p className="h-display text-lg">Charon Pay</p>
            </div>
          </div>
          {(
            [
              ["payroll", "Payroll", Play],
              ["history", "History", History],
              ["team", "Team", Users],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                page === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
          <button
            onClick={() => setSettingsOpen(true)}
            className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:flex"
          >
            <Settings className="size-4" /> Settings
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="h-display text-2xl">
            {page === "payroll" ? "Payroll runs" : page === "history" ? "Past payments" : "Team"}
          </h1>
          <WalletBar
            vaultSolRaw={vaultSolRaw}
            relayerOk={bps !== null}
            unlocked={unlocked}
            unlockBusy={unlockBusy}
            onUnlock={unlockNow}
            onOpenSettings={() => setSettingsOpen(true)}
            onFunded={refreshVault}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {storageWarn && (
          <p className="text-sm text-muted-foreground">
            Browser storage is unavailable — runs will work but receipts won't persist.
          </p>
        )}

        {page === "history" ? (
          <HistoryPage onResumeFailed={resumeFailed} />
        ) : page === "team" ? (
          <TeamPage extraEntries={parsed?.entries} />
        ) : !publicKey ? (
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
          <p className="text-sm text-muted-foreground">Connecting… (fetching relayer config)</p>
        ) : unlockBusy ? (
          <p className="text-sm text-muted-foreground">Unlocking vault… (approve the signature request)</p>
        ) : (
          <>
            {/* A live run owns the page: upload + review hide the moment the
                run starts and only come back on "New run". */}
            {!snapshot && (
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
              </>
            )}
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

        {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  )
}
