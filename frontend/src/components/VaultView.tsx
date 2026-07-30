import { NotesCard } from "@/components/NotesCard"
import { Lock } from "lucide-react"

import { useNotesSync } from "@/hooks/useNotesSync"

export function VaultView({ refreshKey }: { refreshKey: number }) {
  useNotesSync()
  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      <div className="space-y-2 rounded-[14px] border border-border bg-card p-6">
        <h2 className="h-display flex items-center gap-2 text-2xl text-foreground">
          <Lock className="size-6 text-primary" /> Private commitment vault
        </h2>
        <p className="text-sm text-muted-foreground">
          Your browser stores encrypted secrets &amp; blinding factors locally, per
          wallet address. There is zero server storage of notes — back up your
          secret strings.
        </p>
      </div>

      <NotesCard refreshKey={refreshKey} />
    </div>
  )
}
