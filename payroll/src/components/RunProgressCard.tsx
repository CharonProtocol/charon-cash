import { useEffect, useRef, useState } from "react"
import { Ban, Check, CircleCheck, CircleDashed, ExternalLink, Loader2, OctagonAlert, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunSnapshot } from "@/lib/engine"
import { browserProverInfo } from "@/lib/browserProver"
import { shortHash } from "@/lib/format"
import type { EntryStatus, RunReceipt } from "@/lib/types"
import { explorerTxUrl } from "@/lib/explorer"

/** Receipt rows store "sent"; display uses the engine vocabulary. */
function displayStatus(s: string): EntryStatus {
  return s === "sent" ? "confirmed" : (s as EntryStatus)
}

const STATUS_TEXT: Record<EntryStatus, string> = {
  queued: "queued",
  proving: "proving",
  relayed: "relayed",
  confirmed: "confirmed",
  confirming: "confirming",
  failed: "failed",
}

function StatusChip({ status }: { status: EntryStatus }) {
  const label = STATUS_TEXT[status]
  if (status === "confirmed")
    return (
      <span className="inline-flex flex-none items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        <Check className="size-3" /> {label}
      </span>
    )
  if (status === "failed")
    return (
      <span className="inline-flex flex-none items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
        <Ban className="size-3" /> {label}
      </span>
    )
  if (status === "queued")
    return (
      <span className="inline-flex flex-none items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <CircleDashed className="size-3" /> {label}
      </span>
    )
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Loader2 className="size-3 animate-spin" /> {label}
    </span>
  )
}

function initials(memo: string | undefined, address: string) {
  const fromMemo = memo
    ? memo
        .split(/[\s-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : ""
  return fromMemo || shortHash(address, 2, 0).toUpperCase()
}

function Row({ status, address, memo, sig, error, noteLeafIndex }: {
  status: EntryStatus
  address: string
  memo?: string
  sig?: string
  error?: string
  noteLeafIndex?: number
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-secondary/70 px-3 py-2.5">
      <span className="flex size-7 flex-none items-center justify-center rounded-full bg-card text-[11px] font-semibold text-muted-foreground">
        {initials(memo, address)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {memo ? memo : shortHash(address, 6, 4)}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {shortHash(address, 6, 4)}
          {noteLeafIndex !== undefined && ` · note @ leaf ${noteLeafIndex}`}
        </span>
      </span>
      <span className="hidden flex-none items-center sm:inline-flex">
        {sig && (
          <a
            className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            href={explorerTxUrl(sig)}
            target="_blank"
            rel="noreferrer"
          >
            {shortHash(sig, 6, 4)} <ExternalLink className="size-3" />
          </a>
        )}
        {error && (
          <span className="font-mono text-[11px] text-destructive" title={error}>
            {shortHash(error, 12, 8)}
          </span>
        )}
      </span>
      <StatusChip status={status} />
    </div>
  )
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m > 0 ? `${m}m ${r.toString().padStart(2, "0")}s` : `${r}s`
}

/** Live wait experience while a run is in flight: elapsed, rate, ETA and the
 * local prover pool's throughput, ticking once a second. */
function LiveStats({ sent, total, failed }: { sent: number; total: number; failed: number }) {
  const [, setTick] = useState(0)
  const startedAt = useRef<number | null>(null)
  useEffect(() => {
    if (startedAt.current === null) startedAt.current = performance.now()
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = (performance.now() - startedAt.current!) / 1000
  const rate = elapsed > 2 ? sent / elapsed : 0
  const eta = rate > 0 ? (total - sent) / rate : null
  const prover = browserProverInfo()

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="elapsed" value={fmtTime(elapsed)} />
      <Stat label="rate" value={rate > 0 ? `${(rate * 60).toFixed(1)}/min` : "—"} />
      <Stat label="eta" value={eta !== null ? fmtTime(eta) : "—"} />
      <Stat
        label="prover"
        value={prover ? `${prover.workers}w · ${prover.avgMs ? (prover.avgMs / 1000).toFixed(1) + "s" : "warming"}` : "snarkjs"}
        pulse={prover?.proves === 0}
      />
      {failed > 0 && (
        <div className="col-span-2 rounded-lg bg-rose-500/10 px-3 py-1.5 text-[11px] font-medium text-rose-600 dark:text-rose-400 sm:col-span-4">
          {failed} failed so far — the run keeps going; retry just those at the end
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, pulse }: { label: string; value: string; pulse?: boolean }) {
  return (
    <div className="rounded-lg bg-secondary/70 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1.5 font-mono text-xs font-medium">
        {pulse && <Loader2 className="size-3 animate-spin text-primary" />}
        {value}
      </div>
    </div>
  )
}

function CountChips({ rows }: { rows: Array<{ status: string }> }) {
  const count = (m: (s: string) => boolean) => rows.filter((r) => m(r.status)).length
  const chips: Array<[number, string, string]> = [
    [count((s) => s === "confirmed" || s === "sent"), "confirmed", "text-emerald-600 dark:text-emerald-400"],
    [count((s) => s === "proving" || s === "relayed" || s === "confirming"), "in flight", "text-primary"],
    [count((s) => s === "queued"), "queued", "text-muted-foreground"],
    [count((s) => s === "failed"), "failed", "text-rose-600 dark:text-rose-400"],
  ]
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map(([n, label, cls]) => (
        <span
          key={label}
          className={`inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium ${n > 0 ? cls : "text-muted-foreground/50"}`}
        >
          {label === "confirmed" && <CircleCheck className="size-3" />}
          {label === "failed" && <OctagonAlert className="size-3" />}
          {n} {label}
        </span>
      ))}
    </div>
  )
}

export function RunProgressCard({
  snapshot,
  receipt,
  onCancel,
  onDone,
  onResumeFailed,
  onResumeSnapshot,
}: {
  snapshot: RunSnapshot | null
  receipt: RunReceipt | null
  onCancel: () => void
  onDone: () => void
  onResumeFailed: () => void
  onResumeSnapshot: () => void
}) {
  if (!snapshot && !receipt) return null
  const rows = snapshot?.rows ?? receipt?.entries ?? []
  const done = receipt !== null
  const aborted = !done && snapshot?.phase === "aborted"
  const sent = rows.filter((r) => r.status === "confirmed" || r.status === "sent").length
  const failed = rows.filter((r) => r.status === "failed").length
  const pct = rows.length ? Math.round((sent / rows.length) * 100) : 0
  const running = !done && !aborted

  const title = done
    ? `Run ${receipt!.summary.sent}/${receipt!.summary.total} sent`
    : aborted
      ? `Stopped at ${sent}/${rows.length}`
      : `Paying… ${sent}/${rows.length}`

  return (
    <Card className={aborted ? "border-destructive/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            {running && <Loader2 className="size-4 animate-spin text-primary" />}
            {title}
          </span>
          <span className="stat-number text-lg text-primary">{pct}%</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full transition-all duration-500 ${aborted ? "bg-destructive/70" : done && pct === 100 ? "bg-primary" : "progress-glow"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {running && <LiveStats sent={sent} total={rows.length} failed={failed} />}
        <CountChips rows={rows} />
        {aborted && (
          <div className="flex items-start gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
            <Square className="mt-0.5 size-3 flex-none" />
            Run stopped — everything already sent stays sent. Retry only the rows that didn't make it.
          </div>
        )}
        {done && receipt!.summary.failed > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <OctagonAlert className="mt-0.5 size-3 flex-none" />
            {receipt!.summary.failed} payout(s) failed — Resume retries just those, nothing double-pays.
          </div>
        )}
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {rows.map((r) => (
            <Row
              key={r.address}
              status={displayStatus(r.status)}
              address={r.address}
              memo={r.memo}
              sig={r.txSignature}
              error={r.error}
              noteLeafIndex={r.noteLeafIndex}
            />
          ))}
        </div>
        <div className="flex gap-2">
          {running && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
          {done && (
            <>
              <Button onClick={onDone}>New run</Button>
              {receipt!.summary.failed > 0 && (
                <Button variant="outline" onClick={onResumeFailed}>
                  Resume failed ({receipt!.summary.failed})
                </Button>
              )}
            </>
          )}
          {aborted && (
            <>
              {failed > 0 && (
                <Button onClick={onResumeSnapshot}>Retry failed ({failed})</Button>
              )}
              <Button variant="outline" onClick={onDone}>Dismiss</Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
