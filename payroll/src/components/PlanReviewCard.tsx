import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { getMint } from "@solana/spl-token"
import { useConnection } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import { Play } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { rawToHuman, shortHash } from "@/lib/format"
import { validateDecimals } from "@/lib/parse"
import { fetchRecipientKeys, fetchTreeState, splTreeKey } from "privacy-cash-sdk"
import type { Asset, ParsedFile, RunMode } from "@/lib/types"

const SOL_DECIMALS = 9

interface RecipientCheck {
  total: number
  registered: number
  unregistered: string[]
}

export function PlanReviewCard({
  parsed,
  bps,
  minTransferFee,
  vaultSolRaw,
  onRun,
  disabled,
}: {
  parsed: ParsedFile | null
  bps: number | null
  minTransferFee: number
  vaultSolRaw: bigint | null
  onRun: (asset: Asset, mode: RunMode) => void
  disabled: boolean
}) {
  const { connection } = useConnection()
  const [kind, setKind] = useState<"sol" | "spl">("sol")
  const [mint, setMint] = useState("")
  const [decimals, setDecimals] = useState<number | null>(null)
  const [mintError, setMintError] = useState<string | null>(null)
  const [mode, setMode] = useState<RunMode>("public")
  const [recipientCheck, setRecipientCheck] = useState<RecipientCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  // A new file means the previous recipient check no longer applies.
  useEffect(() => {
    setRecipientCheck(null)
    setCheckError(null)
  }, [parsed?.fileHash])

  const asset: Asset | null = useMemo(() => {
    if (kind === "sol") return { kind: "sol" }
    if (mint && decimals !== null) return { kind: "spl", mint, decimals }
    return null
  }, [kind, mint, decimals])

  const activeDecimals = kind === "sol" ? SOL_DECIMALS : decimals

  const decimalErrors =
    parsed && activeDecimals !== null ? validateDecimals(parsed.entries, activeDecimals) : []

  const resolveMint = async () => {
    setMintError(null)
    setDecimals(null)
    try {
      const m = new PublicKey(mint)
      const info = await getMint(connection, m)
      setDecimals(info.decimals)
      // Fail fast (spec: error matrix) if this mint has no initialized tree.
      try {
        await fetchTreeState(splTreeKey(m.toBase58()))
      } catch {
        setMintError(
          "this mint has no initialized merkle tree — ask the operator to initialize it (see README ops notes)",
        )
      }
    } catch (e) {
      setMintError(`cannot load mint: ${(e as Error).message}`)
    }
  }

  const totals = useMemo(() => {
    if (!parsed || activeDecimals === null || bps === null) return null
    // fee math preview only — full planning re-runs in the engine
    const nets = parsed.entries.map((e) => ({
      net: BigInt(
        (e.amountHuman.split(".")[0] || "0") +
          ((e.amountHuman.split(".")[1] ?? "").padEnd(activeDecimals, "0").slice(0, activeDecimals)),
      ),
    }))
    const totalNet = nets.reduce((s, n) => s + n.net, 0n)
    // Private SOL mode pays one fee per row out of vault notes, and each row's
    // fee is floored at the relayer minimum — mirror that per-row math here so
    // the estimate matches what the engine will actually spend.
    const floor = kind === "sol" ? BigInt(minTransferFee) : 0n
    const totalFees =
      mode === "shielded"
        ? nets.reduce((s, n) => {
          let f = (n.net * BigInt(bps) + 9_999n) / 10_000n
          if (f < floor) f = floor
          return s + f
        }, 0n)
        : (totalNet * BigInt(bps) + 9_999n) / 10_000n
    return { totalNet, totalFees }
  }, [parsed, activeDecimals, bps, kind, mode, minTransferFee])

  const vaultBig = vaultSolRaw ?? 0n
  const shortfall =
    totals && kind === "sol" && totals.totalNet + totals.totalFees > vaultBig
      ? totals.totalNet + totals.totalFees - vaultBig
      : 0n

  const checkRecipients = async () => {
    if (!parsed) return
    setChecking(true)
    setCheckError(null)
    try {
      const unregistered: string[] = []
      for (const e of parsed.entries) {
        // fetchRecipientKeys returns null only for a confirmed 404 (not
        // enrolled); any other failure (backend down, 5xx) must throw so the
        // treasurer sees "could not verify" instead of a false "not enrolled"
        const keys = await fetchRecipientKeys(e.address)
        if (!keys) unregistered.push(e.address)
      }
      setRecipientCheck({
        total: parsed.entries.length,
        registered: parsed.entries.length - unregistered.length,
        unregistered,
      })
    } catch (e) {
      setRecipientCheck(null)
      setCheckError(`could not verify recipients: ${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  const shieldedReady =
    mode === "public" ||
    (recipientCheck !== null && recipientCheck.unregistered.length === 0)

  const canRun =
    !!parsed && bps !== null && !!asset && !mintError && decimalErrors.length === 0 && !disabled && shieldedReady

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="size-4" /> Review &amp; run
        </CardTitle>
        <CardDescription>
          Vault funds are spent first. {shortfall > 0n
            ? `You will sign one deposit of ${rawToHuman(shortfall, SOL_DECIMALS)} SOL.`
            : "No deposit needed — vault covers this run."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Asset</Label>
            <div className="flex gap-1 rounded-lg border p-0.5">
              {(["sol", "spl"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => { setKind(k); setDecimals(null) }}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                >
                  {k === "sol" ? "SOL" : "SPL token"}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Payout mode</Label>
            <div className="flex gap-1 rounded-lg border p-0.5">
              {(["public", "shielded"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                >
                  {m === "public" ? "Public" : "Private notes"}
                </button>
              ))}
              {mode === "shielded" && (
                <Badge variant="secondary" className="ml-auto self-center">v2</Badge>
              )}
            </div>
          </div>
          {mode === "shielded" && (
            <div className="space-y-2 sm:col-span-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={checkRecipients} disabled={!parsed || checking}>
                  {checking ? "Checking..." : "Check recipients"}
                </Button>
                {recipientCheck && (
                  <span className="text-xs text-muted-foreground">
                    {recipientCheck.registered}/{recipientCheck.total} registered
                  </span>
                )}
              </div>
              {checkError && <p className="text-xs text-destructive">{checkError}</p>}
              {recipientCheck && recipientCheck.unregistered.length > 0 && (
                <div className="rounded-lg border p-2">
                  <p className="text-xs font-medium text-destructive">
                    These employees have not enabled private receiving:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {recipientCheck.unregistered.map((a) => (
                      <li key={a} className="font-mono text-xs text-muted-foreground">
                        {shortHash(a, 8, 6)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Run stays disabled until every row is registered.
                  </p>
                </div>
              )}
              {recipientCheck && recipientCheck.unregistered.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Every employee can receive private notes.
                </p>
              )}
            </div>
          )}
          {kind === "spl" && (
            <div className="space-y-2">
              <Label htmlFor="mint">Mint</Label>
              <div className="flex gap-2">
                <Input id="mint" value={mint} onChange={(e) => { setMint(e.target.value); setDecimals(null); setMintError(null) }} placeholder="Mint pubkey" />
                <Button variant="outline" onClick={resolveMint} disabled={!mint}>Load</Button>
              </div>
              {decimals !== null && <p className="text-xs text-muted-foreground">decimals: {decimals}</p>}
              {mintError && <p className="text-xs text-destructive">{mintError}</p>}
            </div>
          )}
        </div>

        {totals && (
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Employees receive</div>
              <div className="font-mono">
                {rawToHuman(totals.totalNet, activeDecimals!)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Relayer fees (est.)</div>
              <div className="font-mono">{rawToHuman(totals.totalFees, activeDecimals!)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">
                {kind === "sol" ? "Deposit to sign" : "SPL vault needed"}
              </div>
              <div className="font-mono">
                {kind === "sol" ? rawToHuman(shortfall, SOL_DECIMALS) : "—"}
              </div>
            </div>
          </div>
        )}

        {decimalErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Amounts exceed this asset's decimals</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {decimalErrors.map((e, i) => <li key={i} className="font-mono text-xs">{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={!canRun}
          onClick={() => {
            if (!asset) return
            if (kind === "spl" && mint && decimals !== null) {
              toast.info("First SPL run may ask for one extra one-time signature (lookup table setup).")
            }
            if (mode === "shielded") {
              toast.info("Private mode: each employee receives a note only they can spend.")
            }
            onRun(asset, mode)
          }}
        >
          Run payroll
        </Button>
      </CardContent>
    </Card>
  )
}
