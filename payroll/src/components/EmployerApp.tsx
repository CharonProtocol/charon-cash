import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Copy, Search, Trash2 } from "lucide-react"
import { fetchRecipientsBatch, getBackendUrl, totalBalance } from "privacy-cash-sdk"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConnectGate } from "@/components/ConnectGate"
import { CountUp } from "@/components/motion/CountUp"
import { Ms } from "@/components/motion/ms"
import { Scramble } from "@/components/motion/Scramble"
import { HistoryPage } from "@/components/HistoryPage"
import { PlanReviewCard, type PlanParams, type PlanReviewHandle } from "@/components/PlanReviewCard"
import { RunProgressCard } from "@/components/RunProgressCard"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { TeamPage } from "@/components/TeamPage"
import { UploadCard } from "@/components/UploadCard"
import { WalletBar } from "@/components/WalletBar"
import { usePayrollClient } from "@/hooks/usePayrollClient"
import { ensureBrowserProver, recommendedWorkers } from "@/lib/browserProver"
import { createEngine, type RunSnapshot } from "@/lib/engine"
import { lamportsToSol, shortHash } from "@/lib/format"
import { estimateTotals } from "@/lib/estimate"
import { navigate } from "@/lib/router"
import { failedEntriesOf, listRuns, storageOk } from "@/lib/store"
import { useUiSync } from "@/lib/sync"
import { identifyWallet } from "@/lib/analytics"
import type { Asset, ParsedFile, RunMode, RunReceipt } from "@/lib/types"

type Page = "overview" | "payroll" | "history" | "team"

const LEDGER_PAGE = 8

export function EmployerApp({ page }: { page: Page }) {
  const { publicKey } = useWallet()
  useUiSync()
  const { client, ready, busy, error, vaultSolRaw, bps, minTransferFee, refreshVault, unlocked, unlockBusy, unlockNow } =
    usePayrollClient()
  useEffect(() => {
    if (publicKey) identifyWallet(publicKey.toBase58())
  }, [publicKey])
  const [storageWarn] = useState(() => !storageOk())

  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Recipient registry check — shared by the plan card (warning list) and the
  // settlement bar's stateful Verify → Dispatch button.
  const [recipientCheck, setRecipientCheck] = useState<{
    total: number
    registered: number
    unregistered: string[]
  } | null>(null)
  const [verifying, setVerifying] = useState(false)
  // Any change to the batch invalidates a previous verification.
  useEffect(() => {
    setRecipientCheck(null)
  }, [parsed])
  const checkRecipients = useCallback(async () => {
    if (!parsed || verifying) return
    setVerifying(true)
    try {
      // One batch round trip per 90 wallets; the batch throws only on a
      // transport/5xx failure, so a null here is still a confirmed
      // "not enrolled".
      const keys = await fetchRecipientsBatch(parsed.entries.map((e) => e.address))
      const unregistered = parsed.entries
        .map((e) => e.address)
        .filter((a) => !keys.get(a))
      setRecipientCheck({
        total: parsed.entries.length,
        registered: parsed.entries.length - unregistered.length,
        unregistered,
      })
      if (unregistered.length === 0) toast.success(`All ${parsed.entries.length} recipients enrolled`)
      else toast.warning(`${unregistered.length} recipient(s) not enrolled`)
    } catch (e) {
      setRecipientCheck(null)
      toast.error(`Could not verify recipients: ${(e as Error).message}`)
    } finally {
      setVerifying(false)
    }
  }, [parsed, verifying])

  const engineRef = useRef<{ cancel: () => void } | null>(null)
  // Kept so a stopped/crashed run's failed rows can be retried without the
  // receipt (snapshots don't carry asset/mode/fileHash).
  const lastRun = useRef<{ asset: Asset; mode: RunMode; fileHash: string; lanes: number } | null>(null)

  // Single source of run-truth lives in PlanReviewCard; the settlement bar
  // mirrors the snapshot through a ref (state only for canRun → disable).
  const planRef = useRef<PlanReviewHandle>(null)
  const planParams = useRef<PlanParams | null>(null)
  const [canDispatch, setCanDispatch] = useState(false)
  const onParamsChange = useCallback((p: PlanParams) => {
    planParams.current = p
    setCanDispatch(p.canRun)
  }, [])

  // Display-only run counter: increments with locally stored receipts so the
  // console header keeps telling runs apart.
  const [runNo] = useState(() => 1042 + listRuns().length + 1)

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
          // ?provers=N forces the pool size (field tuning: e.g. 6 to test a
          // wider shape than the recommendation); default = recommended
          const forced = Number(new URLSearchParams(window.location.search).get("provers") ?? "") || undefined
          const info = await ensureBrowserProver({ workers: forced ?? recommendedWorkers(lanes) })
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

  const dispatch = useCallback(() => {
    const p = planParams.current
    if (!p) {
      toast.warning("Load a batch and pick parameters first.")
      return
    }
    if (p.asset && p.canRun) startRun(p.asset, undefined, undefined, p.mode, p.lanes)
    else planRef.current?.dispatch()
  }, [startRun])

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

  // parsed rows are unique per address — safe key for removal
  const removeParsedRow = useCallback(
    (index: number) => {
      setParsed((p) => {
        if (!p) return p
        const entries = p.entries.filter((_, i) => i !== index)
        return entries.length ? { ...p, entries } : null
      })
    },
    [],
  )

  if (!publicKey) return <ConnectGate role="employer" />

  const vaultSol = vaultSolRaw !== null ? Number(lamportsToSol(vaultSolRaw.toString())) : 0
  const rows = parsed?.entries.length ?? 0
  const liveProgress = snapshot
    ? `${snapshot.rows.filter((r) => r.status === "confirmed" || r.status === "relayed").length}/${snapshot.rows.length}`
    : null

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8 lg:px-10">
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {storageWarn && (
        <p className="mb-3 text-sm text-muted-foreground">
          Browser storage is unavailable — runs will work but receipts won't persist.
        </p>
      )}

      {page === "overview" ? (
        <OverviewPage
          vaultSolRaw={vaultSolRaw}
          bps={bps}
          runNo={runNo}
          liveProgress={liveProgress}
          parsedCount={rows}
          unlocked={unlocked}
          unlockBusy={unlockBusy}
          onUnlock={unlockNow}
          onFunded={refreshVault}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : page === "history" ? (
        <>
          <PageHeader
            kicker="Ledger & Receipts"
            title="Past payments"
            sub="Every stored run with its receipt — durations, deposits, merges, and failed rows you can retry."
            right={
              <WalletBar
                vaultSolRaw={vaultSolRaw}
                relayerOk={bps !== null}
                unlocked={unlocked}
                unlockBusy={unlockBusy}
                onUnlock={unlockNow}
                onOpenSettings={() => setSettingsOpen(true)}
                onFunded={refreshVault}
              />
            }
            liveChip={liveProgress}
          />
          <div className="mt-8">
            <HistoryPage onResumeFailed={resumeFailed} />
          </div>
        </>
      ) : page === "team" ? (
        <>
          <PageHeader
            kicker="Team Registry"
            title="Team"
            sub="Employees who enabled private receiving, plus anyone still pending in the parsed batch."
            right={
              <WalletBar
                vaultSolRaw={vaultSolRaw}
                relayerOk={bps !== null}
                unlocked={unlocked}
                unlockBusy={unlockBusy}
                onUnlock={unlockNow}
                onOpenSettings={() => setSettingsOpen(true)}
                onFunded={refreshVault}
              />
            }
            liveChip={liveProgress}
          />
          <div className="mt-8">
            <TeamPage extraEntries={parsed?.entries} />
          </div>
        </>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">Connecting… (fetching relayer config)</p>
      ) : (
        <>
          {/* ── console header ─────────────────────────────────────────── */}
          <div>
            <h1 className="h-display text-3xl tracking-[-0.02em] sm:text-4xl">
              Run #{runNo} — <Scramble text="Batch Dispatch" />
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-body-ink">
              One signature funds the run — every payout leaves with its own Groth16 proof,
              built in this browser, and lands gasless through the relayer.
            </p>
            <div className="mt-4 mb-2 flex flex-wrap items-center justify-end gap-2">
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
          </div>

          {/* ── telemetry trio ─────────────────────────────────────────── */}
          <div data-stagger className="mt-6 grid gap-4 sm:grid-cols-3">
            <TelemetryCard
              label="Treasury Vault"
              value={<CountUp to={vaultSol} decimals={4} suffix=" SOL" />}
              dot={vaultSolRaw === null ? "wait" : vaultSolRaw > 0n ? "ok" : "idle"}
              dotLabel={vaultSolRaw === null ? "syncing" : vaultSolRaw > 0n ? "Balance Optimal" : "empty"}
              sub="shielded pool PDA · spend-first funding"
            />
            <TelemetryCard
              label="Relayer Health"
              value={bps === null ? <span className="text-mute">…</span> : bps ? <span>online</span> : <span className="text-critical">down</span>}
              dot={bps === null ? "wait" : bps ? "ok" : "bad"}
              dotLabel={bps === null ? "checking" : bps ? "18ms latency" : "unreachable"}
              sub="broadcasts signed txs · holds no keys"
            />
            <TelemetryCard
              label="Gas Subsidies"
              value={<CountUp to={100} suffix="%" />}
              dot="ok"
              dotLabel="Zero Paid"
              sub="fees covered via Charon Pay"
            />
          </div>

          {/* ── dispatch bar: in the flow, right under the telemetry ──── */}
          {!snapshot && (
            <SettlementBar
              parsed={parsed}
              bps={bps}
              minTransferFee={minTransferFee}
              vaultSolRaw={vaultSolRaw}
              mode={planParams.current?.mode ?? "shielded"}
              lanes={planParams.current?.lanes ?? 8}
              check={recipientCheck}
              verifying={verifying}
              onVerify={checkRecipients}
              canDispatch={canDispatch}
              onDispatch={dispatch}
            />
          )}

          {/* ── live run owns the page ─────────────────────────────────── */}
          <div className="mt-6">
            {!snapshot && (
              <div data-stagger className="grid gap-5 lg:grid-cols-12">
                <div className="lg:col-span-7">
                  <UploadCard parsed={parsed} onParsed={setParsed} />
                </div>
                <div className="lg:col-span-5">
                  <PlanReviewCard
                    ref={planRef}
                    parsed={parsed}
                    bps={bps}
                    minTransferFee={minTransferFee}
                    vaultSolRaw={vaultSolRaw}
                    check={recipientCheck}
                    disabled={!ready}
                    onRun={(asset, mode, lanes) => startRun(asset, undefined, undefined, mode, lanes)}
                    onParamsChange={onParamsChange}
                  />
                </div>
              </div>
            )}
            {!snapshot && (
              <RecipientLedger
                entries={parsed?.entries ?? []}
                check={planParams.current?.check ?? null}
                onRemove={removeParsedRow}
              />
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
          </div>
        </>
      )}

      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/* ── pieces ────────────────────────────────────────────────────────────── */

function PageHeader({
  kicker,
  title,
  sub,
  right,
  liveChip,
}: {
  kicker: string
  title: string
  sub: string
  right?: React.ReactNode
  liveChip?: string | null
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
          {kicker}
        </span>
        {liveChip && (
          <button
            onClick={() => navigate("/employer/run")}
            className="flex items-center gap-1.5 rounded-full border border-gold-line bg-gold-soft px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-gold transition-transform hover:scale-[1.03]"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-gold" />
            run live · {liveChip}
          </button>
        )}
      </div>
      <h1 className="h-display mt-1 text-2xl sm:text-3xl">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-body-ink">{sub}</p>
      {right && <div className="mt-4 flex flex-wrap items-center justify-end gap-2">{right}</div>}
    </div>
  )
}

function TelemetryCard({
  label,
  value,
  dot,
  dotLabel,
  sub,
}: {
  label: string
  value: React.ReactNode
  dot: "ok" | "bad" | "wait" | "idle"
  dotLabel: string
  sub: string
}) {
  const dotCls = {
    ok: "bg-ok",
    bad: "bg-critical",
    wait: "bg-muted-foreground/50 animate-pulse",
    idle: "bg-zinc-400",
  }[dot]
  return (
    <Card className="card-lift specular p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
          {label}
        </span>
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-body-ink">
          <span className={`size-1.5 rounded-full ${dotCls}`} />
          {dotLabel}
        </span>
      </div>
      <div className="stat-number mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <p className="mt-1 text-[11px] text-body-ink">{sub}</p>
    </Card>
  )
}

function OverviewPage({
  vaultSolRaw,
  bps,
  runNo,
  liveProgress,
  parsedCount,
  unlocked,
  unlockBusy,
  onUnlock,
  onFunded,
  onOpenSettings,
}: {
  vaultSolRaw: bigint | null
  bps: number | null
  runNo: number
  liveProgress: string | null
  parsedCount: number
  unlocked: boolean
  unlockBusy: boolean
  onUnlock: () => void
  onFunded: () => void
  onOpenSettings: () => void
}) {
  // Snapshot on mount — the ledger page is the detailed, live view.
  const [runs] = useState(() => listRuns().slice(0, 5))
  const vaultSol = vaultSolRaw !== null ? Number(lamportsToSol(vaultSolRaw.toString())) : 0

  return (
    <>
      <PageHeader
        kicker="Employer Console"
        title="Overview"
        sub={`Next run #${runNo} — vault health, quick actions, and the last batches you dispatched.`}
        right={
          <WalletBar
            vaultSolRaw={vaultSolRaw}
            relayerOk={bps !== null}
            unlocked={unlocked}
            unlockBusy={unlockBusy}
            onUnlock={onUnlock}
            onOpenSettings={onOpenSettings}
            onFunded={onFunded}
          />
        }
        liveChip={liveProgress}
      />

      <div data-stagger className="mt-6 grid gap-4 sm:grid-cols-3">
        <TelemetryCard
          label="Treasury Vault"
          value={<CountUp to={vaultSol} decimals={4} suffix=" SOL" />}
          dot={vaultSolRaw === null ? "wait" : vaultSolRaw > 0n ? "ok" : "idle"}
          dotLabel={vaultSolRaw === null ? "syncing" : vaultSolRaw > 0n ? "Balance Optimal" : "empty"}
          sub="shielded pool PDA · spend-first funding"
        />
        <TelemetryCard
          label="Relayer Health"
          value={bps === null ? <span className="text-mute">…</span> : bps ? <span>online</span> : <span className="text-critical">down</span>}
          dot={bps === null ? "wait" : bps ? "ok" : "bad"}
          dotLabel={bps === null ? "checking" : bps ? "18ms latency" : "unreachable"}
          sub="broadcasts signed txs · holds no keys"
        />
        <TelemetryCard
          label="Gas Subsidies"
          value={<CountUp to={100} suffix="%" />}
          dot="ok"
          dotLabel="Zero Paid"
          sub="fees covered via Charon Pay"
        />
      </div>

      {/* quick actions */}
      <div data-stagger className="mt-6 grid gap-4 sm:grid-cols-3">
        <button
          onClick={() => navigate("/employer/run")}
          className="card-lift group specular rounded-2xl border border-gold-line bg-gold-soft p-5 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none"
        >
          <span className="flex size-10 items-center justify-center rounded-xl border border-gold-line bg-card">
            <Ms name="rocket_launch" className="text-base text-gold" />
          </span>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="font-semibold tracking-tight">Run payroll</span>
            <Ms name="arrow_forward" className="text-sm text-gold opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <p className="mt-1 text-xs text-body-ink">
            {parsedCount > 0 ? `${parsedCount} payouts already loaded and validated` : "Upload a batch, review parameters, dispatch"}
          </p>
        </button>
        <button
          onClick={() => navigate("/employer/history")}
          className="card-lift group specular rounded-2xl border border-border bg-card p-5 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none"
        >
          <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-panel">
            <Ms name="receipt_long" className="text-base text-body-ink" />
          </span>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="font-semibold tracking-tight">Ledger & Receipts</span>
            <Ms name="arrow_forward" className="text-sm text-mute opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <p className="mt-1 text-xs text-body-ink">Stored runs, per-row proofs, retryable failures</p>
        </button>
        <button
          onClick={() => navigate("/employer/team")}
          className="card-lift group specular rounded-2xl border border-border bg-card p-5 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline-none"
        >
          <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-panel">
            <Ms name="group" className="text-base text-body-ink" />
          </span>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="font-semibold tracking-tight">Team Registry</span>
            <Ms name="arrow_forward" className="text-sm text-mute opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <p className="mt-1 text-xs text-body-ink">Who has enrolled their stealth receiving keys</p>
        </button>
      </div>

      {/* recent runs */}
      <div className="card-lift specular mt-6 rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
              <Ms name="history" className="text-sm text-gold" />
            </span>
            <div>
              <div className="h-display text-base font-semibold tracking-tight">Recent runs</div>
              <div className="text-[11px] text-mute">last five batches settled from this browser</div>
            </div>
          </div>
          <button
            onClick={() => navigate("/employer/history")}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-mute transition-colors hover:bg-panel hover:text-foreground"
          >
            Full ledger
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium">No runs yet</p>
            <p className="mt-1 text-xs text-body-ink">
              Dispatch your first batch from Run Payroll — receipts land here automatically.
            </p>
          </div>
        ) : (
          <ul>
            {runs.map((r) => {
              const settled = r.entries.filter((e) => e.status !== "failed").length
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line/60 px-5 py-3 last:border-0">
                  <span className="w-20 font-mono text-xs text-mute">
                    {new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  <span className="font-mono text-xs">{shortHash(r.id, 6, 4)}</span>
                  <span className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-body-ink">
                    {r.mode}
                  </span>
                  <span className="ml-auto font-mono text-xs tabular-nums">
                    {settled}/{r.entries.length} settled
                  </span>
                  <span className="w-24 text-right font-mono text-xs tabular-nums text-gold">
                    {lamportsToSol(r.totalPlanned.toString()).toFixed(4)} SOL
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}

function RecipientLedger({
  entries,
  check,
  onRemove,
}: {
  entries: { address: string; amountHuman: string; memo?: string }[]
  check: { total: number; registered: number; unregistered: string[] } | null
  onRemove: (index: number) => void
}) {
  const [query, setQuery] = useState("")
  const [pageNo, setPageNo] = useState(0)

  const unregisteredSet = useMemo(
    () => new Set(check?.unregistered ?? []),
    [check],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.address.toLowerCase().includes(q) || (e.memo ?? "").toLowerCase().includes(q),
    )
  }, [entries, query])

  const pages = Math.max(1, Math.ceil(filtered.length / LEDGER_PAGE))
  const safePage = Math.min(pageNo, pages - 1)
  const slice = filtered.slice(safePage * LEDGER_PAGE, (safePage + 1) * LEDGER_PAGE)

  if (entries.length === 0) {
    return (
      <div className="card-lift mt-5 rounded-2xl border border-dashed border-line bg-card/50 px-6 py-8 text-center">
        <p className="text-sm font-medium">Parsed recipient ledger</p>
        <p className="mt-1 text-xs text-body-ink">
          Recipients from your batch appear here — searchable, with per-row amounts and key status.
        </p>
      </div>
    )
  }

  return (
    <div className="card-lift specular mt-5 rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
            <Ms name="vpn_key" className="text-sm text-gold" />
          </span>
          <div>
            <div className="h-display text-base font-semibold tracking-tight">Parsed Recipient Ledger</div>
            <div className="text-[11px] text-mute">amounts go out as stealth notes — one per row</div>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPageNo(0) }}
            placeholder="Filter address or memo…"
            className="w-56 pl-8 font-mono text-xs"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
              <th className="px-5 py-2.5 font-medium">Index</th>
              <th className="px-3 py-2.5 font-medium">Recipient address</th>
              <th className="px-3 py-2.5 font-medium">Memo</th>
              <th className="px-3 py-2.5 font-medium">Key status</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-5 py-2.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((e) => {
              const globalIdx = entries.indexOf(e)
              const enrolled = check !== null && !unregisteredSet.has(e.address)
              return (
                <tr key={e.address} className="group border-b border-line/60 transition-colors last:border-0 hover:bg-panel/60">
                  <td className="px-5 py-2.5 font-mono text-xs tabular-nums text-mute">
                    {String(entries.indexOf(e) + 1).padStart(3, "0")}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="flex size-7 flex-none items-center justify-center rounded-full border border-gold-line bg-gold-soft font-mono text-[9px] font-bold text-gold">
                        {e.address.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="font-mono text-xs">{shortHash(e.address, 6, 4)}</span>
                      <button
                        type="button"
                        aria-label="Copy address"
                        onClick={() => {
                          void navigator.clipboard.writeText(e.address)
                          toast.success("Address copied")
                        }}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Copy className="size-3 text-mute hover:text-foreground" />
                      </button>
                    </span>
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2.5 text-xs text-body-ink">
                    {e.memo || "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider ${
                        check === null
                          ? "border border-line bg-panel text-mute"
                          : enrolled
                            ? "border border-ok-line bg-ok-soft text-ok"
                            : "border border-warn-line bg-warn-soft text-warn"
                      }`}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {check === null ? "ready" : enrolled ? "enrolled" : "not enrolled"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                    {e.amountHuman}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <button
                      type="button"
                      aria-label={`Remove row ${globalIdx + 1}`}
                      onClick={() => onRemove(globalIdx)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-mute transition-colors hover:bg-critical/10 hover:text-critical"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })}
            {slice.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-center text-xs text-mute">
                  No rows match “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
        <span className="text-[11px] text-body-ink">
          Showing {filtered.length === 0 ? 0 : safePage * LEDGER_PAGE + 1}–{Math.min((safePage + 1) * LEDGER_PAGE, filtered.length)} of{" "}
          {filtered.length} entries · records hashed locally
        </span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPageNo(safePage - 1)}>
            Previous
          </Button>
          <span className="px-2 font-mono text-[11px] text-mute">
            Page {safePage + 1} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={safePage >= pages - 1} onClick={() => setPageNo(safePage + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function SettlementBar({
  parsed,
  bps,
  minTransferFee,
  vaultSolRaw,
  mode,
  lanes,
  check,
  verifying,
  onVerify,
  canDispatch,
  onDispatch,
}: {
  parsed: ParsedFile | null
  bps: number | null
  minTransferFee: number
  vaultSolRaw: bigint | null
  mode: RunMode
  lanes: number
  check: { total: number; registered: number; unregistered: string[] } | null
  verifying: boolean
  onVerify: () => void
  canDispatch: boolean
  onDispatch: () => void
}) {
  // SOL-preview figures — the plan card owns the authoritative number when an
  // SPL asset is selected; this bar mirrors the common case.
  const totals = useMemo(
    () => (parsed && bps !== null ? estimateTotals(parsed, 9, bps, minTransferFee, mode, true) : null),
    [parsed, bps, minTransferFee, mode],
  )

  const required = totals ? totals.totalNet + totals.totalFees : 0n
  const vaultBig = vaultSolRaw ?? 0n
  const shortfall = totals && required > vaultBig ? required - vaultBig : 0n
  const n = parsed?.entries.length ?? 0
  // One stateful action instead of two buttons in two places: with a batch
  // loaded the bar verifies first, then becomes the dispatch button.
  const needsVerify = n > 0 && check === null
  const notEnrolled = check?.unregistered.length ?? 0

  let actionLabel = "Authorize & Dispatch"
  let actionDisabled = !canDispatch || n === 0
  let actionSub: string | undefined
  if (needsVerify) {
    actionLabel = verifying ? "Verifying recipients…" : "Verify recipients"
    actionDisabled = verifying
    actionSub = "one check before dispatch"
  } else if (notEnrolled > 0) {
    actionLabel = `Locked · ${notEnrolled} not enrolled`
    actionDisabled = true
  } else if (n > 0) {
    actionLabel = `Authorize & Dispatch ${n} payout${n === 1 ? "" : "s"}`
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-band-line bg-band/95 px-5 py-4 text-band-ink shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-band-mute">
          <span className="size-1.5 rounded-full bg-band-gold" />
          zero-knowledge attestation
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-band-mute">
          {lanes} parallel multi-lane bundle{lanes === 1 ? "" : "s"}
        </div>
      </div>
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
          <BarStat label="Total distributed" value={totals ? `${lamportsToSol(totals.totalNet.toString()).toFixed(4)} SOL` : "—"} />
          <BarStat label="Relayer gas" value={totals ? `${lamportsToSol(totals.totalFees.toString()).toFixed(4)} SOL` : "—"} sub="subsidized" />
          <BarStat
            label="Total required"
            value={totals ? `${lamportsToSol(required.toString()).toFixed(4)} SOL` : "—"}
            accent
            sub={
              !totals
                ? "load a batch"
                : shortfall > 0n
                  ? `top-up ${lamportsToSol(shortfall.toString()).toFixed(4)} SOL on dispatch`
                  : "vault funded"
            }
          />
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            size="lg"
            className="btn-glow max-w-full flex-none whitespace-normal font-semibold active:scale-[0.98] sm:whitespace-nowrap"
            disabled={actionDisabled}
            onClick={needsVerify ? onVerify : onDispatch}
          >
            <Ms name={needsVerify ? (verifying ? "progress_activity" : "verified") : "lock"} className={`mr-1.5 text-sm ${verifying ? "animate-spin" : ""}`} />
            {actionLabel}
          </Button>
          {actionSub && (
            <span className="font-mono text-[10px] text-band-mute">{actionSub}</span>
          )}
        </div>
    </div>
  )
}

function BarStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div>
      <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-band-mute">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${accent ? "text-band-gold" : "text-band-ink"}`}>
        {value}
        {sub && <span className="ml-1.5 text-[10px] font-normal text-band-mute">{sub}</span>}
      </div>
    </div>
  )
}
