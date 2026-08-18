import { useWallet } from "@solana/wallet-adapter-react"
import { Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { lamportsToSol, shortHash } from "@/lib/format"

export function WalletBar({
  vaultSolRaw,
  relayerOk,
  onOpenSettings,
}: {
  vaultSolRaw: bigint | null
  relayerOk: boolean | null
  onOpenSettings: () => void
}) {
  const { publicKey, disconnect } = useWallet()
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
