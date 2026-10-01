// Pool of wasm-arkworks prover workers behind the SDK's setProver contract.
// The wasm prove() is synchronous and blocks a thread, so parallelism comes
// from a worker pool (browser prod uses the same shape via prover-wasm-mt).
// Input prep mirrors the SDK oracle: prove() receives utils.stringifyBigInts
// (input), which LE-decodes Uint8Arrays into plain bigints that JSON.stringify
// and the rust parser reject, so we finish with a bigint -> decimal walk here.
import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "prover-wasm-worker.mjs")

function bigintsToString(v) {
  if (typeof v === "bigint") return v.toString(10)
  if (Array.isArray(v)) return v.map(bigintsToString)
  if (v && typeof v === "object") {
    const o = {}
    for (const [k, val] of Object.entries(v)) o[k] = bigintsToString(val)
    return o
  }
  return v
}

// The v2 wasm parser reads extDataHash little-endian (pad_be then
// from_bytes_le = byte-swap), while every other 32-byte value is big-endian.
// Our SDK passes the hash as a plain bigint, so pre-swap it here; the wasm's
// internal swap then restores the true value as the circuit signal.
function swapBytes32(v) {
  const h = typeof v === "bigint" ? v : BigInt(v)
  let out = 0n
  for (let i = 0; i < 32; i++) out = (out << 8n) | ((h >> BigInt(8 * i)) & 0xffn)
  return out
}

export class WasmProverPool {
  constructor(workers) {
    // round-robin slots; each worker proves one input at a time and queues
    // the rest. Per-proof timing includes queue wait, which is the wall cost
    // the caller feels.
    this.slots = workers.map((worker) => ({ worker, busy: null, pending: [] }))
    this.next = 0
    this.id = 1
    this.proveCount = 0
    this.proveTotalMs = 0
    this.proveMaxMs = 0
  }

  static async create(count = 4) {
    const workers = await Promise.all(Array.from({ length: count }, () => WasmProverPool.spawn()))
    return new WasmProverPool(workers)
  }

  static spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER_PATH)
      const onMsg = (m) => {
        if (m?.ready) {
          w.off("message", onMsg)
          w.off("error", reject)
          resolve(w)
        }
      }
      w.once("error", reject)
      w.on("message", onMsg)
    })
  }

  // ProverOverride shape: input already passed through utils.stringifyBigInts
  // by the SDK; resolves {proof, publicSignals}.
  prove(input) {
    if (input.extDataHash !== undefined) {
      input = { ...input, extDataHash: swapBytes32(input.extDataHash) }
    }
    const slot = this.slots[this.next++ % this.slots.length]
    const entry = {
      id: this.id++,
      inputJson: JSON.stringify(bigintsToString(input)),
      startedAt: performance.now(),
    }
    const promise = new Promise((resolve, reject) => {
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

  run(slot, e) {
    const onMsg = (m) => {
      if (m?.id !== e.id) return
      slot.worker.off("message", onMsg)
      const ms = performance.now() - e.startedAt
      this.proveCount++
      this.proveTotalMs += ms
      if (ms > this.proveMaxMs) this.proveMaxMs = ms
      if (m.ok) e.resolve({ proof: m.proof, publicSignals: m.publicSignals })
      else e.reject(new Error(`wasm prover: ${m.error}`))
      const next = slot.pending.shift()
      slot.busy = next ?? null
      if (next) this.run(slot, next)
    }
    slot.worker.on("message", onMsg)
    slot.worker.postMessage({ id: e.id, inputJson: e.inputJson })
  }

  stats() {
    return {
      proves: this.proveCount,
      totalMs: Math.round(this.proveTotalMs),
      avgMs: this.proveCount ? Math.round(this.proveTotalMs / this.proveCount) : 0,
      maxMs: Math.round(this.proveMaxMs),
    }
  }

  async close() {
    await Promise.all(this.slots.map((s) => s.worker.terminate()))
  }
}
