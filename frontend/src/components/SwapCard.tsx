import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ArrowDownUp, ArrowLeftRight } from "lucide-react"

import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import { api } from "@/lib/api"
import { shortHash } from "@/lib/format"
import { WRAPPED_SOL_MINT } from "privacy-cash-sdk"
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

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

const DECIMALS: Record<string, number> = {
  [WRAPPED_SOL_MINT]: 9,
  [USDC]: 6,
}

interface Result {
  signature: string
  amountIn: string
  minAmountOut: string
  fromMint: string
  outMint: string
  nullifiers?: string[]
}

function decimalsFor(mint: string): number {
  return DECIMALS[mint] ?? 0
}

function labelFor(mint: string): string {
  if (mint === WRAPPED_SOL_MINT) return "SOL"
  if (mint === USDC) return "USDC"
  return shortHash(mint, 4, 4)
}

function toRaw(amount: string, decimals: number): bigint {
  const t = amount.trim()
  if (!t) throw new Error("enter a valid amount")
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("enter a valid amount")
  const [w, f = ""] = t.split(".")
  if (f.length > decimals) throw new Error(`max ${decimals} decimal places`)
  const frac = (f + "0".repeat(decimals)).slice(0, decimals)
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0")
}

function fromRaw(raw: string, decimals: number): string {
  if (decimals === 0) return raw
  const n = BigInt(raw || "0")
  const d = 10n ** BigInt(decimals)
  const w = n / d
  const f = (n % d).toString().padStart(decimals, "0").replace(/0+$/, "")
  return f ? `${w}.${f}` : w.toString()
}

export function SwapCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash()
  const [solToSpl, setSolToSpl] = useState(true)
  const [mint, setMint] = useState(USDC)
  const [supported, setSupported] = useState<string[]>([])
  const [amount, setAmount] = useState("0.01")
  const [slippageBps, setSlippageBps] = useState("100")
  const [quote, setQuote] = useState<{ minOut: string; outAmount: string } | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [solBal, setSolBal] = useState("0")
  const [splBal, setSplBal] = useState("0")

  const fromMint = solToSpl ? WRAPPED_SOL_MINT : mint
  const outMint = solToSpl ? mint : WRAPPED_SOL_MINT
  const fromLabel = labelFor(fromMint)
  const outLabel = labelFor(outMint)

  useEffect(() => {
    api
      .relayerInfo()
      .then((info) => {
        const mints = info.supported_mints.map((m) => m.mint)
        setSupported(mints)
        if (mints.length > 0 && !mints.includes(mint)) setMint(mints[0])
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!client) {
      setSolBal("0")
      setSplBal("0")
      return
    }
    setSolBal(client.getPrivateBalanceSOL().toString())
    setSplBal(client.getPrivateBalanceSPL(mint).toString())
  }, [client, mint, result])

  useEffect(() => {
    setQuote(null)
    setQuoteErr(null)
    if (!client || !connected) return
    let cancelled = false
    const handle = window.setTimeout(async () => {
      try {
        const t = amount.trim()
        if (!t || t.endsWith(".")) return
        const raw = toRaw(t, decimalsFor(fromMint))
        if (raw <= 0n) return
        setQuoting(true)
        const q = await client.quotePrivateSwap({
          fromMint,
          outMint,
          amountIn: raw.toString(),
          slippageBps: Number(slippageBps) || 100,
        })
        if (!cancelled) {
          setQuote(q)
          setQuoteErr(null)
        }
      } catch (e) {
        if (!cancelled) {
          setQuote(null)
          setQuoteErr((e as Error).message)
        }
      } finally {
        if (!cancelled) setQuoting(false)
      }
    }, 450)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [client, connected, amount, fromMint, outMint, slippageBps])

  const fromBalance = solToSpl ? solBal : splBal
  const fromBalanceLabel = useMemo(
    () => `${fromRaw(fromBalance, decimalsFor(fromMint))} ${fromLabel}`,
    [fromBalance, fromMint, fromLabel],
  )

  const handleSwap = async () => {
    if (!client) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setStatus("unlocking notes (approve the wallet signature)…")
    try {
      const raw = toRaw(amount, decimalsFor(fromMint))
      if (raw <= 0n) throw new Error("enter a valid amount")
      setStatus("quoting Jupiter + proving both JoinSplits…")
      const res = await client.swapPrivate({
        fromMint,
        outMint,
        amountIn: raw.toString(),
        slippageBps: Number(slippageBps) || 100,
      })
      setResult(res)
      setStatus(null)
      onChanged?.()
      client.backupNotes().catch(() => {})
      toast.success("private swap landed", {
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
          <ArrowLeftRight className="size-4" /> Swap privately (SOL ↔ SPL)
        </CardTitle>
        <CardDescription>
          Spend a shielded note, swap through Jupiter inside the pool, and
          receive a new note of the other asset. Phantom only signs the unlock
          message — the relayer signs the v1 Swap (wallets cannot sign v1 yet).
          Initialize the SPL tree in Operator if this mint has never been used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet to unlock notes. The swap transaction itself is
              relayer-signed.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-1 rounded-xl border border-border bg-secondary p-1">
          <Button
            size="sm"
            variant={solToSpl ? "default" : "ghost"}
            disabled={busy}
            onClick={() => setSolToSpl(true)}
            className="flex-1"
          >
            SOL → {labelFor(mint)}
          </Button>
          <Button
            size="sm"
            variant={!solToSpl ? "default" : "ghost"}
            disabled={busy}
            onClick={() => setSolToSpl(false)}
            className="flex-1"
          >
            {labelFor(mint)} → SOL
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="swap-mint">SPL mint</Label>
          <Input
            id="swap-mint"
            value={mint}
            onChange={(e) => setMint(e.target.value.trim())}
            className="font-mono text-xs"
            disabled={!connected || busy}
          />
          {supported.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {supported.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={m === mint ? "default" : "outline"}
                  size="sm"
                  className="h-6 px-2 font-mono text-[10px]"
                  disabled={!connected || busy}
                  onClick={() => setMint(m)}
                >
                  {m === USDC ? "USDC" : shortHash(m, 4, 4)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="swap-amount">amount ({fromLabel})</Label>
            <Input
              id="swap-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={!connected || busy}
            />
            <p className="text-[11px] text-muted-foreground">
              private balance {fromBalanceLabel}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="swap-slip">slippage (bps)</Label>
            <Input
              id="swap-slip"
              value={slippageBps}
              onChange={(e) => setSlippageBps(e.target.value)}
              inputMode="numeric"
              disabled={!connected || busy}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-secondary/50 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ArrowDownUp className="size-3.5" />
              {quoting ? "quoting…" : "min received"}
            </span>
            <span className="font-mono text-foreground">
              {quote
                ? `${fromRaw(quote.minOut, decimalsFor(outMint))} ${outLabel}`
                : "—"}
            </span>
          </div>
          {quoteErr && (
            <p className="mt-1 text-[11px] text-destructive">{quoteErr}</p>
          )}
        </div>

        <Button onClick={handleSwap} disabled={!connected || busy || quoting} className="w-full">
          {busy ? status ?? "Working…" : `Swap ${fromLabel} → ${outLabel}`}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
                amount_in: result.amountIn,
                min_out: result.minAmountOut,
                from_mint: result.fromMint,
                out_mint: result.outMint,
                nullifiers: result.nullifiers,
              }}
            />
          </div>
        )}
        {err && <ErrorBlock code="SWAP_FAILED" message={err} />}
      </CardContent>
    </Card>
  )
}
