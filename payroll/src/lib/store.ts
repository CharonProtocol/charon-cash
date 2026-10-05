import type { PayrollEntry, RunReceipt } from "./types"

const KEY = "payroll:history:v1"
const MAX_RUNS = 50

function revive(r: unknown): RunReceipt {
  const x = r as RunReceipt & {
    totalPlanned?: string | bigint
    funding?: { depositedRaw: string | bigint } | null
  }
  // Old or corrupted localStorage entries must never crash the history list
  // ("invalid BigInt syntax"): fall back to 0n and let listRuns callers see
  // the rest of the receipt.
  const big = (v: unknown): bigint => {
    try {
      return BigInt((v ?? 0n) as string | bigint)
    } catch {
      return 0n
    }
  }
  return {
    ...x,
    totalPlanned: big(x.totalPlanned),
    funding: x.funding ? {
      ...x.funding,
      depositedRaw: big(x.funding.depositedRaw)
    } : null
  }
}

function prepare(r: RunReceipt): unknown {
  return {
    ...r,
    totalPlanned: r.totalPlanned.toString(),
    funding: r.funding
      ? { ...r.funding, depositedRaw: r.funding.depositedRaw.toString() }
      : null,
  }
}

export function listRuns(): RunReceipt[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as RunReceipt[]
    if (!Array.isArray(arr)) return []
    return arr
      .map(revive)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function getRun(id: string): RunReceipt | null {
  return listRuns().find((r) => r.id === id) ?? null
}

export function saveRun(receipt: RunReceipt): void {
  const existing = listRuns().filter((r) => r.id !== receipt.id)
  const next = [receipt, ...existing]
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX_RUNS).map(prepare)))
  } catch {
    /* receiptless operation is acceptable; the UI warns once (App storage probe) */
  }
  emit(HISTORY_EVENT)
}

export function clearAll(): void {
  localStorage.removeItem(KEY)
  emit(HISTORY_EVENT)
}

export function failedEntriesOf(r: RunReceipt): PayrollEntry[] {
  return r.entries
    .filter((e) => e.status === "failed")
    .map((e) => ({ address: e.address, amountHuman: e.amountHuman, memo: e.memo }))
}

/** Probe localStorage availability once at startup for the UI warning banner. */
export function storageOk(): boolean {
  try {
    localStorage.setItem("payroll:probe", "1")
    localStorage.removeItem("payroll:probe")
    return true
  } catch {
    return false
  }
}

// --- synced employer docs ---------------------------------------------------
//
// The relayer DB holds one JSON doc per (wallet, key) — the run ledger
// ("history") and the manually added team roster ("team"). localStorage stays
// the offline cache and source of truth for reads; the sync layer (lib/sync.ts)
// pulls on connect, merges, and pushes changes back. Components subscribe to
// the change events so an adopted remote doc re-renders every open page.

const TEAM_KEY = "payroll:team-manual"
const TEAM_REMOVED_KEY = "payroll:team-removed"
export const HISTORY_EVENT = "payroll:history-changed"
export const TEAM_EVENT = "payroll:team-changed"

function emit(event: string): void {
  try {
    window.dispatchEvent(new Event(event))
  } catch {
    /* non-browser env (tests) */
  }
}

/** Serializable form of the run ledger — what goes over the wire. */
export function exportRunsDoc(): unknown {
  return listRuns().map(prepare)
}

export function listManualTeam(): PayrollEntry[] {
  try {
    const raw = localStorage.getItem(TEAM_KEY)
    const arr = raw ? (JSON.parse(raw) as PayrollEntry[]) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function listRemovedTeam(): string[] {
  try {
    const raw = localStorage.getItem(TEAM_REMOVED_KEY)
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

function saveRemoved(list: string[]): void {
  try {
    localStorage.setItem(TEAM_REMOVED_KEY, JSON.stringify(list))
  } catch {
    /* tombstones are a sync optimization; losing them only resurrects rows */
  }
}

/** Add teammate(s) locally and clear their removal tombstones (re-adding a
 *  previously removed address must stick). */
export function addManualTeam(entries: PayrollEntry | PayrollEntry[]): void {
  const list = Array.isArray(entries) ? entries : [entries]
  const current = listManualTeam()
  const removed = new Set(listRemovedTeam())
  const next = [...current]
  for (const e of list) {
    if (!e || typeof e.address !== "string") continue
    removed.delete(e.address)
    if (!next.some((m) => m.address === e.address)) next.push(e)
  }
  saveRemoved([...removed])
  saveManualTeam(next)
}

export function removeManualTeam(address: string): void {
  const next = listManualTeam().filter((m) => m.address !== address)
  const removed = listRemovedTeam()
  if (!removed.includes(address)) removed.push(address)
  saveRemoved(removed)
  saveManualTeam(next)
}

/** Serializable team doc — roster plus removal tombstones so a synced delete
 *  on any device stays deleted everywhere. */
export function exportTeamDoc(): unknown {
  return { entries: listManualTeam(), removed: listRemovedTeam() }
}

export function saveManualTeam(list: PayrollEntry[]): void {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(list))
  } catch {
    // storage unavailable — added members live only for this session
  }
  emit(TEAM_EVENT)
}

/** Merge a remote ledger doc into localStorage (union by run id, newer wins).
 *  Returns true when the local store changed. */
export function adoptRuns(remote: unknown): boolean {
  if (!Array.isArray(remote)) return false
  const byId = new Map<string, RunReceipt>()
  for (const r of listRuns()) byId.set(r.id, r)
  let changed = false
  for (const raw of remote) {
    const r = revive(raw)
    if (!r || typeof r.id !== "string") continue
    const cur = byId.get(r.id)
    if (!cur || (r.createdAt ?? 0) > (cur.createdAt ?? 0)) {
      byId.set(r.id, r)
      changed = true
    }
  }
  if (!changed) return false
  const merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RUNS)
  try {
    localStorage.setItem(KEY, JSON.stringify(merged.map(prepare)))
  } catch {
    return false
  }
  emit(HISTORY_EVENT)
  return true
}

/** Merge a remote team doc into localStorage: union by address, honoring both
 *  sides' removal tombstones. Returns true when the local store changed. */
export function adoptTeam(remote: unknown): boolean {
  const doc = remote as { entries?: unknown; removed?: unknown } | null
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.entries)) return false
  const removed = new Set(listRemovedTeam())
  let changed = false
  if (Array.isArray(doc.removed)) {
    for (const addr of doc.removed) {
      if (typeof addr === "string" && !removed.has(addr)) {
        removed.add(addr)
        changed = true
      }
    }
  }
  const kept = listManualTeam().filter((m) => {
    if (removed.has(m.address)) {
      changed = true
      return false
    }
    return true
  })
  const byAddress = new Map(kept.map((m) => [m.address, m]))
  for (const raw of doc.entries) {
    const e = raw as PayrollEntry
    if (!e || typeof e.address !== "string" || removed.has(e.address)) continue
    if (!byAddress.has(e.address)) {
      byAddress.set(e.address, e)
      changed = true
    }
  }
  if (!changed) return false
  saveRemoved([...removed])
  saveManualTeam([...byAddress.values()])
  return true
}

