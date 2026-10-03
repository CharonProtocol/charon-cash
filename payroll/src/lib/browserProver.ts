// Browser prover engine: a pool of web workers running the wasm-arkworks
// prover behind the SDK's setProver hook, so payroll proofs are generated
// client-side on the standard transaction2 circuit -- no server proving, no
// snarkjs. The wasm prove() is synchronous and blocks its worker, so
// parallelism comes from the pool; size it to the machine's cores.
import { getBackendUrl, setProver, type ProverOverride } from "privacy-cash-sdk"
import { compressedToSnarkjs } from "./groth16-decompress"

// Mirrors the snarkjs Proof shape from privacy-cash-sdk/src/prover (the SDK
// exports ProverOverride but not the Proof type itself).
interface SnarkjsProof {
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
  protocol: string
  curve: string
}

interface PendingEntry {
  id: number
  inputJson: string
  startedAt: number
  resolve: (p: { proof: SnarkjsProof; publicSignals: string[] }) => void
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
  mode: "mt" | "st" = "st"
  threadsPerWorker = 1
  activeThreads = 0

  async start(workers: number): Promise<void> {
    const zkey = await (await fetch("/circuit/transaction2.zkey")).arrayBuffer()
    const graph = await (await fetch("/prover-wasm/transaction2.graph")).arrayBuffer()
    // Threaded build when the page is cross-origin isolated: each mt worker
    // runs a rayon pool, so fewer workers, each splitting the cores. A proof
    // then takes 0.6-0.9s on all cores instead of ~3.7s on one — big for
    // 1-lane latency, on par at high lane counts.
    const isolated =
      typeof SharedArrayBuffer !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    const cores = navigator.hardwareConcurrency || 4
    // MT: fewer workers, each with a slice of the cores (2 workers × 4 on an
    // 8-core machine) — one proof uses its worker's whole slice, so 1-lane
    // latency drops to ~a second while 2 proofs still run in parallel.
    const count = isolated ? Math.max(1, Math.min(workers, Math.max(1, Math.floor(cores / 3)))) : workers
    this.threadsPerWorker = isolated ? Math.max(2, Math.floor(cores / count)) : 1
    this.mode = isolated ? "mt" : "st"
    const spawns = Array.from({ length: count }, () =>
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
  prove(input: Record<string, unknown>): Promise<{ proof: SnarkjsProof; publicSignals: string[] }> {
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
    const promise = new Promise<{ proof: SnarkjsProof; publicSignals: string[] }>((resolve, reject) => {
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
      if (d.type === "proof") {
        // The raw MT worker returns the wasm's compressed-hex output; the
        // bundled ST worker already applies the snarkjs conversion itself.
        const shaped = d.raw
          ? compressedToSnarkjs(d.raw)
          : { proof: d.proof as SnarkjsProof, publicSignals: d.publicSignals ?? [] }
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
    slot.worker.postMessage({ type: "prove", id: e.id, inputJson: e.inputJson })
  }

  avgMs(): number {
    return this.proveCount ? Math.round(this.proveTotalMs / this.proveCount) : 0
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
export function ensureBrowserProver(opts?: { workers?: number }): Promise<BrowserProverInfo> {
  // A run can request a specific pool shape (1 lane → 1 worker with ALL
  // cores); re-init when the live pool doesn't match.
  if (pool && opts?.workers !== undefined && pool.size() !== opts.workers) {
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
      // MT default = ONE worker owning all cores (the v2_prover branch's
      // shape): proofs queue through it at ~0.6-0.9s each regardless of
      // lanes. ST (non-isolated pages) keeps one worker per core.
      const mt = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
      await p.start(mt ? 1 : opts?.workers ?? workerCount())
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
  return { workers: p.size(), avgMs: p.avgMs(), proves: p.proveCount, mode: p.mode, threads: p.activeThreads }
}

export function browserProverInfo(): BrowserProverInfo | null {
  if (!pool) return null
  return info(pool)
}

// Prove directly through the pool (bypasses the SDK's prove()); used by the
// browser smoke test and any caller that wants raw access.
export async function proveWithBrowserProver(input: Record<string, unknown>) {
  await ensureBrowserProver()
  return pool!.prove(input)
}
