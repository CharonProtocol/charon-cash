import { Ms } from "@/components/motion/ms"
import { GliderGroup } from "@/components/motion/Glider"
import { ThemeToggle } from "@/components/ThemeToggle"

import { EmployeeApp } from "@/components/EmployeeApp"
import { EmployerApp } from "@/components/EmployerApp"
import { Landing } from "@/components/Landing"
import { isLocalRpc } from "@/lib/explorer"
import { navigate, useRoute } from "@/lib/router"

export default function App() {
  const route = useRoute()

  if (route.role === "landing") {
    return (
      <Landing
        onRole={(r) => {
          navigate(`/${r}`)
        }}
      />
    )
  }

  const employer = route.role === "employer"
  // The band's active pill follows the URL, not component state — back/forward
  // and refreshes land on the same tab every time.
  const activeId = employer ? route.page : "employee"

  return (
    <div className="min-h-dvh">
      <div className="aurora" aria-hidden>
        <div className="grid-lines" />
      </div>
      {/* console band: the dark obsidian strip that stays dark in both themes */}
      <header className="sticky top-0 z-40 border-b border-band-line bg-band/95 text-band-ink shadow-[0_1px_8px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
          <button
            className="flex flex-none items-center gap-2 outline-none focus-visible:outline-none"
            onClick={() => navigate("/")}
            aria-label="Back to landing"
          >
            <img src="/charon-mark.png" alt="" className="size-7 rounded-full" />
            <span className="hidden font-semibold tracking-tight sm:inline">Charon Pay</span>
            <span className="rounded border border-band-line bg-band-2 px-1.5 py-0.5 font-mono text-[11px] text-band-mute">
              ZK-V2.4
            </span>
          </button>
          <nav className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
            <GliderGroup
              tone="band"
              pillClassName="bg-band-2 border border-band-line"
              itemClassName="whitespace-nowrap"
              className="mx-auto flex w-fit items-center"
              value={activeId}
              onChange={(id) => {
                if (id === "payroll") navigate("/employer")
                else if (id === "history") navigate("/employer/history")
                else if (id === "team") navigate("/employer/team")
                else navigate("/employee")
              }}
              items={
                employer
                  ? [
                      { id: "overview", label: "Overview" },
                      { id: "payroll", label: "Run Payroll" },
                      { id: "history", label: "Ledger & Receipts" },
                      { id: "team", label: "Team Registry" },
                    ]
                  : [
                      { id: "overview", label: "Overview" },
                      { id: "employee", label: "Shielded Claims" },
                    ]
              }
            />
          </nav>
          <div className="flex flex-none items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded border border-band-line bg-band-2 px-2 py-1 font-mono text-[11px] text-band-mute md:flex">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-band-gold opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-band-gold" />
              </span>
              {isLocalRpc() ? "localnet" : "devnet"}
            </span>
            <button
              className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-band-mute transition-colors hover:bg-band-2 hover:text-band-ink lg:flex"
              onClick={() => navigate(employer ? "/employee" : "/employer")}
            >
              <Ms name="swap_horiz" className="text-sm" />
              {employer ? "Employee portal" : "Treasury console"}
            </button>
            <ThemeToggle band />
          </div>
        </div>
      </header>
      <div key={route.path} className="anim">
        {employer ? <EmployerApp page={route.page} /> : <EmployeeApp />}
      </div>
    </div>
  )
}
