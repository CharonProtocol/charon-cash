// Browser prover engine: a pool of web workers running the wasm-arkworks
// prover behind the SDK's setProver hook, so payroll proofs are generated
// client-side on the standard transaction2 circuit -- no server proving, no
// snarkjs. The wasm prove() is synchronous and blocks its worker, so
// parallelism comes from the pool; size it to the machine's cores.
import { setProver, type ProverOverride } from "privacy-cash-sdk"

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

  async start(workers: number): Promise<void> {
    const zkey = await (await fetch("/circuit/transaction2.zkey")).arrayBuffer()
    const graph = await (await fetch("/prover-wasm/transaction2.graph")).arrayBuffer()
    const spawns = Array.from({ length: workers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(new URL("./browserProverWorker.ts", import.meta.url), {
          type: "module",
        })
        const onMsg = (m: MessageEvent) => {
          if ((m.data as { type?: string })?.type === "ready") {
            w.removeEventListener("message", onMsg)
            resolve(w)
          } else if ((m.data as { type?: string })?.type === "fatal") {
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
        w.postMessage({ type: "init", zkey: zkey.slice(0), graph: graph.slice(0) })
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
      const d = m.data as { type?: string; id?: number; error?: string; proof?: unknown; publicSignals?: string[] }
      if (d?.id !== e.id || (d.type !== "proof" && d.type !== "error")) return
      slot.worker.removeEventListener("message", onMsg)
      this.proveCount++
      this.proveTotalMs += performance.now() - e.startedAt
      if (d.type === "proof") e.resolve({ proof: d.proof as SnarkjsProof, publicSignals: d.publicSignals ?? [] })
      else e.reject(new Error(`wasm prover: ${d.error ?? "unknown"}`))
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
export function ensureBrowserProver(): Promise<BrowserProverInfo> {
  if (pool) {
    return Promise.resolve({ workers: pool.size(), avgMs: pool.avgMs(), proves: pool.proveCount })
  }
  if (!starting) {
    starting = (async () => {
      const p = new BrowserProverPool()
      await p.start(workerCount())
      const override: ProverOverride = (input) => p.prove(input)
      setProver(override)
      pool = p
    })()
    starting.catch(() => {
      starting = null
    })
  }
  return starting.then(() => ({
    workers: pool!.size(),
    avgMs: pool!.avgMs(),
    proves: pool!.proveCount,
  }))
}

export function browserProverInfo(): BrowserProverInfo | null {
  if (!pool) return null
  return { workers: pool.size(), avgMs: pool.avgMs(), proves: pool.proveCount }
}

// Prove directly through the pool (bypasses the SDK's prove()); used by the
// browser smoke test and any caller that wants raw access.
export async function proveWithBrowserProver(input: Record<string, unknown>) {
  await ensureBrowserProver()
  return pool!.prove(input)
}
