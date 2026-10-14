import { describe, expect, it } from "vitest"
import { recommendLanes } from "./estimate"

describe("recommendLanes", () => {
  it("keeps small runs serial-ish and scales big runs with the prover teams", () => {
    expect(recommendLanes(5, 8)).toBe(2)
    expect(recommendLanes(30, 8)).toBe(4)
    expect(recommendLanes(100, 4)).toBe(8)
    expect(recommendLanes(100, 6)).toBe(8)
    expect(recommendLanes(100, 8)).toBe(8)
    expect(recommendLanes(100, 10)).toBe(8)
    expect(recommendLanes(100, 12)).toBe(12)
    expect(recommendLanes(100, 16)).toBe(16)
    expect(recommendLanes(100, 32)).toBe(16)
  })
})
