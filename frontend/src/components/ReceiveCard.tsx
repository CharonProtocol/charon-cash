import { useEffect, useState } from "react"
import { KeyRound, ShieldCheck } from "lucide-react"

import {
  fetchRecipientKeys,
  publishRecipientKeys,
  type RecipientKeys,
} from "privacy-cash-sdk"
import { shortHash } from "@/lib/format"
import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function ReceiveCard() {
  const { signer, connected, publicKey } = usePrivacyCash()
  const [keys, setKeys] = useState<RecipientKeys | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Already enrolled? Show the enabled state without re-publishing.
  useEffect(() => {
    if (!publicKey) return
    let cancelled = false
    setChecked(false)
    setKeys(null)
    setError(null)
    fetchRecipientKeys(publicKey)
      .then((k) => {
        if (cancelled) return
        setKeys(k)
        setChecked(true)
      })
      .catch(() => {
        if (!cancelled) setChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [publicKey])

  const enable = async () => {
    if (!signer) return
    setBusy(true)
    setError(null)
    try {
      setKeys(await publishRecipientKeys(signer))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Private receiving
        </CardTitle>
        <CardDescription>
          Let an employer or another payer send you private notes instead of
          public transfers. Enabling signs three short messages with your
          wallet to publish your receiving keys; you only do it once. Notes you
          receive appear in your vault and spend like any other note.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!connected && (
          <p className="text-sm text-muted-foreground">
            Connect a wallet to manage private receiving.
          </p>
        )}
        {connected && keys && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <ShieldCheck className="size-4 text-primary" /> Private receiving
              enabled
            </span>
            <span
              className="font-mono text-xs text-muted-foreground"
              title={keys.notePubkey}
            >
              note key {shortHash(keys.notePubkey, 8, 6)}
            </span>
          </div>
        )}
        {connected && !keys && (
          <Button onClick={enable} disabled={busy || !signer || !checked}>
            {busy ? "Check your wallet to sign" : "Enable private receiving"}
          </Button>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
