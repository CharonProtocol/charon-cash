import { type ReactNode, useCallback, useEffect, useState } from "react"
import { Check, Copy, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api, BackendError } from "@/lib/api"
import { bpsToPercent, shortHash } from "@/lib/format"
import type { RelayerInfo } from "@/lib/types"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ErrorBlock } from "@/components/ResponsePanel"

function Copyable({
  label,
  full,
  display,
}: {
  label: string
  full: string
  display?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate text-right font-mono text-xs" title={full}>
          {display ?? full}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="Copy"
          onClick={async () => {
            try {
              await navigator.clipboard?.writeText(full)
              setDone(true)
              toast.success("Copied")
              setTimeout(() => setDone(false), 1200)
            } catch {
              toast.error("Copy failed")
            }
          }}
        >
          {done ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-xs break-all">{value}</span>
    </div>
  )
}

export function RelayerInfoCard({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<RelayerInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInfo(await api.relayerInfo())
    } catch (e) {
      setError(e instanceof BackendError ? `${e.code}: ${e.message}` : (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Pool &amp; fee info
          <Button variant="ghost" size="icon" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
        <CardDescription>
          Program id, fee recipient, and rates. Only v1 swaps are relayer-signed
          (Phantom cannot sign v1). Deposits, transfers, and withdraws are wallet-signed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBlock code="LOAD_FAILED" message={error} />}
        {info && (
          <div className="divide-y divide-border rounded-xl border border-border bg-secondary/40 px-3">
            <Copyable
              label="program id"
              full={info.program_id}
              display={shortHash(info.program_id, 10, 8)}
            />
            <Copyable
              label="fee recipient"
              full={info.fee_recipient}
              display={shortHash(info.fee_recipient, 10, 8)}
            />
            <Row
              label="relayer fee rate"
              value={`${info.fee_rate_bps} bps (${bpsToPercent(info.fee_rate_bps)})`}
            />
            <Row
              label="withdrawal fee rate"
              value={`${info.withdrawal_fee_rate_bps} bps (${bpsToPercent(info.withdrawal_fee_rate_bps)})`}
            />
            <Row label="fee error margin" value={`${info.fee_error_margin_bps} bps`} />
          </div>
        )}
        {info && info.supported_mints.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Supported SPL mints</p>
            <div className="space-y-1">
              {info.supported_mints.map((m) => (
                <div
                  key={m.mint}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs"
                >
                  <button
                    type="button"
                    className="hover:text-primary"
                    title={m.mint}
                    onClick={() => {
                      navigator.clipboard?.writeText(m.mint)
                      toast.success("Mint copied")
                    }}
                  >
                    <Badge variant="outline">{shortHash(m.mint, 6, 4)}</Badge>
                  </button>
                  <button
                    type="button"
                    className="font-mono text-muted-foreground hover:text-primary"
                    title={m.fee_ata}
                    onClick={() => {
                      navigator.clipboard?.writeText(m.fee_ata)
                      toast.success("Fee ATA copied")
                    }}
                  >
                    fee ata {shortHash(m.fee_ata, 6, 4)}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {!info && !error && loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" /> Loading pool info…
          </p>
        )}
      </CardContent>
    </Card>
  )
}
