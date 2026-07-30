import { useCallback, useEffect, useState } from "react"

import { NavBar } from "@/components/NavBar"
import { LandingHero } from "@/components/LandingHero"
import { UserAppView } from "@/components/UserAppView"
import { VaultView } from "@/components/VaultView"
import { ExplorerView } from "@/components/ExplorerView"
import { AdminView } from "@/components/AdminView"

const ROUTES = ["landing", "app", "vault", "explorer", "admin"] as const
type Route = (typeof ROUTES)[number]

function readRoute(): Route {
  const hash = window.location.hash.replace("#", "").toLowerCase()
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : "landing"
}

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])
  const [route, setRoute] = useState<Route>(readRoute)

  const handleNavigate = (next: string) => {
    if (!(ROUTES as readonly string[]).includes(next)) return
    setRoute(next as Route)
    window.location.hash = next
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return (
    <div className="flex min-h-screen flex-col justify-between bg-background text-foreground">
      <div>
        <NavBar currentRoute={route} onNavigate={handleNavigate} />

        <main className="mx-auto max-w-7xl px-4 py-6">
          {route === "landing" && <LandingHero onNavigate={handleNavigate} />}
          {route === "app" && <UserAppView onChanged={bump} />}
          {route === "vault" && <VaultView refreshKey={refreshKey} />}
          {route === "explorer" && <ExplorerView refreshKey={refreshKey} />}
          {route === "admin" && <AdminView onChanged={bump} />}
        </main>
      </div>

      <footer className="border-t border-border bg-secondary/60 py-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row">
          <p className="font-mono text-[11px] text-muted-foreground">
            Privacy Cash · client-side ZK proofs, self-signed to RPC
          </p>
          <div className="flex items-center gap-4 font-mono text-[11px] text-muted-foreground">
            <button onClick={() => handleNavigate("landing")} className="hover:text-primary">
              Overview
            </button>
            <button onClick={() => handleNavigate("app")} className="hover:text-primary">
              App
            </button>
            <button onClick={() => handleNavigate("vault")} className="hover:text-primary">
              Vault
            </button>
            <button onClick={() => handleNavigate("explorer")} className="hover:text-primary">
              Explorer
            </button>
            <button onClick={() => handleNavigate("admin")} className="hover:text-destructive">
              Operator
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
