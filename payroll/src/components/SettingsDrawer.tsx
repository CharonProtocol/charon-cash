import { useState } from "react"
import { Monitor, Network } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { config } from "@/lib/config"

const PRESETS = {
  local: {
    label: "Local simnet",
    icon: Monitor,
    backendUrl: "http://127.0.0.1:8080",
    rpcUrl: "http://127.0.0.1:8899",
    hint: "surfpool + local backend shim (./run.sh)",
  },
  devnet: {
    label: "Devnet",
    icon: Network,
    backendUrl: "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
    rpcUrl: "https://api.devnet.solana.com",
    hint: "deployed Cloudflare relayer + devnet",
  },
} as const

type PresetKey = keyof typeof PRESETS

function detectPreset(backend: string, rpc: string): PresetKey | null {
  for (const [key, p] of Object.entries(PRESETS) as [PresetKey, (typeof PRESETS)[PresetKey]][]) {
    if (backend === p.backendUrl && rpc === p.rpcUrl) return key
  }
  return null
}

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const initial = config.get()
  const [backendUrl, setBackendUrl] = useState(initial.backendUrl)
  const [rpcUrl, setRpcUrl] = useState(initial.rpcUrl)
  const [preset, setPreset] = useState<PresetKey | null>(() =>
    detectPreset(initial.backendUrl, initial.rpcUrl),
  )

  const apply = (key: PresetKey) => {
    setPreset(key)
    setBackendUrl(PRESETS[key].backendUrl)
    setRpcUrl(PRESETS[key].rpcUrl)
  }

  const save = () => {
    config.set({ backendUrl, rpcUrl })
    location.reload()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        data-lenis-prevent
        className="h-full w-96 max-w-full overflow-y-auto bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="h-display mb-4 text-lg">Settings</h2>
        <div className="mb-5 grid grid-cols-2 gap-2">
          {(Object.keys(PRESETS) as PresetKey[]).map((key) => {
            const p = PRESETS[key]
            const active = preset === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => apply(key)}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  active
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
                title={p.hint}
              >
                <p.icon className="size-3.5" /> {p.label}
              </button>
            )
          })}
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="backend">Backend URL (relayer)</Label>
            <Input
              id="backend"
              value={backendUrl}
              onChange={(e) => {
                setBackendUrl(e.target.value)
                setPreset(detectPreset(e.target.value, rpcUrl))
              }}
              placeholder="https://…workers.dev"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpc">Solana RPC URL</Label>
            <Input
              id="rpc"
              value={rpcUrl}
              onChange={(e) => {
                setRpcUrl(e.target.value)
                setPreset(detectPreset(backendUrl, e.target.value))
              }}
              placeholder="https://api.devnet.solana.com"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Saving reloads the app so the SDK re-points at the new backend. For the local simnet,
            start the stack with{" "}
            <code className="mono">zsh payroll/rust-prover-bench/bench/reset-env.sh</code>.
          </p>
          <div className="flex gap-2">
            <Button className="btn-glow" onClick={save}>
              Save &amp; reload
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
