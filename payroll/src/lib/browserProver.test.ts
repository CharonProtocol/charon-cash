import { afterEach, describe, expect, it, vi } from "vitest"

import { browserProverInfo, ensureBrowserProver, poolShape, proverPlan } from "./browserProver"

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

// The pool's "prove ≈ Xs" chip used to be a queue-inflated mean: a proof that
// waited for its slot reported the wait as prove time. These tests pin the
// split — startedAt→dispatch is the slot wait, dispatch→reply the service.
const capture = vi.hoisted(() => ({
  override: null as ((input: Record<string, unknown>) => Promise<unknown>) | null,
}))

vi.mock("privacy-cash-sdk", () => ({
  setProver: (fn: (input: Record<string, unknown>) => Promise<unknown>) => {
    capture.override = fn
  },
  getBackendUrl: () => "http://test",
}))

describe("prover pool service accounting", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("splits slot wait from pure service time on a queued proof", async () => {
    class FakeWorker {
      static delays: number[] = []
      private listeners = new Map<string, Array<(m: { data: unknown }) => void>>()
      constructor(public url: string | URL) {}
      addEventListener(type: string, fn: (m: { data: unknown }) => void) {
        const fns = this.listeners.get(type) ?? []
        fns.push(fn)
        this.listeners.set(type, fns)
      }
      removeEventListener(type: string, fn: (m: { data: unknown }) => void) {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
      }
      postMessage(msg: { type?: string; id?: number }) {
        if (msg.type === "init") {
          queueMicrotask(() => this.emit({ type: "ready", threads: 1 }))
        } else if (msg.type === "prove") {
          const delay = FakeWorker.delays.shift() ?? 20
          setTimeout(
            () =>
              this.emit({
                type: "proof",
                id: msg.id,
                proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "groth16", curve: "bn128" },
                publicSignals: [],
              }),
            delay,
          )
        }
      }
      private emit(d: unknown) {
        for (const fn of this.listeners.get("message") ?? []) fn({ data: d })
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker)
    vi.stubGlobal("fetch", (async () => ({
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown)

    const info = await ensureBrowserProver({ workers: 1, mode: "st" })
    expect(info.workers).toBe(1)
    expect(capture.override).toBeTypeOf("function")

    // proof 1 owns the slot for ~120ms; proof 2 is called while the slot is
    // busy, waits the queue, then services in ~30ms. avgMs (startedAt→reply)
    // must carry proof 2's wait; serviceMs (dispatch→reply) must not.
    FakeWorker.delays = [120, 30]
    const [, r2] = await Promise.all([capture.override!({ a: 1 }), capture.override!({ a: 2 })])
    expect(r2).toMatchObject({ proof: { protocol: "groth16" } })

    const after = browserProverInfo()!
    expect(after.proves).toBe(2)
    expect(after.serviceMs).toBeGreaterThanOrEqual(45)
    expect(after.serviceMs).toBeLessThanOrEqual(115)
    expect(after.avgMs).toBeGreaterThan(after.serviceMs)
    expect(after.avgMs).toBeGreaterThanOrEqual(115)
  })
})
