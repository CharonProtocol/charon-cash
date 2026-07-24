import { useEffect, useState } from "react"
import { PublicKey } from "@solana/web3.js"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { HandCoins } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { shortHash } from "@/lib/format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

export function WithdrawSPLCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const { publicKey } = useWallet()
  const [mint, setMint] = useState("")
  const [amount, setAmount] = useState("500000")
  const [recipient, setRecipient] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<{ sig: string; recipientGets: number; fee: number; nullifiers: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (publicKey && !recipient) setRecipient(publicKey.toBase58()) }, [publicKey, recipient])

  const handleWithdraw = async () => {
    if (!client) return
    setBusy(true); setErr(null); setResult(null)
    setStatus("unlocking (approve wallet signature)…")
    try {
      const mintPk = new PublicKey(mint.trim())
      setStatus("generating ZK proof + signing tx…")
      const res = await client.withdrawSPL(mintPk, Number(amount) || 0, new PublicKey(recipient))
      setResult({ sig: res.signature, recipientGets: res.recipientLamports, fee: res.feeLamports, nullifiers: client.lastNullifiers })
      setStatus(null)
      onChanged?.()
      toast.success("SPL withdraw landed", { description: shortHash(res.signature, 8, 6) })
    } catch (e) {
      setStatus(null); setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HandCoins className="size-4" /> Withdraw SPL</CardTitle>
        <CardDescription>Spend an SPL note: SDK fetches the Merkle proof, generates the ZK proof, wallet signs + submits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning"><AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>Connect a wallet + deposit SPL first.</AlertDescription></Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="wmint">mint (base58)</Label>
          <Input id="wmint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Token mint address" className="font-mono text-xs" disabled={!connected || busy} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="wamt">amount (base units)</Label>
            <Input id="wamt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" disabled={!connected || busy} />
          </div>
          <div className="space-y-1.5">
            <Label>recipient</Label>
            <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="font-mono text-xs" disabled={!connected || busy} />
          </div>
        </div>
        <Button onClick={handleWithdraw} disabled={!connected || !mint || busy} className="w-full">
          {busy ? status ?? "Working…" : "Withdraw SPL"}
        </Button>
        {result && (
          <div className="space-y-2">
            <JsonBlock value={{ signature: result.sig, recipient_gets: result.recipientGets, fee: result.fee }} />
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Nullifiers (copy to check in the Nullifier card)</p>
              {result.nullifiers.map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <code className="text-[11px] font-mono flex-1 truncate">{n}</code>
                  <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(n); toast.success("nullifier copied") }}>copy</Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {err && <ErrorBlock code="WITHDRAW_SPL_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
