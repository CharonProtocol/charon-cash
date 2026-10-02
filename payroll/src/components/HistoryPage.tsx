import { useMemo, useState } from "react"
import { Ban, Check, Clock, Download, History, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { downloadRun } from "@/lib/history"
import { shortHash } from "@/lib/format"
import { listRuns } from "@/lib/store"
import { explorerTxUrl } from "@/lib/explorer"
import type { RunReceipt } from "@/lib/types"

type RowStatus = "paid" | "failed" | "pending"

function StatusChip({ status }: { status: RowStatus }) {
  if (status === "paid")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        <Check className="size-3" /> Paid
      </span>
    )
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
        <Ban className="size-3" /> Failed
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
      <Clock className="size-3" /> Pending
    </span>
  )
}

function rowStatus(e: RunReceipt["entries"][number]): RowStatus {
  if (e.status === "sent") return "paid"
  if (e.status === "failed") return "failed"
  return "pending"
}

function fmtDur(ms: number): string {
  const s = ms / 1000
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m > 0 ? `${m}m ${r.toString().padStart(2, "0")}s` : `${r}s`
}

function runDuration(r: RunReceipt): number | null {
  return r.startedAt !== undefined && r.finishedAt !== undefined ? r.finishedAt - r.startedAt : null
}

export function HistoryPage({ onResumeFailed }: { onResumeFailed: (r: RunReceipt) => void }) {
  const runs = listRuns()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null

  const totals = useMemo(() => {
    let employees = 0
    for (const r of runs) employees += r.summary.total
    return { runs: runs.length, employees }
  }, [runs])

  if (runs.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <History className="size-8 text-muted-foreground" />
          <div>
            <p className="h-display text-lg">No payments yet</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
              Completed payroll runs land here — who got paid, when, and the on-chain proof.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Runs</div>
          <div className="stat-number text-2xl">{totals.runs}</div>
        </div>
        <div className="rounded-xl border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Payout rows</div>
          <div className="stat-number text-2xl">{totals.employees}</div>
        </div>
        <div className="rounded-xl border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Mode</div>
          <div className="flex items-center gap-1.5 pt-1 text-sm font-medium">
            <span className="size-2 rounded-full bg-emerald-500" /> shielded pool
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${selected?.id === r.id ? "bg-primary/10 font-medium" : "hover:bg-secondary"}`}
              >
                <span className="block">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="mt-0.5 block text-muted-foreground">
                  {r.summary.sent}/{r.summary.total} sent
                  {r.summary.failed > 0 && ` · ${r.summary.failed} failed`}
                  {" · "}
                  {r.mode === "shielded" ? "private" : "public"}
                  {runDuration(r) !== null && ` · ${fmtDur(runDuration(r)!)}`}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        {selected && (
          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">
                  Run {selected.summary.sent}/{selected.summary.total} sent
                </CardTitle>
                <CardDescription>
                  {new Date(selected.createdAt).toLocaleString()} · {selected.asset.kind === "sol" ? "SOL" : "SPL"} · {selected.mode === "shielded" ? "private notes" : "direct"}
                  {runDuration(selected) !== null && ` · full run ${fmtDur(runDuration(selected)!)}`}
                  {selected.fundedAt !== undefined && selected.startedAt !== undefined &&
                    ` · deposit ${fmtDur(selected.fundedAt - selected.startedAt)}`}
                  {(selected.merges ?? 0) > 0 && ` · ${selected.merges} note merges`}
                </CardDescription>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => downloadRun(selected, "csv")}>
                  <Download className="mr-1 size-3" /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={() => downloadRun(selected, "json")}>
                  <Download className="mr-1 size-3" /> JSON
                </Button>
                {selected.summary.failed > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => onResumeFailed(selected)}>
                    Resume ({selected.summary.failed})
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-secondary/60 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">To</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="hidden px-3 py-2 font-medium sm:table-cell">Took</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Proof</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {selected.entries.map((e) => {
                      const st = rowStatus(e)
                      const took = e.startedAt !== undefined && e.confirmedAt !== undefined
                        ? fmtDur(e.confirmedAt - e.startedAt)
                        : null
                      return (
                        <tr key={e.address} className="bg-card">
                          <td className="px-3 py-2 font-medium">{e.memo ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-muted-foreground">{shortHash(e.address, 5, 4)}</td>
                          <td className="px-3 py-2 font-mono">{e.amountHuman}</td>
                          <td className="hidden px-3 py-2 font-mono text-muted-foreground sm:table-cell">{took ?? "—"}</td>
                          <td className="px-3 py-2"><StatusChip status={st} /></td>
                          <td className="px-3 py-2">
                            {e.txSignature ? (
                              <div className="flex flex-col gap-0.5">
                                <a
                                  className="inline-flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
                                  href={explorerTxUrl(e.txSignature)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {shortHash(e.txSignature, 5, 4)}
                                </a>
                                {e.noteLeafIndex !== undefined && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    note @ leaf {e.noteLeafIndex}
                                    {e.noteCommitment && ` · ${shortHash(e.noteCommitment, 5, 4)}`}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-destructive" title={e.error}>{st === "failed" ? "—" : "…"}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {selected.mode === "shielded" && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3" />
                  Amounts here are from your receipts — the chain only ever saw commitments.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
