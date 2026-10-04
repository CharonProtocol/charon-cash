import type { ParsedFile, RunMode } from "@/lib/types"

/** Preview-only fee math shared by the plan card and the settlement bar —
 *  full planning re-runs inside the engine. Mirrors per-row relayer-minimum
 *  flooring so the estimate matches what the engine will actually spend. */
export function estimateTotals(
  parsed: ParsedFile,
  decimals: number,
  bps: number,
  minTransferFee: number,
  mode: RunMode,
  floorSolOnly: boolean,
): { totalNet: bigint; totalFees: bigint } | null {
  const nets = parsed.entries.map((e) => ({
    net: BigInt(
      (e.amountHuman.split(".")[0] || "0") +
        ((e.amountHuman.split(".")[1] ?? "").padEnd(decimals, "0").slice(0, decimals)),
    ),
  }))
  const totalNet = nets.reduce((s, n) => s + n.net, 0n)
  const floor = floorSolOnly ? BigInt(minTransferFee) : 0n
  const totalFees =
    mode === "shielded"
      ? nets.reduce((s, n) => {
        let f = (n.net * BigInt(bps) + 9_999n) / 10_000n
        if (f < floor) f = floor
        return s + f
      }, 0n)
      : (totalNet * BigInt(bps) + 9_999n) / 10_000n
  return { totalNet, totalFees }
}
