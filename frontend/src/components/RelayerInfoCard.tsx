import { type ReactNode, useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"

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

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
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
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </CardTitle>
        <CardDescription>Program id, fee recipient and configured fee rates.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBlock code="LOAD_FAILED" message={error} />}
        {info && (
          <div className="divide-y">
            <Row label="program id" value={shortHash(info.program_id, 10, 8)} />
            <Row label="fee recipient" value={shortHash(info.fee_recipient, 10, 8)} />
            <Row label="relayer fee rate" value={`${info.fee_rate_bps} bps (${bpsToPercent(info.fee_rate_bps)})`} />
            <Row label="withdrawal fee rate" value={`${info.withdrawal_fee_rate_bps} bps (${bpsToPercent(info.withdrawal_fee_rate_bps)})`} />
            <Row label="fee error margin" value={`${info.fee_error_margin_bps} bps`} />
          </div>
        )}
        {info && info.supported_mints.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Supported SPL mints</p>
            <div className="space-y-1">
              {info.supported_mints.map((m) => (
                <div key={m.mint} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                  <Badge variant="outline">{shortHash(m.mint, 6, 4)}</Badge>
                  <span className="font-mono text-muted-foreground">fee ata {shortHash(m.fee_ata, 6, 4)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
