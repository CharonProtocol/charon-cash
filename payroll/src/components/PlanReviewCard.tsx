import { useMemo, useState } from "react"
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
import { rawToHuman } from "@/lib/format"
import { validateDecimals } from "@/lib/parse"
import { fetchTreeState, splTreeKey } from "privacy-cash-sdk"
import type { Asset, ParsedFile } from "@/lib/types"

const SOL_DECIMALS = 9

export function PlanReviewCard({
  parsed,
  bps,
  vaultSolRaw,
  onRun,
  disabled,
}: {
  parsed: ParsedFile | null
  bps: number | null
  vaultSolRaw: bigint | null
  onRun: (asset: Asset) => void
  disabled: boolean
}) {
  const { connection } = useConnection()
  const [kind, setKind] = useState<"sol" | "spl">("sol")
  const [mint, setMint] = useState("")
  const [decimals, setDecimals] = useState<number | null>(null)
  const [mintError, setMintError] = useState<string | null>(null)

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
    const totalFees = (totalNet * BigInt(bps) + 9_999n) / 10_000n
    return { totalNet, totalFees }
  }, [parsed, activeDecimals, bps])

  const vaultBig = vaultSolRaw ?? 0n
  const shortfall =
    totals && kind === "sol" && totals.totalNet + totals.totalFees > vaultBig
      ? totals.totalNet + totals.totalFees - vaultBig
      : 0n

  const canRun =
    !!parsed && bps !== null && !!asset && !mintError && decimalErrors.length === 0 && !disabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="size-4" /> Review &amp; run
        </CardTitle>
        <CardDescription>
          Vault funds are spent first. {shortfall > 0n ? "You will sign " : "No deposit needed — vault covers this run."}
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
              <Badge variant="secondary" className="ml-auto self-center">Shielded — v2</Badge>
            </div>
          </div>
          {kind === "spl" && (
            <div className="space-y-2">
              <Label htmlFor="mint">Mint</Label>
              <div className="flex gap-2">
                <Input id="mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Mint pubkey" />
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
            onRun(asset)
          }}
        >
          Run payroll
        </Button>
      </CardContent>
    </Card>
  )
}
