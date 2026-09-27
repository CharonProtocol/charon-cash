import { useState } from "react"
import { MerkleTreeCard } from "@/components/MerkleTreeCard"
import { NullifierCard } from "@/components/NullifierCard"
import { RelayerInfoCard } from "@/components/RelayerInfoCard"
import { Activity, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ExplorerView({ refreshKey }: { refreshKey: number }) {
  const [localKey, setLocalKey] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const key = refreshKey + localKey

  const refresh = () => {
    setSpinning(true)
    setLocalKey((k) => k + 1)
    window.setTimeout(() => setSpinning(false), 500)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 py-4">
      <div className="flex flex-col gap-4 rounded-[14px] border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h2 className="h-display flex items-center gap-2 text-2xl text-foreground">
            <Activity className="size-6 text-primary" /> Protocol explorer
          </h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Inspect Merkle roots and inclusion paths, check nullifiers (spent notes),
            and view pool fees. Withdraws are <strong className="font-medium text-foreground">relayer-signed</strong> —
            this page only reads indexer / relayer info.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} className="shrink-0 self-start">
          <RefreshCw className={`mr-1.5 size-3.5 ${spinning ? "animate-spin" : ""}`} />
          Refresh all
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <MerkleTreeCard refreshKey={key} />
        <NullifierCard />
      </div>

      <RelayerInfoCard refreshKey={key} />
    </div>
  )
}
