import { NotesCard } from "@/components/NotesCard"
import { Lock, RefreshCw } from "lucide-react"
import { useState } from "react"

import { useNotesSync } from "@/hooks/useNotesSync"
import { Button } from "@/components/ui/button"

export function VaultView({ refreshKey }: { refreshKey: number }) {
  useNotesSync()
  const [localKey, setLocalKey] = useState(0)
  const [spinning, setSpinning] = useState(false)

  const refresh = () => {
    setSpinning(true)
    setLocalKey((k) => k + 1)
    window.setTimeout(() => setSpinning(false), 450)
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      <div className="flex flex-col gap-4 rounded-[14px] border border-border bg-card p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h2 className="h-display flex items-center gap-2 text-2xl text-foreground">
            <Lock className="size-6 text-primary" /> Private commitment vault
          </h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Your spending secrets are stored <strong className="font-medium text-foreground">only</strong> as an
            encrypted blob on the backend — the server can&apos;t read it, and nothing sensitive
            is kept in this browser. Decrypted notes exist solely in memory after you unlock. You
            can export / import JSON; deposits need a wallet signature, withdrawals only need
            unlock + proof — the <strong className="font-medium text-foreground">relayer signs</strong> the on-chain withdraw.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} className="shrink-0">
          <RefreshCw className={`mr-1.5 size-3.5 ${spinning ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <NotesCard refreshKey={refreshKey + localKey} />
    </div>
  )
}
