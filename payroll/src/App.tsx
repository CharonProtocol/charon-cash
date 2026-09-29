import { useCallback, useEffect, useState } from "react"

import { EmployeeApp } from "@/components/EmployeeApp"
import { EmployerApp } from "@/components/EmployerApp"
import { Landing } from "@/components/Landing"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

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
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 sm:px-6">
          <button
            className="flex items-center gap-2"
            onClick={() => go("landing")}
            aria-label="Back to landing"
          >
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              P
            </div>
            <span className="hidden font-semibold tracking-tight sm:inline">Privacy Payroll</span>
          </button>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{role === "employer" ? "employer" : "employee"}</Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(role === "employer" ? "employee" : "employer")}
            >
              Switch to {role === "employer" ? "employee" : "employer"}
            </Button>
          </div>
        </div>
      </header>
      {role === "employer" ? <EmployerApp /> : <EmployeeApp />}
    </div>
  )
}
