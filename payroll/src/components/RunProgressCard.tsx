import { Ban, Check, CircleDashed, ExternalLink, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunSnapshot } from "@/lib/engine"
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

export function RunProgressCard({
  snapshot,
  receipt,
  onCancel,
  onDone,
  onResumeFailed,
}: {
  snapshot: RunSnapshot | null
  receipt: RunReceipt | null
  onCancel: () => void
  onDone: () => void
  onResumeFailed: () => void
}) {
  if (!snapshot && !receipt) return null
  const rows = snapshot?.rows ?? receipt?.entries ?? []
  const done = receipt !== null
  const sent = rows.filter((r) => r.status === "confirmed" || r.status === "sent").length
  const pct = rows.length ? Math.round((sent / rows.length) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{done ? `Run ${receipt!.summary.sent}/${receipt!.summary.total} sent` : `Paying… ${sent}/${rows.length}`}</span>
          <span className="stat-number text-lg text-primary">{pct}%</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full transition-all duration-500 ${done && pct === 100 ? "bg-primary" : "progress-glow"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
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
          {!done && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
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
        </div>
      </CardContent>
    </Card>
  )
}
