import { describe, expect, it } from "vitest"

import { poolShape, proverPlan } from "./browserProver"

describe("prover pool shape", () => {
  it("splits MT cores so every worker keeps at least 2 threads", () => {
    expect(poolShape(2, 8, true)).toEqual({ count: 2, threadsPerWorker: 4 })
    expect(poolShape(1, 8, true)).toEqual({ count: 1, threadsPerWorker: 8 })
    expect(poolShape(8, 8, true)).toEqual({ count: 4, threadsPerWorker: 2 })
    expect(poolShape(6, 8, false)).toEqual({ count: 6, threadsPerWorker: 1 })
  })

  it("picks the proven ST pool for queued runs, MT only for 1-2 lanes", () => {
    // 1-2 lanes = latency: one MT team on all cores
    expect(proverPlan(1, 4)).toEqual({ mode: "mt", workers: 1 })
    expect(proverPlan(2, 4)).toEqual({ mode: "mt", workers: 2 })
    // queued throughput on the user's 4-core machine: the field-measured
    // Oct-4 fast build (4 × 1 thread, ST) did 2m21s while 1×4 MT did 3m55s
    // and 2×2 MT did 3m48s — independent workers beat rayon team splits
    expect(proverPlan(8, 4)).toEqual({ mode: "st", workers: 4 })
    expect(proverPlan(100, 4)).toEqual({ mode: "st", workers: 4 })
    // 8 cores get 6 ST workers (efficiency cores add aggregate throughput)
    expect(proverPlan(8, 8)).toEqual({ mode: "st", workers: 6 })
    expect(proverPlan(32, 24)).toEqual({ mode: "st", workers: 6 })
  })
})
