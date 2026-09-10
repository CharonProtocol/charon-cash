import { ShieldAlert } from "lucide-react"

import { AdminCard } from "@/components/AdminCard"

export function AdminView({ onChanged }: { onChanged: () => void }) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      <div className="space-y-3 rounded-[14px] border border-destructive/30 bg-destructive/5 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
            <ShieldAlert className="size-6" />
          </div>
          <div>
            <h2 className="h-display text-xl text-destructive">Operator console</h2>
            <p className="text-xs text-muted-foreground">
              Program configuration &amp; tree initialization
            </p>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Operators initialize Merkle trees, set fee rates, and configure deposit
          limits. Standard users should use the Privacy Cash app.
        </p>
      </div>

      <AdminCard onChanged={onChanged} />
    </div>
  )
}
