import { useCallback, useEffect, useState } from "react"
import { Check, RefreshCw, Trash2, UserPlus, Users, X } from "lucide-react"
import { toast } from "sonner"
import { fetchRecipientKeys, fetchRecipientsBatch, type RecipientKeys } from "privacy-cash-sdk"
import { PublicKey } from "@solana/web3.js"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { shortHash } from "@/lib/format"
import { listRuns, listManualTeam, addManualTeam, removeManualTeam, TEAM_EVENT } from "@/lib/store"
import type { PayrollEntry } from "@/lib/types"

interface Member {
  address: string
  name?: string
  registered: boolean | null // null = not checked yet
  added?: boolean // manually added (persisted, not from a CSV/receipt)
}


/** The employer's team: every address seen in receipts, the current upload, or
 *  added by hand — checked against the recipient registry. */
export function TeamPage({ extraEntries }: { extraEntries?: PayrollEntry[] }) {
  const [members, setMembers] = useState<Member[]>([])
  const [checking, setChecking] = useState(false)
  const [manual, setManual] = useState<PayrollEntry[]>(() => listManualTeam())
  const [form, setForm] = useState({ address: "", name: "" })
  const [bulk, setBulk] = useState("")
  const [showBulk, setShowBulk] = useState(false)

  // The sync layer may adopt a remote roster (connect or another device's
  // edit) — reload the manual list when that lands.
  useEffect(() => {
    const reload = () => setManual(listManualTeam())
    window.addEventListener(TEAM_EVENT, reload)
    return () => window.removeEventListener(TEAM_EVENT, reload)
  }, [])

  const roster = useCallback((): Member[] => {
    const byAddress = new Map<string, Member>()
    for (const r of listRuns()) {
      for (const e of r.entries) {
        if (!byAddress.has(e.address)) byAddress.set(e.address, { address: e.address, name: e.memo, registered: null })
      }
    }
    for (const e of extraEntries ?? []) {
      if (!byAddress.has(e.address)) byAddress.set(e.address, { address: e.address, name: e.memo, registered: null })
    }
    for (const e of manual) {
      if (!byAddress.has(e.address)) byAddress.set(e.address, { address: e.address, name: e.memo, registered: null, added: true })
    }
    return [...byAddress.values()]
  }, [extraEntries, manual])

  const checkAll = useCallback(async () => {
    const rosterNow = roster()
    setMembers(rosterNow)
    if (rosterNow.length === 0) return
    setChecking(true)
    try {
      let keyed: Map<string, RecipientKeys | null> | null = null
      try {
        keyed = await fetchRecipientsBatch(rosterNow.map((m) => m.address))
      } catch {
        keyed = null // fall through to per-wallet
      }
      const next = await Promise.all(
        rosterNow.map(async (m) => {
          if (keyed) return { ...m, registered: !!keyed.get(m.address) }
          try {
            const keys = await fetchRecipientKeys(m.address)
            return { ...m, registered: !!keys }
          } catch {
            return { ...m, registered: null } // backend down ≠ not enrolled
          }
        }),
      )
      setMembers(next)
    } finally {
      setChecking(false)
    }
  }, [roster])

  useEffect(() => {
    void checkAll()
  }, [checkAll])

  const addOne = () => {
    const addr = form.address.trim()
    if (!addr) return
    try {
      new PublicKey(addr)
    } catch {
      toast.error("That doesn't look like a Solana address.")
      return
    }
    if (manual.some((m) => m.address === addr)) {
      toast.info("Already on the team.")
      return
    }
    addManualTeam({ address: addr, amountHuman: "0", memo: form.name.trim() || undefined })
    setForm({ address: "", name: "" })
    toast.success("Teammate added")
  }

  const addBulk = () => {
    // one "address, name" (or bare address) per line — same shape as payroll CSVs
    const lines = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.toLowerCase().startsWith("address"))
    let added = 0
    const fresh: PayrollEntry[] = []
    for (const line of lines) {
      const [addr, name] = line.split(/[,\t;]/).map((p) => p.trim())
      try {
        new PublicKey(addr)
      } catch {
        continue
      }
      if (manual.some((m) => m.address === addr) || fresh.some((m) => m.address === addr)) continue
      fresh.push({ address: addr, amountHuman: "0", memo: name || undefined })
      added += 1
    }
    if (fresh.length > 0) addManualTeam(fresh)
    setBulk("")
    setShowBulk(false)
    toast.success(added > 0 ? `Added ${added} teammate${added === 1 ? "" : "s"}` : "Nothing new to add")
  }

  const removeManual = (address: string) => {
    removeManualTeam(address)
    setMembers((ms) => ms.filter((m) => m.address !== address || !m.added))
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> Team
          </CardTitle>
          <CardDescription>
            Everyone you've paid (or are about to). "Private receiving" means they enrolled
            their encryption key — the registry stores public keys only.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={checkAll} disabled={checking}>
          <RefreshCw className={`mr-1 size-3 ${checking ? "animate-spin" : ""}`} /> Re-check
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* add teammates */}
        <div className="rounded-xl border border-line bg-panel/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <UserPlus className="size-4 text-gold" />
            <span className="text-xs font-semibold uppercase tracking-wider text-mute">Add teammates</span>
            <button
              type="button"
              className="ml-auto text-[11px] text-mute underline-offset-2 transition-colors hover:text-ink hover:underline"
              onClick={() => setShowBulk((v) => !v)}
            >
              {showBulk ? "single instead" : "paste a list instead"}
            </button>
          </div>
          {showBulk ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder={"One per line:\n3hHsC…jJV6, employee-13\n9gTSc…k8co, employee-14"}
                rows={4}
                className="w-full rounded-lg border border-line bg-card px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-[color-mix(in_srgb,var(--gold-2)_45%,var(--border))]"
              />
              <Button size="sm" onClick={addBulk} disabled={!bulk.trim()}>
                Import list
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Input
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="Wallet address"
                className="min-w-[220px] flex-1 font-mono text-xs"
              />
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Name (optional)"
                className="w-40 text-xs"
              />
              <Button size="sm" onClick={addOne} disabled={!form.address.trim()}>
                Add
              </Button>
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Added teammates stay in this browser and show "not enrolled" until they enable private receiving.
          </p>
        </div>

        {members.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No team yet — upload a payroll CSV, complete a run, or add teammates above.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 font-medium">Private receiving</th>
                  <th className="px-3 py-2 text-right font-medium"> </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => (
                  <tr key={m.address} className="bg-card transition-colors hover:bg-secondary/40">
                    <td className="px-3 py-2 font-medium">{m.name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{shortHash(m.address, 6, 4)}</td>
                    <td className="px-3 py-2">
                      {m.registered === null ? (
                        <span className="text-muted-foreground">…</span>
                      ) : m.registered ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <Check className="size-3" /> enrolled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                          <X className="size-3" /> not enrolled
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {m.added && (
                        <button
                          type="button"
                          aria-label={`Remove ${m.name ?? shortHash(m.address, 4, 3)}`}
                          onClick={() => removeManual(m.address)}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
