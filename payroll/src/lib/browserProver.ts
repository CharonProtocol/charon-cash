// Browser prover engine: a pool of web workers running the wasm-arkworks
// prover behind the SDK's setProver hook, so payroll proofs are generated
// client-side on the standard transaction2 circuit -- no server proving, no
// snarkjs. The wasm prove() is synchronous and blocks its worker, so
// parallelism comes from the pool; size it to the machine's cores.
import { getBackendUrl, setProver, type ProverOverride } from "privacy-cash-sdk"

// Mirrors the snarkjs Proof shape from privacy-cash-sdk/src/prover (the SDK
// exports ProverOverride but not the Proof type itself). The wasm prover
// returns the compressed hex shape, which passes through to the SDK as-is.
interface SnarkjsProof {
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
  protocol: string
  curve: string
}

interface CompressedProofWire {
  proof_a: string
  proof_b: string
  proof_c: string
}

type ProverProof = SnarkjsProof | CompressedProofWire

interface PendingEntry {
  id: number
  inputJson: string
  startedAt: number
  /** Set when a slot actually dispatches the job — startedAt→dispatch is the
   *  in-pool queue wait, dispatch→reply the real service time. */
  dispatchedAt?: number
  resolve: (p: { proof: ProverProof; publicSignals: string[] }) => void
  reject: (e: Error) => void
}

interface Slot {
  worker: Worker
  busy: PendingEntry | null
  pending: PendingEntry[]
}

// The v2 wasm parser reads extDataHash little-endian (pad_be then
// from_bytes_le = byte-swap); every other 32-byte input is big-endian. The
// SDK hands us the hash as a plain bigint, so pre-swap it here; the wasm's
// internal swap then restores the true value as the circuit signal.
function swapBytes32(v: unknown): bigint {
  const h = typeof v === "bigint" ? v : BigInt(v as string | number)
  let out = 0n
  for (let i = 0; i < 32; i++) out = (out << 8n) | ((h >> BigInt(8 * i)) & 0xffn)
  return out
}

function bigintsToString(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString(10)
  if (Array.isArray(v)) return v.map(bigintsToString)
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) o[k] = bigintsToString(val)
    return o
  }
  return v
}

class BrowserProverPool {
  private slots: Slot[] = []
  private next = 0
  private id = 1
  proveCount = 0
  proveTotalMs = 0
  serviceCount = 0
  serviceTotalMs = 0
  mode: "mt" | "st" = "st"
  threadsPerWorker = 1
  activeThreads = 0

  async start(workers: number, modeOverride?: "mt" | "st"): Promise<void> {
    const zkey = await (await fetch("/circuit/transaction2.zkey")).arrayBuffer()
    const graph = await (await fetch("/prover-wasm/transaction2.graph")).arrayBuffer()
    // Threaded build when the page is cross-origin isolated: each mt worker
    // runs a rayon pool, splitting the cores — good for 1-2 lane latency.
    // Queued runs (8+ lanes) instead run independent single-thread workers:
    // same busy-core count as a team split, zero rayon coordination, and the
    // only field-measured fast wall (2m21s/100) came from exactly that shape.
    const isolated =
      typeof SharedArrayBuffer !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    const mode = modeOverride ?? (isolated ? "mt" : "st")
    const shape =
      mode === "mt"
        ? poolShape(workers, navigator.hardwareConcurrency || 4, isolated)
        : { count: Math.max(1, workers), threadsPerWorker: 1 }
    this.threadsPerWorker = shape.threadsPerWorker
    this.mode = mode
    const spawns = Array.from({ length: shape.count }, () =>
      new Promise<Worker>((resolve, reject) => {
        // MT workers come from a RAW static module (/prover-mt-worker.mjs):
        // the rayon snippet self-spawns relative to its own URL, which only
        // resolves for un-bundled files. ST keeps the bundled worker.
        const w =
          this.mode === "mt"
            ? new Worker("/prover-mt-worker.mjs", { type: "module" })
            : new Worker(new URL("./browserProverWorker.ts", import.meta.url), {
                type: "module",
              })
        const onMsg = (m: MessageEvent) => {
          const d = m.data as { type?: string; threads?: number }
          if (d?.type === "ready") {
            w.removeEventListener("message", onMsg)
            if (d.threads) this.activeThreads += d.threads
            resolve(w)
          } else if (d?.type === "fatal") {
            reject(new Error((m.data as { error?: string }).error ?? "prover worker died"))
          }
        }
        w.addEventListener("message", onMsg)
        w.addEventListener(
          "error",
          () => reject(new Error("prover worker failed to start")),
          { once: true },
        )
        // structured clone gives each worker its own copy of the artifacts
        w.postMessage({ type: "init", zkey: zkey.slice(0), graph: graph.slice(0), mode: this.mode, threads: this.threadsPerWorker })
      }),
    )
    this.slots = (await Promise.all(spawns)).map((worker) => ({ worker, busy: null, pending: [] }))
  }

  // ProverOverride shape: input already passed through utils.stringifyBigInts
  // by the SDK; resolves {proof, publicSignals}.
  prove(input: Record<string, unknown>): Promise<{ proof: ProverProof; publicSignals: string[] }> {
    const patched = input.extDataHash !== undefined
      ? { ...input, extDataHash: swapBytes32(input.extDataHash) }
      : input
    const slot = this.slots[this.next++ % this.slots.length]
    const entry: PendingEntry = {
      id: this.id++,
      inputJson: JSON.stringify(bigintsToString(patched)),
      startedAt: performance.now(),
      resolve: () => {},
      reject: () => {},
    }
    const promise = new Promise<{ proof: ProverProof; publicSignals: string[] }>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (slot.busy) slot.pending.push(entry)
    else {
      slot.busy = entry
      this.run(slot, entry)
    }
    return promise
  }

  private run(slot: Slot, e: PendingEntry) {
    const onMsg = (m: MessageEvent) => {
      const d = m.data as { type?: string; id?: number; error?: string; input?: string; proof?: unknown; raw?: { proof_a: string; proof_b: string; proof_c: string; public_signals: string[] }; publicSignals?: string[] }
      if (d?.id !== e.id || (d.type !== "proof" && d.type !== "error")) return
      slot.worker.removeEventListener("message", onMsg)
      this.proveCount++
      this.proveTotalMs += performance.now() - e.startedAt
      if (e.dispatchedAt !== undefined) {
        this.serviceCount++
        this.serviceTotalMs += performance.now() - e.dispatchedAt
      }
      if (d.type === "proof") {
        // Both worker flavors return the wasm's compressed-hex output; it
        // passes through untouched and the SDK feeds it straight to the
        // program's decompress syscalls.
        const shaped = d.raw
          ? {
              proof: {
                proof_a: d.raw.proof_a,
                proof_b: d.raw.proof_b,
                proof_c: d.raw.proof_c,
              },
              publicSignals: d.raw.public_signals ?? [],
            }
          : { proof: d.proof as ProverProof, publicSignals: d.publicSignals ?? [] }
        e.resolve(shaped)
      }
      else {
        // Local telemetry: dump the failing witness input to the shim so
        // multi-lane proof failures can be diagnosed offline.
        if (d.input) {
          fetch(`${getBackendUrl()}/api/debug/prover-failure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: d.error ?? "", input: d.input, at: new Date().toISOString() }),
          }).catch(() => {})
        }
        e.reject(new Error(`wasm prover: ${d.error ?? "unknown"}`))
      }
      const next = slot.pending.shift()
      slot.busy = next ?? null
      if (next) this.run(slot, next)
    }
    slot.worker.addEventListener("message", onMsg)
    e.dispatchedAt = performance.now()
    slot.worker.postMessage({ type: "prove", id: e.id, inputJson: e.inputJson })
  }

  avgMs(): number {
    return this.proveCount ? Math.round(this.proveTotalMs / this.proveCount) : 0
  }

  serviceMs(): number {
    return this.serviceCount ? Math.round(this.serviceTotalMs / this.serviceCount) : 0
  }

  size(): number {
    return this.slots.length
  }

  async stop(): Promise<void> {
    await Promise.all(this.slots.map((s) => s.worker.terminate()))
    this.slots = []
  }
}

let pool: BrowserProverPool | null = null
let starting: Promise<void> | null = null

export interface BrowserProverInfo {
  workers: number
  avgMs: number
  /** Mean dispatch→reply time — the actual proof math, slot-queue wait excluded. */
  serviceMs: number
  proves: number
  mode: "mt" | "st"
  threads: number
}

/** Number of prover workers for this machine. Each prove() saturates a core.
 * 8 logical cores (typically 4P+4E on Apple Silicon) get 6: the last two
 * workers land on efficiency cores and prove slower, but still add aggregate
 * throughput. Below that, stay conservative — the lanes and UI need headroom. */
function workerCount(): number {
  const cores = navigator.hardwareConcurrency || 4
  return Math.max(2, Math.min(cores >= 8 ? 6 : 4, cores))
}

// Idempotent: fetches artifacts + spawns workers once, then installs the
// setProver hook. Concurrent callers share the same startup.
export function ensureBrowserProver(opts?: { workers?: number; mode?: "mt" | "st" }): Promise<BrowserProverInfo> {
  // A run can request a specific pool shape (proverPlan); re-init when the
  // live pool doesn't match it — size or engine mode.
  if (
    pool &&
    opts?.workers !== undefined &&
    (pool.size() !== opts.workers || (opts.mode !== undefined && pool.mode !== opts.mode))
  ) {
    const restart = pool
      .stop()
      .then(() => {
        pool = null
        starting = null
        return ensureBrowserProver(opts)
      })
      .finally(() => void restart)
    return restart
  }
  if (pool) {
    return Promise.resolve(info(pool))
  }
  if (!starting) {
    starting = (async () => {
      const p = new BrowserProverPool()
      // No explicit request → latency default: ONE MT worker owning all
      // cores on isolated pages, the ST pool otherwise. Runs always pass
      // proverPlan's {workers, mode} and reach start() verbatim.
      const mt = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
      await p.start(opts?.workers ?? (mt ? 1 : workerCount()), opts?.mode)
      const override: ProverOverride = (input) => p.prove(input)
      setProver(override)
      pool = p
    })()
    starting.catch(() => {
      starting = null
    })
  }
  return starting.then(() => info(pool!))
}

function info(p: BrowserProverPool): BrowserProverInfo {
  return { workers: p.size(), avgMs: p.avgMs(), serviceMs: p.serviceMs(), proves: p.proveCount, mode: p.mode, threads: p.activeThreads }
}

export function browserProverInfo(): BrowserProverInfo | null {
  if (!pool) return null
  return info(pool)
}

/** Turn a requested worker count into the concrete pool shape. Threaded
 *  pages split the cores so every worker keeps ≥2 threads (8 cores never
 *  yield more than 4×2); single-threaded pages run one worker per slot. */
export function poolShape(
  requested: number,
  cores: number,
  isolated: boolean,
): { count: number; threadsPerWorker: number } {
  if (!isolated) return { count: Math.max(1, requested), threadsPerWorker: 1 }
  const count = Math.max(1, Math.min(requested, Math.floor(cores / 2)))
  return { count, threadsPerWorker: Math.max(2, Math.floor(cores / count)) }
}

/** Prover engine plan for a run with `lanes` parallel chains on `cores`
 *  logical cores. 1-2 lanes are latency-bound → MT teams that split the
 *  whole machine. Queued runs (3+ lanes waiting) are throughput-bound → the
 *  ST pool of independent single-thread workers: the Oct-4 field baseline
 *  (2m21s/100 rows) ran that shape, while both MT splits measured on the
 *  same 4-core machine were slower (1×4 MT = 3m55s, 2×2 MT = 3m48s) — rayon
 *  team splits cost coordination and win nothing when proofs queue. */
export function proverPlan(lanes: number, cores: number): { mode: "mt" | "st"; workers: number } {
  if (lanes <= 1) return { mode: "mt", workers: 1 }
  if (lanes === 2) return { mode: "mt", workers: 2 }
  return { mode: "st", workers: Math.max(2, Math.min(cores >= 8 ? 6 : 4, cores)) }
}

// Prove directly through the pool (bypasses the SDK's prove()); used by the
// browser smoke test and any caller that wants raw access.
export async function proveWithBrowserProver(input: Record<string, unknown>) {
  await ensureBrowserProver()
  return pool!.prove(input)
}
