import { useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Send } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { api } from "@/lib/api"
import { shortHash } from "@/lib/format"
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
  recipientRaw: number
  feeRaw: number
  changeRaw: string
  mint: string
  nullifiers?: string[]
}

const DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export function SendSplCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const { publicKey } = useWallet()
  const [mint, setMint] = useState(DEFAULT_MINT)
  const [amount, setAmount] = useState("500000")
  const [recipient, setRecipient] = useState("")
  const [supported, setSupported] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api
      .relayerInfo()
      .then((info) => {
        const mints = info.supported_mints.map((m) => m.mint)
        setSupported(mints)
        if (mints.length > 0 && mint === DEFAULT_MINT && !mints.includes(DEFAULT_MINT)) {
          setMint(mints[0])
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSend = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("1/2 depositing (approve the wallet signature + deposit tx)…")
    try {
      const mintStr = mint.trim()
      const raw = BigInt(amount.trim() || "0")
      if (raw <= 0n) throw new Error("enter a valid raw amount")
      const to = recipient.trim()
      if (!to) throw new Error("enter a recipient address")
      if (publicKey && to === publicKey.toBase58()) {
        throw new Error("recipient is your own address — use Withdraw instead")
      }
      setStatus("2/2 deposited — relayer is sending to the recipient (gasless)…")
      const res = await client.sendPrivateSPL(mintStr, raw.toString(), to)
      setResult({
        signature: res.signature,
        recipientRaw: res.recipientLamports,
        feeRaw: res.feeLamports,
        changeRaw: res.changeLamports,
        mint: mintStr,
        nullifiers: res.nullifiers,
      })
      setStatus(null)
      onChanged?.()
      client.backupNotes().catch(() => {})
      toast.success("private SPL send landed", {
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
          <Send className="size-4" /> Send SPL (private)
        </CardTitle>
        <CardDescription>
          Your wallet deposits the SPL tokens, then the relayer withdraws to the
          recipient (gasless). Recipient ATA is created idempotently and funded
          (amount − fee); your deposit is unlinkable via ZK.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>Connect a wallet to send.</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="spl-send-mint">mint (base58)</Label>
          <Input
            id="spl-send-mint"
            value={mint}
            onChange={(e) => setMint(e.target.value)}
            className="font-mono text-xs"
            disabled={!connected || busy}
          />
          {supported.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {supported.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={m === mint.trim() ? "default" : "outline"}
                  size="sm"
                  className="h-6 px-2 font-mono text-[10px]"
                  disabled={!connected || busy}
                  onClick={() => setMint(m)}
                >
                  {shortHash(m, 4, 4)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="spl-send-amount">amount (raw)</Label>
            <Input
              id="spl-send-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              className="font-mono"
              disabled={!connected || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spl-send-recipient">recipient</Label>
            <Input
              id="spl-send-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="recipient wallet address"
              className="font-mono text-xs"
              disabled={!connected || busy}
            />
          </div>
        </div>

        <Button onClick={handleSend} disabled={!connected || busy} className="w-full">
          {busy ? status ?? "Working…" : "Send SPL"}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
                mint: result.mint,
                recipient_raw: result.recipientRaw,
                fee_raw: result.feeRaw,
                change_raw: result.changeRaw,
                nullifiers: result.nullifiers,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="SEND_SPL_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
