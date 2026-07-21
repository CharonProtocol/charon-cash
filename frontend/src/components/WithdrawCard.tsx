import { useEffect, useState } from "react"
import { PublicKey } from "@solana/web3.js"
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

  useEffect(() => {
    if (publicKey && !recipient) setRecipient(publicKey.toBase58())
  }, [publicKey, recipient])

  const handleWithdraw = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking (approve the wallet signature)…")
    try {
      const lamports = Math.round(Number(amount) * 1_000_000_000)
      if (!lamports || lamports <= 0) throw new Error("enter a valid amount")
      setStatus("generating ZK proof + signing tx…")
      const res = await client.withdrawSOL(lamports, new PublicKey(recipient))
      setResult({
        signature: res.signature,
        recipientLamports: res.recipientLamports,
        feeLamports: res.feeLamports,
        changeLamports: res.changeLamports,
      })
      setStatus(null)
      onChanged?.()
      toast.success("withdraw landed", {
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
          <ArrowUpFromLine className="size-4" /> Withdraw
        </CardTitle>
        <CardDescription>
          Spend a local note: SDK fetches the Merkle proof, generates the ZK
          proof, your wallet signs + submits. The pool pays the recipient and
          the fee — no relayer involved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet to withdraw. You need a deposited note first.
            </AlertDescription>
          </Alert>
        )}

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
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="WITHDRAW_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
