import { useCallback, useEffect, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowRight, History, Play, Settings, Users } from "lucide-react"
import { getBackendUrl, totalBalance } from "privacy-cash-sdk"

import { GliderGroup } from "@/components/motion/Glider"
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
import { ensureBrowserProver, recommendedWorkers } from "@/lib/browserProver"
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
  const lastRun = useRef<{ asset: Asset; mode: RunMode; fileHash: string; lanes: number } | null>(null)

  // Long quiet phases (lane fan-out, indexer catch-up, post-error
  // adjudication) must never look like a hang: surface the engine's own
  // status sentence as a toast whenever it changes, and warn when a live run
  // has gone a full minute without any snapshot update at all.
  const lastActivity = useRef(Date.now())
  const lastStatus = useRef<string | undefined>(undefined)
  const phase = snapshot?.phase
  const status = snapshot?.status
  useEffect(() => {
    if (!snapshot) return
    lastActivity.current = Date.now()
    if (status && status !== lastStatus.current) {
      lastStatus.current = status
      toast.info(status, { duration: 8000 })
    }
  }, [snapshot, status])
  // Preload the prover pool while the user is still uploading/planning, so
  // the first Run doesn't pay the cold MT init (artifact fetch + parse +
  // thread spawn) as a blank minute at the start of the run.
  useEffect(() => {
    let alive = true
    void ensureBrowserProver()
      .then((info) => {
        if (alive)
          toast.success(
            `Browser prover ready — ${info.workers} ${info.mode === "mt" ? "MT" : "ST"} worker${info.workers === 1 ? "" : "s"}${info.mode === "mt" ? ` × ${info.threads} threads` : ""}`,
            { duration: 6000 },
          )
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (phase !== "funding" && phase !== "paying") return
    const t = setInterval(() => {
      if (Date.now() - lastActivity.current <= 60_000) return
      toast.warning(
        `Still working — nothing new for over a minute.${status ? ` Last step: ${status}` : ""}`,
        { duration: 10000 },
      )
      lastActivity.current = Date.now()
    }, 15_000)
    return () => clearInterval(t)
  }, [phase, status])

  const startRun = useCallback(
    async (
      asset: Asset,
      entries = parsed?.entries,
      fileHash = parsed?.fileHash,
      mode: RunMode = "public",
      lanes = 8,
    ) => {
      if (!client || !entries || !fileHash || bps === null) return
      lastRun.current = { asset, mode, fileHash, lanes }
      setReceipt(null)
      setSnapshot({ phase: "funding", rows: entries.map((e) => ({ ...e, status: "queued" as const, attempts: 0 })), startedAt: Date.now() })
      toast.info(`Run started — ${lanes} lane${lanes === 1 ? "" : "s"}, ${entries.length} payout${entries.length === 1 ? "" : "s"}`)
      const engine = createEngine(client)
      engineRef.current = engine
      try {
        // Prove client-side on the wasm-arkworks engine (standard circuit);
        // falls back to in-page snarkjs if the worker pool can't start.
        // The pool shape is dynamic: recommendedWorkers re-inits it when a
        // run needs a different split (1 lane → 1×all-cores, bigger runs →
        // up to 2 workers).
        try {
          const info = await ensureBrowserProver({ workers: recommendedWorkers(lanes) })
          toast.info(`Prover: ${info.workers} ${info.mode === "mt" ? "MT" : "ST"} worker${info.workers === 1 ? "" : "s"}${info.mode === "mt" ? ` × ${info.threads} threads` : ""} · run: ${lanes} lane${lanes === 1 ? "" : "s"}`)
        } catch (e) {
          toast.warning(`Browser prover unavailable, using snarkjs: ${(e as Error).message}`)
        }
        let vaultRaw = vaultSolRaw ?? 0n
        if (asset.kind === "spl") {
          await client.syncNotes(asset.mint)
          vaultRaw = totalBalance(client.publicKey, asset.mint)
        }
        const r = await engine.run(
          { fileHash, asset, entries, bps, vaultRaw, mode, minTransferFee, lanes },
          setSnapshot,
        )
        // Local telemetry: per-row timing breakdown + failures land in
        // /tmp/run-telemetry.json so "where the time goes" is always answerable.
        void fetch(`${getBackendUrl()}/api/debug/run-telemetry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            at: new Date().toISOString(),
            mode,
            lanes,
            rows: entries.length,
            summary: r.summary,
            splits: r.splits,
            perRow: r.entries.map((e) => ({
              status: e.status,
              attempts: e.attempts,
              error: e.error,
              timing: e.timing,
            })),
          }),
        }).catch(() => {})
        await refreshVault()
        setReceipt(r)
        if (r.summary.failed > 0) toast.warning(`${r.summary.failed} payout(s) failed — resume available`)
        else toast.success("Payroll run complete")
      } catch (e) {
        const err = e as Error
        toast.error(`Run crashed: ${err.message}`)
        // Local telemetry: crashes land with their stack so failures like
        // "invalid BigInt syntax" are diagnosable offline.
        void fetch(`${getBackendUrl()}/api/debug/run-telemetry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            at: new Date().toISOString(),
            crash: err.message,
            stack: (err.stack ?? "").slice(0, 4000),
            lanes,
            rows: entries.length,
          }),
        }).catch(() => {})
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
      startRun(r.asset, entries, r.fileHash, r.mode, lastRun.current?.lanes ?? 8)
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
    startRun(cfg.asset, entries, cfg.fileHash, cfg.mode, cfg.lanes ?? 8)
  }, [snapshot, startRun])

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:flex-row">
      {/* Sidebar nav (top tab bar on phones): pill group with a gliding indicator */}
      <aside className="lg:w-52 lg:flex-none">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 p-1 lg:sticky lg:top-6 lg:flex-col lg:items-stretch lg:justify-start lg:gap-0.5">
          <GliderGroup
            value={page}
            onChange={(id) => setPage(id)}
            className="flex flex-1 justify-between gap-0.5 lg:flex-col lg:items-stretch"
            itemClassName="flex-1 justify-center lg:justify-start"
            items={[
              { id: "payroll", label: "Payroll", icon: <Play className="size-4" /> },
              { id: "history", label: "History", icon: <History className="size-4" /> },
              { id: "team", label: "Team", icon: <Users className="size-4" /> },
            ]}
          />
          <button
            onClick={() => setSettingsOpen(true)}
            className="hidden items-center gap-2 rounded-md px-3 py-2 text-sm text-body-ink transition-colors hover:bg-card/60 hover:text-ink lg:flex"
          >
            <Settings className="size-4" /> Settings
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-gold">
              {page === "payroll" ? "Treasury Console" : page === "history" ? "Ledger" : "Recipients"}
            </div>
            <h1 className="h-display mt-0.5 text-2xl">
              {page === "payroll" ? "Payroll runs" : page === "history" ? "Past payments" : "Team"}
            </h1>
          </div>
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
          <Card className="card-lift specular overflow-hidden">
            <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-[var(--gold-2)] opacity-20 blur-2xl" />
                <img
                  src="/charon-mark.png"
                  alt=""
                  className="relative size-14 rounded-full object-contain"
                />
              </div>
              <div>
                <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-gold">
                  Connect Treasury
                </p>
                <p className="h-display mt-1 text-lg">Connect the treasury wallet</p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-body-ink">
                  One signature unlocks the vault — then pay everyone from this screen, gasless.
                </p>
              </div>
              <Button size="lg" className="btn-glow" onClick={openModal}>
                Connect wallet <ArrowRight className="ml-1 size-4" />
              </Button>
              <p className="rounded border border-line bg-panel px-3 py-1 font-mono text-[11px] text-body-ink">
                PROGRAM_ID · shielded merkle pool
              </p>
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
                  onRun={(asset, mode, lanes) => startRun(asset, undefined, undefined, mode, lanes)}
                />
              </>
            )}
            <RunProgressCard
              snapshot={snapshot}
              receipt={receipt}
              onCancel={() => {
                toast.info("Cancelling — in-flight payouts finish, no new ones start…")
                setSnapshot((s) => (s && s.phase !== "settled" ? { ...s, phase: "aborted" } : s))
                engineRef.current?.cancel()
              }}
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
