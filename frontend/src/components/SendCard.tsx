import { useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Send } from "lucide-react"

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

export function SendCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const { publicKey } = useWallet()
  const [amount, setAmount] = useState("0.01")
  const [recipient, setRecipient] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const handleSend = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("1/2 depositing (approve the wallet signature + deposit tx)…")
    try {
      const lamports = Math.round(Number(amount) * 1_000_000_000)
      if (!lamports || lamports <= 0) throw new Error("enter a valid amount")
      const to = recipient.trim()
      if (!to) throw new Error("enter a recipient address")
      if (publicKey && to === publicKey.toBase58()) {
        throw new Error("recipient is your own address — use Withdraw instead")
      }
      setStatus("2/2 deposited — relayer is sending to the recipient (gasless)…")
      const res = await client.sendPrivateSOL(lamports, to)
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
      toast.success("private send landed", {
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
          <Send className="size-4" /> Send SOL (private)
        </CardTitle>
        <CardDescription>
          One action, two steps under the hood: your wallet deposits, then the
          relayer withdraws to the recipient (gasless, <span className="font-mono">relay=true</span>).
          Your deposit is unlinkable to the recipient via ZK; the recipient
          receives public SOL at their address (amount − fee).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>Connect a wallet to send.</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="send-amount">amount (SOL)</Label>
            <Input
              id="send-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={!connected || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="send-recipient">recipient</Label>
            <Input
              id="send-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="recipient SOL address"
              className="font-mono text-xs"
              disabled={!connected || busy}
            />
          </div>
        </div>

        <Button onClick={handleSend} disabled={!connected || busy} className="w-full">
          {busy ? status ?? "Working…" : "Send SOL"}
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
        {err && <ErrorBlock code="SEND_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
