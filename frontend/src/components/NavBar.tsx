import { useEffect, useState } from "react"
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui"
import { Home, ShieldCheck, Lock, Activity, ShieldAlert, Moon, Sun } from "lucide-react"

import { api } from "@/lib/api"
import { useTheme } from "@/hooks/useTheme"
import { Button } from "@/components/ui/button"

type Health = "ok" | "down" | "loading"

interface NavBarProps {
  currentRoute: string
  onNavigate: (route: string) => void
}

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" className="text-primary">
        <path d="M12 3 V9 M12 9 L6 14 M12 9 L18 14 M6 14 L3 20 M6 14 L9 20 M18 14 L15 20 M18 14 L21 20" />
      </g>
      <g fill="currentColor" className="text-primary">
        <circle cx="12" cy="3" r="1.8" />
        <circle cx="6" cy="14" r="1.5" />
        <circle cx="18" cy="14" r="1.5" />
      </g>
      <g fill="currentColor" className="text-muted-foreground">
        <circle cx="3" cy="20" r="1.3" />
        <circle cx="9" cy="20" r="1.3" />
        <circle cx="15" cy="20" r="1.3" />
        <circle cx="21" cy="20" r="1.3" />
      </g>
    </svg>
  )
}

export function NavBar({ currentRoute, onNavigate }: NavBarProps) {
  const [health, setHealth] = useState<Health>("loading")
  const { theme, toggle } = useTheme()

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
      ? "bg-green-500"
      : health === "down"
        ? "bg-red-500"
        : "bg-amber-500"
  const label =
    health === "ok"
      ? "Backend Online"
      : health === "down"
        ? "Backend Offline"
        : "Checking backend…"

  const navItems = [
    { id: "landing", label: "Overview", icon: Home },
    { id: "app", label: "App", icon: ShieldCheck },
    { id: "vault", label: "Vault & Notes", icon: Lock },
    { id: "explorer", label: "Explorer", icon: Activity },
  ]

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-6">
          <button
            onClick={() => onNavigate("landing")}
            className="group flex items-center gap-3 text-left focus:outline-none"
          >
            <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-secondary">
              <BrandMark />
            </div>
            <div>
              <h1 className="h-display text-lg leading-tight text-foreground">
                PRIVACY<span className="accent-text">CASH</span>
              </h1>
              <p className="text-[11px] leading-none text-muted-foreground">
                Solana ZK · relayer withdraws
              </p>
            </div>
          </button>

          <nav className="hidden items-center gap-1 rounded-xl border border-border bg-secondary p-1 lg:flex">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = currentRoute === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => onNavigate(item.id)}
                  className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background hover:text-foreground"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div
            className="flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground"
            title={label}
          >
            <span className={`size-2 rounded-full ${dot}`} />
            <span className="hidden font-mono text-[11px] sm:inline">{label}</span>
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={toggle}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-label="Toggle color theme"
            className="size-9"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>

          <button
            onClick={() => onNavigate("admin")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
              currentRoute === "admin"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border text-muted-foreground hover:border-destructive/30 hover:text-destructive"
            }`}
            title="Operator admin console"
          >
            <ShieldAlert className="size-3.5" />
            <span className="hidden md:inline">Operator</span>
          </button>

          <WalletMultiButton />
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-t border-border bg-background px-4 py-2 lg:hidden">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = currentRoute === item.id
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1 text-xs font-medium ${
                isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              <Icon className="size-3.5" />
              {item.label}
            </button>
          )
        })}
      </div>
    </header>
  )
}
