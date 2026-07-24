import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Coins } from "lucide-react"

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
  amountRaw: number
  leafIndex: number
  mint: string
}

const DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export function DepositSplCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const [mint, setMint] = useState(DEFAULT_MINT)
  const [amount, setAmount] = useState("1000000")
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

  const handleDeposit = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking (approve the wallet signature)…")
    try {
      const mintStr = mint.trim()
      const raw = BigInt(amount.trim() || "0")
      if (raw <= 0n) throw new Error("enter a valid raw amount")
      setStatus("generating ZK proof + signing tx…")
      const res = await client.depositSPL(mintStr, raw.toString())
      setResult({
        signature: res.signature,
        amountRaw: res.amountLamports,
        leafIndex: res.leafIndex,
        mint: mintStr,
      })
      setStatus(null)
      onChanged?.()
      toast.success("SPL deposit landed", {
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
          <Coins className="size-4" /> Deposit SPL
        </CardTitle>
        <CardDescription>
          Client-side SPL shield. First SPL tx may ask you to sign 1–2 extra
          wallet approvals to create/extend an Address Lookup Table (required
          so the proof fits in a Solana transaction). Amount is in the
          token&apos;s smallest units (e.g. 1 USDC = 1_000_000).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet that supports <code>signMessage</code> +{" "}
              <code>signTransaction</code> to deposit SPL.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="spl-dep-mint">mint (base58)</Label>
          <Input
            id="spl-dep-mint"
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

        <div className="space-y-1.5">
          <Label htmlFor="spl-dep-amount">amount (raw units)</Label>
          <Input
            id="spl-dep-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            className="font-mono"
            disabled={!connected || busy}
          />
        </div>

        <Button
          onClick={handleDeposit}
          disabled={!connected || busy}
          className="w-full"
        >
          {busy ? status ?? "Working…" : "Deposit SPL"}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
                mint: result.mint,
                amount_raw: result.amountRaw,
                leaf_index: result.leafIndex,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="DEPOSIT_SPL_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
