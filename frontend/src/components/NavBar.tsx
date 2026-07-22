import { useEffect, useState } from "react"
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui"
import { ShieldCheck } from "lucide-react"

import { api } from "@/lib/api"

type Health = "ok" | "down" | "loading"

export function NavBar() {
  const [health, setHealth] = useState<Health>("loading")

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        await api.health()
        if (alive) setHealth("ok")
      } catch {
        if (alive) setHealth("down")
      }
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const dot =
    health === "ok"
      ? "bg-emerald-500"
      : health === "down"
        ? "bg-red-500"
        : "bg-amber-500"
  const label =
    health === "ok"
      ? "backend online"
      : health === "down"
        ? "backend offline"
        : "checking backend…"

  return (
    <header className="border-b bg-card/50 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">privacy-cash</h1>
            <p className="text-xs text-muted-foreground leading-tight">
              relayer demo · connect wallet to receive withdrawals
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground"
            title={label}
          >
            <span className={`size-2 rounded-full ${dot}`} />
            <span className="hidden sm:inline">{label}</span>
          </div>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  )
}
