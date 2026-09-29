import { useMemo, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { ArrowRight, Eye, EyeOff, Landmark, RefreshCw, ShieldCheck, Users, Wallet } from "lucide-react"
import { publishRecipientKeys } from "privacy-cash-sdk"

import { Badge } from "@/components/ui/badge"
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
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">My payments</h1>
        {publicKey && (
          <Badge variant="outline" className="font-mono">
            <Wallet className="mr-1 size-3" />
            {shortHash(publicKey.toBase58())}
          </Badge>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!connected ? (
        <Card className="card-lift border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl border border-zinc-200 bg-secondary">
              <Users className="size-7 text-primary" />
            </div>
            <div>
              <p className="h-display text-lg">Connect your wallet</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" />
              Enable private receiving
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your employer can pay you with a private note — invisible on-chain — instead of a public
              transfer. One-time setup: approve two signature requests to publish your receiving keys.
              Until then, payouts arrive as normal public SOL transfers.
            </p>
            <Button onClick={enable} disabled={enabling}>
              {enabling ? "Waiting for signature…" : "Enable private receiving"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <EyeOff className="size-4" /> Private notes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {noteSolRaw === null ? "—" : `${maxClaimSol.toFixed(4)} SOL`}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {noteRows.length} note{noteRows.length === 1 ? "" : "s"} in the shielded pool
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Landmark className="size-4" /> Wallet balance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {walletSolRaw === null ? "—" : `${(walletSolRaw / 1e9).toFixed(4)} SOL`}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">public, spendable now</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">
                <Eye className="mr-2 inline size-4 text-primary" />
                Received payments
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => rescan()}>
                <RefreshCw className="mr-1 size-3" /> Scan
              </Button>
            </CardHeader>
            <CardContent>
              {noteRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No private notes yet. When your employer runs a shielded payroll, payments appear
                  here after a scan.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium">Amount</th>
                      <th className="py-2 font-medium">Leaf</th>
                      <th className="py-2 font-medium">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noteRows.map((n) => (
                      <tr key={n.id} className="border-b last:border-0">
                        <td className="py-2 tabular-nums">{lamportsToSol(BigInt(n.amount).toString()).toFixed(6)} SOL</td>
                        <td className="py-2 font-mono text-xs text-muted-foreground">#{n.index}</td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {new Date(n.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
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
                <Button onClick={claim} disabled={claiming || gross <= 0n || net <= 0n}>
                  {claiming ? "Claiming…" : "Claim"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
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
