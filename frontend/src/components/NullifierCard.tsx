import { useState } from "react"
import { CircleCheck, CircleX, RefreshCw, Shield } from "lucide-react"

import { api, BackendError } from "@/lib/api"
import { isValidHex32 } from "@/lib/format"
import type { NullifierStatus } from "@/lib/types"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"

export function NullifierCard() {
  const [hash, setHash] = useState("")
  const [status, setStatus] = useState<NullifierStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const check = async () => {
    setLoading(true)
    setError(null)
    setStatus(null)
    if (!isValidHex32(hash)) {
      setError("Expected a 32-byte hex string (64 hex chars, optional 0x)")
      setLoading(false)
      return
    }
    try {
      setStatus(await api.nullifier(hash.trim()))
    } catch (e) {
      setError(e instanceof BackendError ? `${e.code}: ${e.message}` : (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-4" /> Nullifier check
        </CardTitle>
        <CardDescription>
          Ask whether a note&apos;s nullifier was already published on-chain (spent).
          Relayer withdraws create these PDAs before paying the recipient.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="nullifier">Nullifier hash (hex, 32 bytes)</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="nullifier"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="0x…"
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") void check()
              }}
            />
            <Button onClick={check} disabled={loading} className="shrink-0">
              {loading ? (
                <>
                  <RefreshCw className="mr-1.5 size-3.5 animate-spin" /> Checking
                </>
              ) : (
                "Check"
              )}
            </Button>
          </div>
        </div>

        {status && (
          <div
            className={`flex items-center justify-between rounded-xl border p-4 ${
              status.spent
                ? "border-destructive/30 bg-destructive/5"
                : "border-border bg-secondary/40"
            }`}
          >
            <div>
              <p className="text-sm font-medium text-foreground">
                {status.spent ? "Already spent" : "Still available"}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
                {hash.trim()}
              </p>
            </div>
            <Badge variant={status.spent ? "destructive" : "outline"} className="shrink-0">
              {status.spent ? (
                <>
                  <CircleX className="size-3" /> spent
                </>
              ) : (
                <>
                  <CircleCheck className="size-3" /> unspent
                </>
              )}
            </Badge>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
