import { describe, expect, it } from "vitest"

import { poolShape, recommendedWorkers } from "./browserProver"

describe("prover pool shape", () => {
  it("splits cores so every requested worker keeps at least 2 threads", () => {
    // the designed latency shape: 2 workers × 4 threads on 8 cores
    expect(poolShape(2, 8, true)).toEqual({ count: 2, threadsPerWorker: 4 })
    // throughput shape: 4 teams of 2
    expect(poolShape(4, 8, true)).toEqual({ count: 4, threadsPerWorker: 2 })
    // 1 lane: one worker owning everything
    expect(poolShape(1, 8, true)).toEqual({ count: 1, threadsPerWorker: 8 })
    // cannot give 8 workers 2 threads each on 8 cores — capped, never 1 thread
    expect(poolShape(8, 8, true)).toEqual({ count: 4, threadsPerWorker: 2 })
    // 24 threads go further
    expect(poolShape(6, 24, true)).toEqual({ count: 6, threadsPerWorker: 4 })
    // single-threaded pages: one worker per requested slot, 1 thread each
    expect(poolShape(6, 8, false)).toEqual({ count: 6, threadsPerWorker: 1 })
  })

  it("recommends the throughput shape for big runs on small machines", () => {
    // 1 lane → one worker with all cores (latency)
    expect(recommendedWorkers(1, 8, true)).toBe(1)
    // small runs → 2×4 (latency still matters)
    expect(recommendedWorkers(4, 8, true)).toBe(2)
    // 8+ lanes on 8 cores → 4 workers × 2 threads (throughput: the
    // field-measured 6×1 ST build did 2m21s; 1×8 MT does 3m55s)
    expect(recommendedWorkers(8, 8, true)).toBe(4)
    expect(recommendedWorkers(32, 8, true)).toBe(4)
    // the auto-scale intent survives on big machines: 6 from 24 lanes
    expect(recommendedWorkers(24, 24, true)).toBe(6)
    // never above what the cores can feed (≥2 threads per worker)
    expect(recommendedWorkers(32, 4, true)).toBe(2)
    // non-isolated pages keep the per-core pool
    expect(recommendedWorkers(8, 8, false)).toBe(6)
  })

  it("keeps the two functions consistent: any recommendation is a legal shape", () => {
    for (const cores of [4, 8, 12, 16, 24, 32]) {
      for (const lanes of [1, 2, 8, 12, 24, 32]) {
        const w = recommendedWorkers(lanes, cores, true)
        const s = poolShape(w, cores, true)
        expect(s.count).toBeGreaterThanOrEqual(1)
        expect(s.threadsPerWorker).toBeGreaterThanOrEqual(2)
        expect(s.count * s.threadsPerWorker).toBeLessThanOrEqual(cores)
      }
    }
  })
})
