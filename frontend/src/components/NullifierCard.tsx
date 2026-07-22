import { useState } from "react"
import { CircleCheck, CircleX } from "lucide-react"

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
      setError("expected a 32-byte hex string (64 hex chars, optional 0x)")
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
        <CardTitle>Nullifier check</CardTitle>
        <CardDescription>Has this note already been spent? (queries the indexer's nullifier set)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="nullifier">nullifier hash (hex, 32 bytes)</Label>
          <div className="flex gap-2">
            <Input
              id="nullifier"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="0x…"
              className="font-mono"
            />
            <Button onClick={check} disabled={loading}>
              {loading ? "…" : "Check"}
            </Button>
          </div>
        </div>

        {status && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
            <span className="text-sm">Spent?</span>
            <Badge variant={status.spent ? "destructive" : "success"}>
              {status.spent ? (
                <>
                  <CircleX /> spent
                </>
              ) : (
                <>
                  <CircleCheck /> unspent
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
