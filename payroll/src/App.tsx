import { Ms } from "@/components/motion/ms"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useCallback, useEffect, useState } from "react"

import { EmployeeApp } from "@/components/EmployeeApp"
import { EmployerApp } from "@/components/EmployerApp"
import { Landing } from "@/components/Landing"

type Role = "landing" | "employer" | "employee"
const ROLE_KEY = "payroll:role"

function readRole(): Role {
  try {
    const r = localStorage.getItem(ROLE_KEY)
    return r === "employer" || r === "employee" ? r : "landing"
  } catch {
    return "landing"
  }
}

export default function App() {
  const [role, setRole] = useState<Role>(readRole)

  useEffect(() => {
    try {
      if (role === "landing") localStorage.removeItem(ROLE_KEY)
      else localStorage.setItem(ROLE_KEY, role)
    } catch {
      // storage unavailable — role just won't survive a refresh
    }
  }, [role])

  const go = useCallback((r: Role) => {
    setRole(r)
    window.scrollTo(0, 0)
  }, [])

  if (role === "landing") return <Landing onRole={(r) => go(r)} />

  return (
    <div className="min-h-dvh">
      <div className="aurora" aria-hidden>
        <div className="grid-lines" />
      </div>
      {/* console band: the dark obsidian strip that stays dark in both themes */}
      <header className="sticky top-0 z-40 border-b border-band-line bg-band/95 text-band-ink shadow-[0_1px_8px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1150px] items-center justify-between px-4 sm:px-6">
          <button
            className="flex items-center gap-2 outline-none focus-visible:outline-none"
            onClick={() => go("landing")}
            aria-label="Back to landing"
          >
            <img src="/charon-mark.png" alt="" className="size-7 rounded-full" />
            <span className="hidden font-semibold tracking-tight sm:inline">Charon Pay</span>
            <span className="rounded border border-band-line bg-band-2 px-1.5 py-0.5 font-mono text-[11px] text-band-mute">
              ZK-V2.4
            </span>
          </button>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded border border-band-line bg-band-2 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-band-mute">
              <span className="size-1.5 rounded-full bg-band-gold" />
              {role === "employer" ? "employer" : "employee"}
            </span>
            <button
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-band-mute transition-colors hover:bg-band-2 hover:text-band-ink"
              onClick={() => go(role === "employer" ? "employee" : "employer")}
            >
              <Ms name="swap_horiz" className="text-sm" />
              Switch to {role === "employer" ? "employee" : "employer"}
            </button>
            <ThemeToggle band />
          </div>
        </div>
      </header>
      <div key={role} className="anim">
        {role === "employer" ? <EmployerApp /> : <EmployeeApp />}
      </div>
    </div>
  )
}
