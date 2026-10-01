import { useState } from "react"
import { Download, History } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { downloadRun } from "@/lib/history"
import { shortHash } from "@/lib/format"
import { listRuns } from "@/lib/store"
import { explorerTxUrl } from "@/lib/explorer"
import type { RunReceipt } from "@/lib/types"

export function HistoryCard({ onResumeFailed }: { onResumeFailed: (r: RunReceipt) => void }) {
  // Read on every render: this card mounts before the first run exists, and a
  // mount-time snapshot would keep it hidden forever (its own Refresh button
  // included). localStorage reads are cheap; the parent re-renders constantly
  // during a run.
  const runs = listRuns()
  const [openId, setOpenId] = useState<string | null>(null)

  if (runs.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" /> Past runs
        </CardTitle>
        <CardDescription>Receipts live in this browser only; on-chain signatures are the source of truth.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.map((r) => (
          <div key={r.id} className="rounded-lg border">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
              onClick={() => setOpenId(openId === r.id ? null : r.id)}
            >
              <span className="font-mono text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()} · file {shortHash(r.fileHash, 6, 4)}
              </span>
              <span>
                {r.asset.kind === "sol" ? "SOL" : "SPL"}
                {r.mode === "shielded" && " · private"} · {r.summary.sent}/{r.summary.total} sent
                {r.summary.failed > 0 && ` · ${r.summary.failed} failed`}
              </span>
            </button>
            {openId === r.id && (
              <div className="space-y-2 border-t px-3 py-2">
                {r.entries.map((e) => (
                  <div key={e.address} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono">{shortHash(e.address, 6, 4)} · {e.amountHuman}</span>
                    <span className="inline-flex items-center gap-2">
                      {e.noteLeafIndex !== undefined && (
                        <span className="font-mono text-muted-foreground">note @ leaf {e.noteLeafIndex}</span>
                      )}
                      {e.txSignature ? (
                        <a
                          className="font-mono underline"
                          href={explorerTxUrl(e.txSignature)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortHash(e.txSignature, 6, 4)}
                        </a>
                      ) : (
                        <span className="text-destructive">{e.error ?? e.status}</span>
                      )}
                    </span>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => downloadRun(r, "csv")}>
                    <Download className="mr-1 size-3" /> CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadRun(r, "json")}>
                    <Download className="mr-1 size-3" /> JSON
                  </Button>
                  {r.summary.failed > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => onResumeFailed(r)}>
                      Resume failed
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
