import { useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowUpFromLine } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { lamportsToSol, shortHash } from "@/lib/format"
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

  useEffect(() => {
    if (publicKey && !recipient) setRecipient(publicKey.toBase58())
  }, [publicKey, recipient])

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
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking (approve the wallet signature)…")
    try {
      const lamports = Math.round(Number(amount) * 1_000_000_000)
      if (!lamports || lamports <= 0) throw new Error("enter a valid amount")
      setStatus("generating ZK proof + wallet signature…")
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
          the note can be decrypted. Your wallet signs the withdraw.
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

        <Button
          onClick={handleWithdraw}
          disabled={!connected || busy}
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
