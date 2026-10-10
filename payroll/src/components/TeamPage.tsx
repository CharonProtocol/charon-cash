import { useCallback, useEffect, useState } from "react"
import { Check, RefreshCw, Trash2, UserPlus, Users, X } from "lucide-react"
import { toast } from "sonner"
import { fetchRecipientKeys, fetchRecipientsBatch, type RecipientKeys } from "privacy-cash-sdk"
import { PublicKey } from "@solana/web3.js"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { rawToHuman, shortHash } from "@/lib/format"
import { toRaw } from "@/lib/parse"
import { listRuns, listManualTeam, addManualTeam, removeManualTeam, TEAM_EVENT } from "@/lib/store"
import type { PayrollEntry } from "@/lib/types"

const SOL_DECIMALS = 9

interface Member {
  address: string
  name?: string
  registered: boolean | null // null = not checked yet
  added?: boolean // manually added (persisted, not from a CSV/receipt)
  /** Cumulative chain-confirmed payouts from this browser's run receipts. */
  paidRaw: bigint
  payouts: number
  lastPaidAt?: number
  /** Most recent receipt row for this address: paid / pending / failed. */
  lastStatus?: "paid" | "pending" | "failed"
}


/** The employer's team: every address seen in receipts, the current upload, or
 *  added by hand — checked against the recipient registry, with the real
 *  cumulative paid value summed from confirmed receipt rows. */
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
    // Oldest run first so the newest receipt row wins `lastStatus`; every
    // "sent" row (chain-confirmed) adds to the member's cumulative paid total.
    const runs = [...listRuns()].sort((a, b) => a.createdAt - b.createdAt)
    for (const r of runs) {
      for (const e of r.entries) {
        const m = byAddress.get(e.address) ?? {
          address: e.address,
          name: e.memo,
          registered: null,
          paidRaw: 0n,
          payouts: 0,
        }
        m.name = m.name ?? e.memo
        if (e.status === "sent") {
          try {
            m.paidRaw += toRaw(e.amountHuman, SOL_DECIMALS)
          } catch {
            /* malformed amount — skip the sum, still count the payout */
          }
          m.payouts += 1
          m.lastPaidAt = Math.max(
            m.lastPaidAt ?? 0,
            e.confirmedAt ?? e.relayedAt ?? r.finishedAt ?? r.createdAt,
          )
          m.lastStatus = "paid"
        } else {
          m.lastStatus = e.status === "confirming" ? "pending" : "failed"
        }
        byAddress.set(e.address, m)
      }
    }
    for (const e of extraEntries ?? []) {
      if (!byAddress.has(e.address))
        byAddress.set(e.address, { address: e.address, name: e.memo, registered: null, paidRaw: 0n, payouts: 0 })
    }
    for (const e of manual) {
      if (!byAddress.has(e.address))
        byAddress.set(e.address, { address: e.address, name: e.memo, registered: null, added: true, paidRaw: 0n, payouts: 0 })
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
            Everyone you've paid (or are about to) with their real cumulative payouts, summed
            from chain-confirmed receipt rows. "Private receiving" means they enrolled
            their encryption key - the registry stores public keys only.
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
            No team yet - upload a payroll CSV, complete a run, or add teammates above.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 text-right font-medium">Total paid</th>
                  <th className="px-3 py-2 font-medium">Private receiving</th>
                  <th className="px-3 py-2 text-right font-medium"> </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => (
                  <tr key={m.address} className="bg-card transition-colors hover:bg-secondary/40">
                    <td className="px-3 py-2 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {m.name ?? "-"}
                        {m.lastStatus === "paid" && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            <Check className="size-2.5" /> paid
                          </span>
                        )}
                        {m.lastStatus === "pending" && (
                          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                            pending
                          </span>
                        )}
                        {m.lastStatus === "failed" && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                            <X className="size-2.5" /> failed
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{shortHash(m.address, 6, 4)}</td>
                    <td className="px-3 py-2 text-right">
                      {m.payouts > 0 ? (
                        <>
                          <span className="font-mono font-medium">
                            {rawToHuman(m.paidRaw, SOL_DECIMALS)} SOL
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {m.payouts} payout{m.payouts === 1 ? "" : "s"}
                            {m.lastPaidAt
                              ? ` · ${new Date(m.lastPaidAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                              : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
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
