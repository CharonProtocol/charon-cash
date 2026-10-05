import { useState } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Droplets, Lock } from "lucide-react"
import { LAMPORTS_PER_SOL } from "@solana/web3.js"

import { Ms } from "@/components/motion/ms"
import { Button } from "@/components/ui/button"
import { isLocalRpc } from "@/lib/explorer"
import { lamportsToSol, shortHash } from "@/lib/format"

function StatusChip({
  ok,
  pending,
  children,
}: {
  ok?: boolean
  pending?: boolean
  children: React.ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5 rounded border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-body-ink">
      <span
        className={`size-1.5 rounded-full ${
          pending ? "animate-pulse bg-muted-foreground/50" : ok ? "bg-ok" : "bg-critical"
        }`}
      />
      {children}
    </span>
  )
}

export function WalletBar({
  vaultSolRaw,
  relayerOk,
  unlocked,
  unlockBusy,
  onUnlock,
  onOpenSettings,
  onFunded,
}: {
  vaultSolRaw: bigint | null
  relayerOk: boolean | null
  unlocked: boolean
  unlockBusy: boolean
  onUnlock: () => void
  onOpenSettings: () => void
  onFunded?: () => void
}) {
  const { publicKey, disconnect } = useWallet()
  const { connection } = useConnection()
  const [faucetBusy, setFaucetBusy] = useState(false)

  const faucet = async () => {
    if (!publicKey || faucetBusy) return
    setFaucetBusy(true)
    try {
      const sig = await connection.requestAirdrop(publicKey, 10 * LAMPORTS_PER_SOL)
      await connection.confirmTransaction(sig, "confirmed")
      toast.success("+10 SOL airdropped to the treasury wallet")
      onFunded?.()
    } catch (e) {
      toast.error(`Faucet failed: ${(e as Error).message}`)
    } finally {
      setFaucetBusy(false)
    }
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-1.5 gap-y-2 sm:justify-between sm:gap-2">
      <div className="flex items-center gap-1.5 sm:gap-2">
        <StatusChip ok={relayerOk === true} pending={relayerOk === null}>
          <span data-tip="Backend relayer reachable — proofs and submits flow through it">
            {relayerOk === null ? "relayer…" : relayerOk ? "relayer up" : "relayer down"}
          </span>
        </StatusChip>
        {vaultSolRaw !== null && (
          <StatusChip>
            <span data-tip="Shielded vault balance held by the pool">
              <span className="text-mute">vault</span>
              <span className="font-semibold text-gold">
                {lamportsToSol(vaultSolRaw.toString()).toFixed(4)} SOL
              </span>
            </span>
          </StatusChip>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <Button variant="ghost" size="sm" className="px-2 sm:px-3" onClick={onOpenSettings}>
          Settings
        </Button>
        {publicKey ? (
          <>
            {isLocalRpc() && (
              <Button variant="outline" size="sm" disabled={faucetBusy} onClick={faucet}>
                <Droplets className="mr-1 size-3.5 text-gold" />
                {faucetBusy ? "dripping…" : "Faucet +10"}
              </Button>
            )}
            {/* Pending action in place of the connect-time signature popup:
                unlocking is explicit, one click when the user is ready. */}
            {!unlocked && (
              <Button size="sm" className="btn-glow" disabled={unlockBusy} onClick={onUnlock}>
                <Lock className="mr-1 size-3.5" />
                {unlockBusy ? "Unlocking…" : "Unlock vault"}
              </Button>
            )}
            {unlocked && (
              <span className="flex items-center gap-1 rounded border border-ok-line bg-ok-soft px-2 py-1 font-mono text-[11px] font-medium text-ok">
                <Ms name="lock_open" className="text-xs" /> unlocked
              </span>
            )}
            <span className="flex max-w-[7.5rem] items-center gap-1.5 overflow-hidden rounded border border-line bg-card px-2 py-1 font-mono text-[10px] text-body-ink sm:max-w-none sm:text-[11px]">
              <span className="truncate">{shortHash(publicKey.toBase58())}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => disconnect()}>
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
