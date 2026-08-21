import { describe, expect, it } from "vitest"
import { feeFor, planRun, solveGross } from "./fees"

describe("feeFor", () => {
  it("ceil-rounds like the SDK does", () => {
    expect(feeFor(1_000_000_000n, 100)).toBe(10_000_000n)
    expect(feeFor(1n, 100)).toBe(1n)
    expect(feeFor(0n, 100)).toBe(0n)
  })
})

describe("solveGross", () => {
  it("nets exactly at 0 bps", () => {
    expect(solveGross(123n, 0)).toBe(123n)
  })

  it("nets exactly for representative cases (property: gross - feeFor(gross) == net)", () => {
    const nets = [1n, 999n, 1_500_000_000n, 2_000_000_123n, 10n ** 15n]
    for (const bps of [0, 10, 50, 100, 250]) {
      for (const net of nets) {
        const g = solveGross(net, bps)
        expect(g - feeFor(g, bps)).toBe(net)
        expect(g).toBeGreaterThanOrEqual(net)
      }
    }
  })

  it("is minimal at 1 bps", () => {
    expect(solveGross(10_000n, 1)).toBe(10_002n)
  })
})

describe("planRun", () => {
  const entries = [
    { address: "A".repeat(32), amountHuman: "1.5" },
    { address: "B".repeat(32), amountHuman: "0.5", memo: "bonus" },
  ]

  it("computes totals, margin, and shortfall", () => {
    const p = planRun(entries, 9, 100, 1_000_000_000n)
    expect(p.rows).toHaveLength(2)
    const grossSum = p.rows.reduce((s, r) => s + r.gross, 0n)
    expect(p.totalGross).toBe(grossSum)
    expect(p.totalNet).toBe(2_000_000_000n)
    expect(p.margin).toBe(feeFor(1_515_151_516n, 100))
    expect(p.shortfall).toBe(p.totalGross + p.margin - 1_000_000_000n)
  })

  it("shortfall floors at zero when vault covers", () => {
    const p = planRun(entries, 9, 100, 10n ** 18n)
    expect(p.shortfall).toBe(0n)
  })

  it("shielded rows spend net + floored fee from vault notes", () => {
    // 0.0005 SOL = 500_000 raw; bps fee 5_000 floored to the 10_000 minimum
    const small = [{ address: "D".repeat(32), amountHuman: "0.0005" }]
    const p = planRun(small, 9, 100, 0n, { mode: "shielded", minTransferFee: 10_000 })
    expect(p.rows[0].net).toBe(500_000n)
    expect(p.rows[0].fee).toBe(10_000n)
    expect(p.rows[0].gross).toBe(510_000n)
    expect(p.margin).toBe(10_000n)
    expect(p.shortfall).toBe(520_000n)
  })

  it("shielded fees stay bps-exact above the floor", () => {
    const p = planRun(entries, 9, 100, 0n, { mode: "shielded", minTransferFee: 10_000 })
    // 1.5 SOL -> feeFor(net) = 15_000_000, well above the floor: no gross solve
    expect(p.rows[0].fee).toBe(15_000_000n)
    expect(p.rows[0].gross).toBe(1_515_000_000n)
    expect(p.margin).toBe(15_000_000n)
  })

  it("public planning is unchanged when a floor is supplied", () => {
    const a = planRun(entries, 9, 100, 1_000_000_000n)
    const b = planRun(entries, 9, 100, 1_000_000_000n, { mode: "public", minTransferFee: 10_000 })
    expect(b).toEqual(a)
  })
})
