import { describe, expect, it } from "bun:test"
import BN from "bn.js"

import { splitDepositAmounts } from "../src/client"

describe("splitDepositAmounts", () => {
  it("halves sum to ext − fee, both halves positive", () => {
    const { half, rem } = splitDepositAmounts(new BN(10_000_000_003), new BN(0))
    expect(half.gtn(0)).toBe(true)
    expect(rem.gtn(0)).toBe(true)
    expect(half.add(rem).toString()).toBe("10000000003")
    // odd totals: the remainder carries the extra lamport (floor division)
    expect(rem.sub(half).lte(new BN(1))).toBe(true)
  })

  it("accounts for the deposit fee before splitting", () => {
    const { half, rem } = splitDepositAmounts(new BN(1000), new BN(10))
    expect(half.add(rem).toString()).toBe("990")
  })

  it("refuses totals too small to produce two spendable notes", () => {
    expect(() => splitDepositAmounts(new BN(1), new BN(0))).toThrow()
    expect(() => splitDepositAmounts(new BN(5), new BN(5))).toThrow()
  })
})
