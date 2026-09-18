import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Copy, Send } from "lucide-react"

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

export function TransferSplCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected, publicKey } = usePrivacyCash()
  const [mint, setMint] = useState(DEFAULT_MINT)
  const [amount, setAmount] = useState("500000")
  const [recipient, setRecipient] = useState("")
  const [supported, setSupported] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [myAddr, setMyAddr] = useState<string | null>(null)

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
      const mintStr = mint.trim()
      const raw = BigInt(amount.trim() || "0")
      if (raw <= 0n) throw new Error("enter a valid raw amount")
      const to = recipient.trim()
      if (!to) throw new Error("enter the recipient’s Solana address")
      setStatus("generating ZK proof + wallet signature…")
      const res = await client.transferSPL(mintStr, raw.toString(), to)
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
      toast.success("private SPL transfer landed", {
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
          <Send className="size-4" /> Transfer SPL
        </CardTitle>
        <CardDescription>
          Spend a private SPL note and insert a note the recipient owns in that
          mint’s pool. Paste their Solana wallet address — they must have
          connected this app once. No relayer and no ATA payout — they withdraw
          later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet to transfer. You need a deposited SPL note for this
              mint first.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="spl-xfer-mint">mint (base58)</Label>
          <Input
            id="spl-xfer-mint"
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
            <Label htmlFor="spl-xfer-amount">amount (raw)</Label>
            <Input
              id="spl-xfer-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              className="font-mono"
              disabled={!connected || busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spl-xfer-recipient">recipient</Label>
            <Input
              id="spl-xfer-recipient"
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
                mint: result.mint,
                sent_raw: result.recipientRaw,
                fee_raw: result.feeRaw,
                change_raw: result.changeRaw,
                nullifiers: result.nullifiers,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="TRANSFER_SPL_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
