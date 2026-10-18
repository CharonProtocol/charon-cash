import { WRAPPED_SOL_MINT, type RelayerInfo } from "privacy-cash-sdk"

import type { Asset } from "./types"

export const SOL_ASSET: Asset = { kind: "sol" }

/** Token pools the relayer runs, labeled ones only: an unlabeled test mint
 * never shows up as a payroll option. */
export function tokenAssets(info: RelayerInfo): Asset[] {
  return info.supportedMints
    .filter((m) => m.symbol && typeof m.decimals === "number")
    .map((m) => ({ kind: "spl", mint: m.mint, decimals: m.decimals!, symbol: m.symbol }))
}

export function assetMint(a: Asset): string {
  return a.kind === "sol" ? WRAPPED_SOL_MINT : a.mint
}

export function assetDecimals(a: Asset): number {
  return a.kind === "sol" ? 9 : a.decimals
}

export function assetSymbol(a: Asset): string {
  return a.kind === "sol" ? "SOL" : (a.symbol ?? `${a.mint.slice(0, 4)}…`)
}

/** Stable key for selection state and per-asset buckets. */
export function assetKey(a: Asset): string {
  return a.kind === "sol" ? "sol" : a.mint
}

/** Display amount: `digits` decimals at most (SOL 4, USDC 4 -> 2 visible
 * cents rule is the caller's), with the asset's symbol. */
export function formatAmount(raw: bigint, a: Asset, digits = 4): string {
  const d = assetDecimals(a)
  return `${(Number(raw) / 10 ** d).toFixed(Math.min(digits, d))} ${assetSymbol(a)}`
}
