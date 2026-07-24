import { useCallback, useState } from "react"

import { NavBar } from "@/components/NavBar"
import { RelayerInfoCard } from "@/components/RelayerInfoCard"
import { MerkleTreeCard } from "@/components/MerkleTreeCard"
import { NullifierCard } from "@/components/NullifierCard"
import { AdminCard } from "@/components/AdminCard"
import { WithdrawCard } from "@/components/WithdrawCard"
import { DepositCard } from "@/components/DepositCard"
import { DepositSplCard } from "@/components/DepositSplCard"
import { WithdrawSplCard } from "@/components/WithdrawSplCard"
import { NotesCard } from "@/components/NotesCard"

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <DepositCard onChanged={bump} />
          <WithdrawCard onChanged={bump} />
          <DepositSplCard onChanged={bump} />
          <WithdrawSplCard onChanged={bump} />
          <NotesCard refreshKey={refreshKey} />
          <AdminCard onChanged={bump} />
          <MerkleTreeCard />
          <NullifierCard />
          <RelayerInfoCard refreshKey={refreshKey} />
        </div>
        <footer className="mt-8 text-center text-xs text-muted-foreground">
          privacy-cash · fully client-side SDK: proofs, signing &amp; RPC submit
          happen in your browser; the backend is read-only indexer data only
        </footer>
      </main>
    </div>
  )
}
