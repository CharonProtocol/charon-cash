import { useCallback, useEffect, useState } from "react"
import { Check, RefreshCw, Users, X } from "lucide-react"
import { fetchRecipientKeys } from "privacy-cash-sdk"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { shortHash } from "@/lib/format"
import { listRuns } from "@/lib/store"
import type { PayrollEntry } from "@/lib/types"

interface Member {
  address: string
  name?: string
  registered: boolean | null // null = not checked yet
}

/** The employer's team: every address seen in receipts or the current upload,
 * checked against the recipient registry. */
export function TeamPage({ extraEntries }: { extraEntries?: PayrollEntry[] }) {
  const [members, setMembers] = useState<Member[]>([])
  const [checking, setChecking] = useState(false)

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
    return [...byAddress.values()]
  }, [extraEntries])

  const checkAll = useCallback(async () => {
    const rosterNow = roster()
    setMembers(rosterNow)
    if (rosterNow.length === 0) return
    setChecking(true)
    try {
      const next = await Promise.all(
        rosterNow.map(async (m) => {
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
      <CardContent>
        {members.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No team yet — upload a payroll CSV or complete a run first.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-left text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 font-medium">Private receiving</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((m) => (
                  <tr key={m.address} className="bg-card">
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
