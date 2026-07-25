import { MerkleTreeCard } from "@/components/MerkleTreeCard"
import { NullifierCard } from "@/components/NullifierCard"
import { RelayerInfoCard } from "@/components/RelayerInfoCard"
import { Activity } from "lucide-react"

export function ExplorerView({ refreshKey }: { refreshKey: number }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 py-4">
      <div className="space-y-2 rounded-[14px] border border-border bg-card p-6">
        <h2 className="h-display flex items-center gap-2 text-2xl text-foreground">
          <Activity className="size-6 text-primary" /> Protocol state explorer
        </h2>
        <p className="text-sm text-muted-foreground">
          Inspect the indexer-backed Merkle roots, query the nullifier set, and view
          the pool&apos;s fee configuration.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <MerkleTreeCard />
        <NullifierCard />
      </div>

      <RelayerInfoCard refreshKey={refreshKey} />
    </div>
  )
}
