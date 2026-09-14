import { useState } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Droplets, Wallet } from "lucide-react"
import { LAMPORTS_PER_SOL } from "@solana/web3.js"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { isLocalRpc } from "@/lib/explorer"
import { lamportsToSol, shortHash } from "@/lib/format"

export function WalletBar({
  vaultSolRaw,
  relayerOk,
  onOpenSettings,
  onFunded,
}: {
  vaultSolRaw: bigint | null
  relayerOk: boolean | null
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
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Badge variant={relayerOk === null ? "secondary" : relayerOk ? "default" : "destructive"}>
          {relayerOk === null ? "relayer…" : relayerOk ? "relayer up" : "relayer down"}
        </Badge>
        {vaultSolRaw !== null && (
          <Badge variant="outline">vault {lamportsToSol(vaultSolRaw.toString()).toFixed(4)} SOL</Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
        {publicKey ? (
          <>
            {isLocalRpc() && (
              <Button variant="outline" size="sm" disabled={faucetBusy} onClick={faucet}>
                <Droplets className="mr-1 size-3.5 text-primary" />
                {faucetBusy ? "dripping…" : "Faucet +10"}
              </Button>
            )}
            <Badge variant="outline" className="font-mono">
              <Wallet className="mr-1 size-3" />
              {shortHash(publicKey.toBase58())}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => disconnect()}>
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
