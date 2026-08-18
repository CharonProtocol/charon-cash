import { PublicKey } from "@solana/web3.js"

import type { PayrollEntry } from "./types"

export const MAX_ENTRIES = 200

export type ParseResult =
  | { ok: true; entries: PayrollEntry[] }
  | { ok: false; errors: string[] }

function isValidPubkey(s: string): boolean {
  try {
    const k = new PublicKey(s)
    return PublicKey.isOnCurve(k.toBytes())
  } catch {
    return false
  }
}

function normalizeAmount(v: unknown, row: number, errors: string[]): string | null {
  const n = typeof v === "number" ? v : Number(v)
  if (v === undefined || v === null || v === "" || Number.isNaN(n) || !Number.isFinite(n)) {
    errors.push(`row ${row}: amount "${String(v)}" is not a number`)
    return null
  }
  if (n <= 0) {
    errors.push(`row ${row}: amount must be greater than zero (got ${n})`)
    return null
  }
  return String(v)
}

/** RFC-lite CSV line split: honors double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (c === "," && !inQuotes) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

function finalize(entries: PayrollEntry[], errors: string[]): ParseResult {
  if (entries.length > MAX_ENTRIES)
    errors.push(`file has ${entries.length} entries; maximum is ${MAX_ENTRIES} per run`)
  const seen = new Map<string, number>()
  entries.forEach((e, i) => {
    const prior = seen.get(e.address)
    if (prior !== undefined)
      errors.push(`row ${i + 1}: duplicate address (already at row ${prior}) — merge the rows and re-upload`)
    else seen.set(e.address, i + 1)
  })
  return errors.length ? { ok: false, errors } : { ok: true, entries }
}

export function parsePayrollFile(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, errors: ["file is empty"] }
  const errors: string[] = []
  const entries: PayrollEntry[] = []

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] }
    }
    const rows: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { payments?: unknown[] }).payments)
        ? (parsed as { payments: unknown[] }).payments
        : []
    if (!rows.length)
      return {
        ok: false,
        errors: ['JSON must be an array or { "payments": [ ... ] }'],
      }
    rows.forEach((raw, i) => {
      const row = i + 1
      const r = raw as { address?: unknown; amount?: unknown; memo?: unknown }
      const address = typeof r.address === "string" ? r.address.trim() : ""
      if (!address || !isValidPubkey(address)) {
        errors.push(`row ${row}: address "${address || String(r.address)}" is not a valid Solana pubkey`)
      }
      const amountHuman = normalizeAmount(r.amount, row, errors)
      const memo = typeof r.memo === "string" && r.memo.trim() ? r.memo.trim() : undefined
      if (address && amountHuman) entries.push({ address, amountHuman, memo })
    })
    return finalize(entries, errors)
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "")
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  if (header.join(",") !== "address,amount,memo" && header.join(",") !== "address,amount") {
    return {
      ok: false,
      errors: [`CSV header must be "address,amount,memo" (memo optional), got: ${lines[0]}`],
    }
  }
  const wantMemo = header.length === 3
  lines.slice(1).forEach((line, i) => {
    const row = i + 2
    const f = splitCsvLine(line)
    if (f.length < 2 || (!wantMemo && f.length > 2) || (wantMemo && f.length > 3)) {
      errors.push(`row ${row}: expected ${wantMemo ? "3" : "2 or 3"} columns, got ${f.length}`)
      return
    }
    const [address, amountRaw, memo] = f
    if (!isValidPubkey(address))
      errors.push(`row ${row}: address "${address}" is not a valid Solana pubkey`)
    const amountHuman = normalizeAmount(amountRaw, row, errors)
    if (address && amountHuman)
      entries.push({ address, amountHuman, memo: memo || undefined })
  })
  return finalize(entries, errors)
}

export async function hashFileBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function validateDecimals(entries: PayrollEntry[], decimals: number): string[] {
  const errors: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const frac = entries[i].amountHuman.split(".")[1] ?? ""
    if (frac.length > decimals)
      errors.push(
        `row ${i + 1}: amount ${entries[i].amountHuman} has ${frac.length} decimals; this asset allows ${decimals}`,
      )
  }
  return errors
}

/** Exact string->bigint conversion; throws on anything malformed. */
export function toRaw(human: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(human.trim())
  if (!m) throw new Error(`bad amount: ${human}`)
  const whole = m[1]
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals + 1)
  if (frac.length > decimals) throw new Error(`too many decimals in ${human}`)
  return BigInt(whole + frac)
}
