import { Ban, CheckCircle2, CircleDashed, ExternalLink, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunSnapshot } from "@/lib/engine"
import { shortHash } from "@/lib/format"
import type { EntryStatus, RunReceipt } from "@/lib/types"

const STATUS_LABEL: Record<EntryStatus, string> = {
  queued: "queued",
  proving: "proving",
  relayed: "relayed",
  confirmed: "confirmed",
  confirming: "confirming",
  failed: "failed",
}

/** Receipt rows store "sent"; display uses the engine vocabulary. */
function displayStatus(s: string): EntryStatus {
  return s === "sent" ? "confirmed" : (s as EntryStatus)
}

function Row({ status, address, memo, sig, error }: {
  status: EntryStatus
  address: string
  memo?: string
  sig?: string
  error?: string
}) {
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5">
        {status === "confirmed" ? <CheckCircle2 className="size-4 text-green-600" />
          : status === "failed" ? <Ban className="size-4 text-destructive" />
          : status === "queued" ? <CircleDashed className="size-4 text-muted-foreground" />
          : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </td>
      <td className="px-3 py-1.5 font-mono">{shortHash(address, 6, 4)}</td>
      <td className="px-3 py-1.5 text-muted-foreground">{memo ?? ""}</td>
      <td className="px-3 py-1.5">
        <Badge variant={status === "failed" ? "destructive" : status === "confirmed" ? "default" : "secondary"}>
          {STATUS_LABEL[status]}
        </Badge>
      </td>
      <td className="px-3 py-1.5 text-right">
        {sig && (
          <a
            className="inline-flex items-center gap-1 font-mono text-xs underline"
            href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            {shortHash(sig, 6, 4)} <ExternalLink className="size-3" />
          </a>
        )}
        {error && <span className="ml-2 text-xs text-destructive" title={error}>{shortHash(error, 12, 8)}</span>}
      </td>
    </tr>
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
        <CardTitle>
          {done ? `Run ${receipt!.summary.sent}/${receipt!.summary.total} sent` : `Paying… ${sent}/${rows.length}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.address}
                status={displayStatus(r.status)}
                address={r.address}
                memo={r.memo}
                sig={r.txSignature}
                error={r.error}
              />
            ))}
          </tbody>
        </table>
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
