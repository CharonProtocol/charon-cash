import { useCallback, useState } from "react"

import { NavBar } from "@/components/NavBar"
import { RelayerInfoCard } from "@/components/RelayerInfoCard"
import { MerkleTreeCard } from "@/components/MerkleTreeCard"
import { NullifierCard } from "@/components/NullifierCard"
import { AdminCard } from "@/components/AdminCard"
import { WithdrawCard } from "@/components/WithdrawCard"

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <RelayerInfoCard refreshKey={refreshKey} />
          <NullifierCard />
          <MerkleTreeCard />
          <AdminCard onChanged={bump} />
          <div className="lg:col-span-2">
            <WithdrawCard />
          </div>
        </div>
        <footer className="mt-8 text-center text-xs text-muted-foreground">
          privacy-cash relayer demo · relayer signs & submits every transaction · client
          SDK (ZK proof) plugs into <code>src/lib/client-sdk</code>
        </footer>
      </main>
    </div>
  )
}
