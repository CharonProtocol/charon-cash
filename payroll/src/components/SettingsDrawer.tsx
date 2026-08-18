import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { config } from "@/lib/config"

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [backendUrl, setBackendUrl] = useState(config.get().backendUrl)
  const [rpcUrl, setRpcUrl] = useState(config.get().rpcUrl)

  const save = () => {
    config.set({ backendUrl, rpcUrl })
    location.reload()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-96 max-w-full overflow-y-auto bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">Settings</h2>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="backend">Backend URL (relayer)</Label>
            <Input id="backend" value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} placeholder="https://…workers.dev" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpc">Solana RPC URL</Label>
            <Input id="rpc" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder="https://api.devnet.solana.com" />
          </div>
          <p className="text-xs text-muted-foreground">
            Saving reloads the app so the SDK re-points at the new backend.
          </p>
          <div className="flex gap-2">
            <Button onClick={save}>Save &amp; reload</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
