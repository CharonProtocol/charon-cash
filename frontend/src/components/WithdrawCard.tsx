import { useEffect, useMemo, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowUpFromLine } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { lamportsToSol, shortHash, solToLamports } from "@/lib/format"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

interface Result {
  signature: string
  recipientLamports: number
  feeLamports: number
  changeLamports: string
  nullifiers?: string[]
}

function formatSol(lamports: number): string {
  return lamportsToSol(lamports).toFixed(6)
}

export function WithdrawCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const { publicKey } = useWallet()
  const [amount, setAmount] = useState("0.01")
  const [recipient, setRecipient] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [privateSol, setPrivateSol] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [selfRelay, setSelfRelay] = useState(false)

  useEffect(() => {
    if (publicKey && !recipient) setRecipient(publicKey.toBase58())
  }, [publicKey, recipient])

  useEffect(() => {
    if (!client) {
      setReady(false)
      return
    }
    let cancelled = false
    client
      .init()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    client?.setSelfRelay(selfRelay)
  }, [client, selfRelay])

  const lamports = useMemo(() => {
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) return 0
    return solToLamports(n)
  }, [amount])

  const quote = useMemo(() => {
    if (!client || !ready || lamports <= 0) return null
    return client.quoteWithdraw(lamports)
  }, [client, ready, lamports, selfRelay])

  const belowMin = quote != null && lamports < quote.minLamports
  const canSubmit =
    connected && !busy && lamports > 0 && !!recipient.trim() && !belowMin

  const readBalance = () => {
    if (!client) return
    setPrivateSol((Number(client.getPrivateBalanceSOL()) / 1e9).toFixed(6))
  }

  const handleScan = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setStatus("unlocking + scanning notes…")
    try {
      await client.refreshNotes()
      readBalance()
      toast.success("notes scanned")
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setStatus(null)
      setBusy(false)
    }
  }

  const handleWithdraw = async () => {
    if (!client || !canSubmit) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking (approve the wallet signature)…")
    try {
      setStatus(
        selfRelay
          ? "generating ZK proof + wallet signature…"
          : "generating ZK proof, then the relayer signs…",
      )
      const res = await client.withdrawSOL(lamports, recipient.trim())
      setResult({
        signature: res.signature,
        recipientLamports: res.recipientLamports,
        feeLamports: res.feeLamports,
        changeLamports: res.changeLamports,
        nullifiers: res.nullifiers,
      })
      setStatus(null)
      readBalance()
      onChanged?.()
      client.backupNotes().catch(() => {})
      toast.success("withdraw landed", {
        description: shortHash(res.signature, 8, 6),
      })
    } catch (e) {
      setStatus(null)
      setErr((e as Error).message)
      try {
        readBalance()
      } catch {
        /* client may still be locked */
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowUpFromLine className="size-4" /> Withdraw SOL
        </CardTitle>
        <CardDescription>
          Unshield SOL from a private note to a public address. Use the same
          wallet that received the private transfer, then approve sign-in so
          the note can be decrypted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect the wallet that received the private transfer (or that
              deposited), then withdraw.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            private balance{" "}
            <span className="font-mono text-foreground">
              {privateSol == null ? "—" : `${privateSol} SOL`}
            </span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={!connected || busy}
            onClick={handleScan}
          >
            Scan notes
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="amount">amount (SOL)</Label>
            <Input
              id="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={!connected || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label>recipient</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="font-mono text-xs"
              disabled={!connected || busy}
            />
          </div>
        </div>

        {quote && (
          <div className="space-y-1 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs">
            <div className="flex justify-between text-muted-foreground">
              <span>fee</span>
              <span className="font-mono text-foreground">
                {formatSol(quote.feeLamports)} SOL
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">you receive</span>
              <span className="font-mono font-medium text-foreground">
                {belowMin ? "—" : `${formatSol(quote.recipientLamports)} SOL`}
              </span>
            </div>
            {belowMin && (
              <p className="pt-1 text-destructive">
                minimum {formatSol(quote.minLamports)} SOL
              </p>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selfRelay}
            onChange={(e) => setSelfRelay(e.target.checked)}
            disabled={!connected || busy}
          />
          Sign with your own wallet
        </label>

        <Button
          onClick={handleWithdraw}
          disabled={!canSubmit}
          className="w-full"
        >
          {busy ? status ?? "Working…" : "Withdraw SOL"}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
                recipient_sol: lamportsToSol(result.recipientLamports).toFixed(9),
                fee_sol: lamportsToSol(result.feeLamports).toFixed(9),
                change_lamports: result.changeLamports,
                nullifiers: result.nullifiers,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="WITHDRAW_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
