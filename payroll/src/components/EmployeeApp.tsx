import { useMemo, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowRight, Eye, EyeOff, Landmark, RefreshCw, ShieldCheck } from "lucide-react"
import { publishRecipientKeys } from "privacy-cash-sdk"

import { Ms } from "@/components/motion/ms"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useConnectWallet } from "@/components/WalletProvider"
import { useEmployeeClient } from "@/hooks/useEmployeeClient"
import { lamportsToSol, shortHash, solToLamports } from "@/lib/format"

export function EmployeeApp() {
  const { open: openModal } = useConnectWallet()
  const { publicKey, signMessage, signTransaction } = useWallet()
  const {
    connected,
    client,
    busy,
    error,
    registered,
    noteSolRaw,
    walletSolRaw,
    bps,
    minFee,
    rescan,
    notes,
  } = useEmployeeClient()

  const [claimSol, setClaimSol] = useState("")
  const [claiming, setClaiming] = useState(false)
  const [enabling, setEnabling] = useState(false)

  const noteRows = useMemo(() => notes(), [notes])
  const maxClaimSol = noteSolRaw !== null ? lamportsToSol(noteSolRaw.toString()) : 0
  const gross = BigInt(claimSol.trim() ? solToLamports(Number(claimSol) || 0) : 0)
  const fee = bps !== null ? BigInt(Math.max(minFee, Number((gross * BigInt(bps)) / 10000n))) : 0n
  const net = gross > fee ? gross - fee : 0n

  const enable = async () => {
    if (!publicKey || !signMessage || !signTransaction) return
    setEnabling(true)
    try {
      await publishRecipientKeys({ publicKey, signMessage, signTransaction })
      toast.success("Private receiving enabled")
      window.location.reload()
    } catch (e) {
      toast.error(`Could not enable: ${(e as Error).message}`)
    } finally {
      setEnabling(false)
    }
  }

  const claim = async () => {
    if (!client || !publicKey || gross <= 0n) return
    setClaiming(true)
    try {
      const r = await client.withdrawSOL(Number(gross), publicKey, { relay: true })
      toast.success(`Claimed ${lamportsToSol(r.recipientLamports).toFixed(6)} SOL`, { description: shortHash(r.signature, 10) })
      setClaimSol("")
      await rescan()
    } catch (e) {
      toast.error(`Claim failed: ${(e as Error).message}`)
    } finally {
      setClaiming(false)
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-gold">
            Shielded Claims
          </div>
          <h1 className="h-display mt-0.5 text-2xl">My payments</h1>
        </div>
        {publicKey && (
          <span className="rounded border border-line bg-card px-2 py-1 font-mono text-[11px] text-body-ink">
            {shortHash(publicKey.toBase58())}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!connected ? (
        <Card className="card-lift specular">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-[var(--gold-2)] opacity-20 blur-2xl" />
              <img src="/charon-mark.png" alt="" className="relative size-14 rounded-full object-contain" />
            </div>
            <div>
              <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-gold">
                Private Inbox
              </p>
              <p className="h-display mt-1 text-lg">Connect your wallet</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-body-ink">
                See every private payment that's yours — amounts invisible to everyone else.
              </p>
            </div>
            <Button size="lg" className="btn-glow" onClick={openModal}>
              Connect wallet <ArrowRight className="ml-1 size-4" />
            </Button>
          </CardContent>
        </Card>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">
          {registered === false ? "Checking registry…" : "Unlocking… (approve the signature request)"}
        </p>
      ) : registered === null ? null : registered === false ? (
        <Card className="card-lift specular">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-gold" />
              Enable private receiving
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-body-ink">
              Your employer can pay you with a private note — invisible on-chain — instead of a public
              transfer. One-time setup: approve two signature requests to publish your receiving keys.
              Until then, payouts arrive as normal public SOL transfers.
            </p>
            <Button className="btn-glow" onClick={enable} disabled={enabling}>
              {enabling ? "Waiting for signature…" : "Enable private receiving"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card className="card-lift specular">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-body-ink">
                  <EyeOff className="size-3.5 text-gold" /> Private notes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="stat-number text-2xl font-semibold tabular-nums text-gold">
                  {noteSolRaw === null ? "—" : `${maxClaimSol.toFixed(4)} SOL`}
                </div>
                <p className="mt-1 text-xs text-body-ink">
                  {noteRows.length} note{noteRows.length === 1 ? "" : "s"} in the shielded pool
                </p>
              </CardContent>
            </Card>
            <Card className="card-lift specular">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-body-ink">
                  <Landmark className="size-3.5" /> Wallet balance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="stat-number text-2xl font-semibold tabular-nums">
                  {walletSolRaw === null ? "—" : `${(walletSolRaw / 1e9).toFixed(4)} SOL`}
                </div>
                <p className="mt-1 text-xs text-body-ink">public, spendable now</p>
              </CardContent>
            </Card>
          </div>

          <Card className="card-lift specular">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">
                <Eye className="mr-2 inline size-4 text-gold" />
                Received payments
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => rescan()}>
                <RefreshCw className="mr-1 size-3" /> Scan
              </Button>
            </CardHeader>
            <CardContent>
              {noteRows.length === 0 ? (
                <p className="text-sm text-body-ink">
                  No private notes yet. When your employer runs a shielded payroll, payments appear
                  here after a scan.
                </p>
              ) : (
                <div className="space-y-2">
                  {noteRows.map((n) => (
                    <div
                      key={n.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm transition-colors hover:border-[color-mix(in_srgb,var(--gold-2)_35%,transparent)]"
                    >
                      <span className="font-mono tabular-nums">
                        {lamportsToSol(BigInt(n.amount).toString()).toFixed(6)} SOL
                      </span>
                      <span className="font-mono text-xs text-body-ink">leaf #{n.index}</span>
                      <span className="hidden text-xs text-body-ink sm:inline">
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                      <span className="tag tag--priv">
                        <Ms name="lock" className="text-xs" /> shielded
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="card-lift specular">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Claim to wallet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  value={claimSol}
                  onChange={(e) => setClaimSol(e.target.value)}
                  placeholder={`up to ${maxClaimSol.toFixed(6)}`}
                  inputMode="decimal"
                />
                <Button variant="outline" size="sm" onClick={() => setClaimSol(maxClaimSol.toFixed(6))}>
                  Max
                </Button>
                <Button className="btn-glow" onClick={claim} disabled={claiming || gross <= 0n || net <= 0n}>
                  {claiming ? "Claiming…" : "Claim"}
                </Button>
              </div>
              <p className="text-xs text-body-ink">
                {gross > 0n
                  ? `receive ${lamportsToSol(net.toString()).toFixed(6)} SOL · relayer fee ${lamportsToSol(fee.toString()).toFixed(6)} SOL`
                  : "Moves notes out of the shielded pool to your public balance."}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}
