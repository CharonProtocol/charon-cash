import { useEffect, useState } from "react"

export type Route =
  | { role: "landing"; path: "/" }
  | {
      role: "employer"
      path: "/employer" | "/employer/run" | "/employer/history" | "/employer/team"
      page: "overview" | "payroll" | "history" | "team"
    }
  | { role: "employee"; path: "/employee" }

export function parsePath(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/"
  if (p === "/employer" || p.startsWith("/employer/")) {
    const sub = p.slice("/employer".length)
    if (sub === "/run") return { role: "employer", path: "/employer/run", page: "payroll" }
    if (sub === "/history") return { role: "employer", path: "/employer/history", page: "history" }
    if (sub === "/team") return { role: "employer", path: "/employer/team", page: "team" }
    // bare /employer and unknown subpaths both land on the overview
    return { role: "employer", path: "/employer", page: "overview" }
  }
  if (p === "/employee") return { role: "employee", path: "/employee" }
  return { role: "landing", path: "/" }
}

// Non-role search params (?theme, ?static — used by the screenshot tooling)
// ride along through every navigation; the legacy ?role= param is dropped.
function withSearch(to: string) {
  const q = new URLSearchParams(window.location.search)
  q.delete("role")
  const s = q.toString()
  return s ? `${to}?${s}` : to
}

export function navigate(to: string, replace = false) {
  const url = withSearch(to)
  if (replace) window.history.replaceState(null, "", url)
  else window.history.pushState(null, "", url)
  window.scrollTo(0, 0)
  // popstate listener re-reads location — same mechanism as back/forward
  window.dispatchEvent(new PopStateEvent("popstate"))
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname))

  // Legacy localStorage-role and ?role= links land on the real path once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const r = q.get("role")
    if (r === "employer" || r === "employee") {
      navigate(r, true)
      setRoute(parsePath(window.location.pathname))
      return
    }
    try {
      const stored = localStorage.getItem("payroll:role")
      if (stored === "employer" || stored === "employee") {
        if (window.location.pathname === "/" && !q.has("theme") && !q.has("static")) {
          navigate(stored, true)
          setRoute(parsePath(window.location.pathname))
        }
        localStorage.removeItem("payroll:role")
      }
    } catch {
      // storage unavailable — nothing to migrate
    }
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  return route
}
