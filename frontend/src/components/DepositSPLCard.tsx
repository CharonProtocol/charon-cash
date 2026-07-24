import { useState } from "react"
import { PublicKey } from "@solana/web3.js"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Coins } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { shortHash } from "@/lib/format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

export function DepositSPLCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const { publicKey } = useWallet()
  const [mint, setMint] = useState("")
  const [amount, setAmount] = useState("1000000")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<{ sig: string; nullifiers: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const handleDeposit = async () => {
    if (!client) return
    setBusy(true); setErr(null); setResult(null)
    setStatus("unlocking (approve wallet signature)…")
    try {
      const mintPk = new PublicKey(mint.trim())
      setStatus("generating ZK proof + signing tx…")
      const res = await client.depositSPL(mintPk, Number(amount) || 0)
      setResult({ sig: res.signature, nullifiers: client.lastNullifiers })
      setStatus(null)
      onChanged?.()
      toast.success("SPL deposit landed", { description: shortHash(res.signature, 8, 6) })
    } catch (e) {
      setStatus(null); setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Coins className="size-4" /> Deposit SPL</CardTitle>
        <CardDescription>Client-side: SDK generates the ZK proof, your wallet signs + pays, tx submitted direct to RPC.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning"><AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>Connect a wallet to deposit SPL.</AlertDescription></Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="mint">mint (base58)</Label>
          <Input id="mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Token mint address" className="font-mono text-xs" disabled={!connected || busy} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amt">amount (base units)</Label>
          <Input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" disabled={!connected || busy} />
          <p className="text-xs text-muted-foreground">e.g. 1000000 = 1 token (6 decimals)</p>
        </div>
        <Button onClick={handleDeposit} disabled={!connected || !mint || busy} className="w-full">
          {busy ? status ?? "Working…" : "Deposit SPL"}
        </Button>
        {result && (
          <div className="space-y-2">
            <JsonBlock value={{ signature: result.sig, leaf_index: result.nullifiers.length }} />
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
        {err && <ErrorBlock code="DEPOSIT_SPL_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
