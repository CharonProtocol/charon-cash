import { toRaw } from "./parse"
import type { PayrollEntry } from "./types"

/** Relayer fee for a gross amount: ceil(gross * bps / 10_000) — mirrors withdrawInternal. */
export function feeFor(gross: bigint, bps: number): bigint {
  if (bps <= 0) return 0n
  return (gross * BigInt(bps) + 9_999n) / 10_000n
}

/**
 * Smallest gross such that gross - feeFor(gross, bps) === net.
 * Start from the closed-form estimate, then walk to the exact fixed point.
 */
export function solveGross(net: bigint, bps: number): bigint {
  if (bps <= 0) return net
  let g = (net * 10_000n + BigInt(10_000 - bps) - 1n) / BigInt(10_000 - bps)
  while (g - feeFor(g, bps) > net) g -= 1n
  while (g - feeFor(g, bps) < net) g += 1n
  return g
}

export interface RunPlanRow {
  address: string
  memo?: string
  net: bigint
  gross: bigint
  fee: bigint
}

export interface RunPlan {
  rows: RunPlanRow[]
  totalNet: bigint
  totalGross: bigint
  totalFees: bigint
  margin: bigint
  vaultRaw: bigint
  shortfall: bigint
}

export function planRun(
  entries: PayrollEntry[],
  decimals: number,
  bps: number,
  vaultRaw: bigint,
): RunPlan {
  const rows = entries.map((e) => {
    const net = toRaw(e.amountHuman, decimals)
    const gross = solveGross(net, bps)
    return { address: e.address, memo: e.memo, net, gross, fee: feeFor(gross, bps) }
  })
  const totalNet = rows.reduce((s, r) => s + r.net, 0n)
  const totalGross = rows.reduce((s, r) => s + r.gross, 0n)
  const totalFees = rows.reduce((s, r) => s + r.fee, 0n)
  const maxGross = rows.reduce((m, r) => (r.gross > m ? r.gross : m), 0n)
  const margin = feeFor(maxGross, bps)
  const shortfall = totalGross + margin > vaultRaw ? totalGross + margin - vaultRaw : 0n
  return { rows, totalNet, totalGross, totalFees, margin, vaultRaw, shortfall }
}
