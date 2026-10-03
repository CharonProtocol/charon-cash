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
}

export function clearAll(): void {
  localStorage.removeItem(KEY)
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
