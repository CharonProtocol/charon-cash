import { useState } from "react"
import { toast } from "sonner"
import { Copy, Send } from "lucide-react"

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

export function TransferCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected, publicKey } = usePrivacyCash()
  const [amount, setAmount] = useState("0.01")
  const [recipient, setRecipient] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [myAddr, setMyAddr] = useState<string | null>(null)

  const copyMyAddress = async () => {
    if (!client || !publicKey) return
    try {
      await client.unlock()
      const addr = publicKey.toBase58()
      setMyAddr(addr)
      await navigator.clipboard?.writeText(addr)
      toast.success("Solana address copied")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleTransfer = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking (approve the wallet signature)…")
    try {
      const lamports = Math.round(Number(amount) * 1_000_000_000)
      if (!lamports || lamports <= 0) throw new Error("enter a valid amount")
      const to = recipient.trim()
      if (!to) throw new Error("enter the recipient’s Solana address")
      setStatus("generating ZK proof + wallet signature…")
      const res = await client.transferSOL(lamports, to)
      setResult({
        signature: res.signature,
        recipientLamports: res.recipientLamports,
        feeLamports: res.feeLamports,
        changeLamports: res.changeLamports,
        nullifiers: res.nullifiers,
      })
      setStatus(null)
      onChanged?.()
      client.backupNotes().catch(() => {})
      toast.success("private transfer landed", {
        description: shortHash(res.signature, 8, 6),
      })
    } catch (e) {
      setStatus(null)
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="size-4" /> Transfer SOL
        </CardTitle>
        <CardDescription>
          Spend your private note and insert a note the recipient owns in the
          pool. Paste their Solana wallet address. They must have connected this
          app once. No relayer, no public payout — they withdraw later themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet to transfer. You need a deposited note first.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="xfer-amount">amount (SOL)</Label>
            <Input
              id="xfer-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={!connected || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="xfer-recipient">recipient</Label>
            <Input
              id="xfer-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="recipient Solana address"
              className="font-mono text-xs"
              disabled={!connected || busy}
            />
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={!connected || busy}
          onClick={() => void copyMyAddress()}
        >
          <Copy className="mr-1.5 size-4" />
          Copy my Solana address
        </Button>
        {myAddr && (
          <p className="break-all font-mono text-[11px] text-muted-foreground">{myAddr}</p>
        )}

        <Button
          onClick={handleTransfer}
          disabled={!connected || busy}
          className="w-full"
        >
          {busy ? status ?? "Working…" : "Transfer privately"}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
                sent_sol: lamportsToSol(result.recipientLamports).toFixed(9),
                fee_sol: lamportsToSol(result.feeLamports).toFixed(9),
                change_lamports: result.changeLamports,
                nullifiers: result.nullifiers,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="TRANSFER_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
