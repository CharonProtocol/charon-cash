// Browser prover engine: a pool of web workers running the wasm-arkworks
// prover behind the SDK's setProver hook, so payroll proofs are generated
// client-side on the standard transaction2 circuit -- no server proving, no
// snarkjs. The wasm prove() is synchronous and blocks its worker, so
// parallelism comes from the pool; size it to the machine's cores.
import { getBackendUrl, setProver, type ProverOverride } from "privacy-cash-sdk"
import { config } from "./config"
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
  /** Set when a slot actually dispatches the job — startedAt→dispatch is the
   *  in-pool queue wait, dispatch→reply the real service time. */
  dispatchedAt?: number
  resolve: (p: { proof: SnarkjsProof; publicSignals: string[] }) => void
  reject: (e: Error) => void
}

interface Slot {
  worker: Worker
  busy: PendingEntry | null
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

/** The exact JSON string the wasm prover (and the native helper) parse. */
function proverInputJson(input: Record<string, unknown>): string {
  const patched = input.extDataHash !== undefined
    ? { ...input, extDataHash: swapBytes32(input.extDataHash) }
    : input
  return JSON.stringify(bigintsToString(patched))
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
  // One queue for the whole pool: a proof goes to whichever worker frees up
  // first, so a slow (efficiency-core) worker never holds a backlog while a
  // fast one idles.
  private queue: PendingEntry[] = []
  private id = 1
  proveCount = 0
  proveTotalMs = 0
  serviceCount = 0
  serviceTotalMs = 0
  mode: "mt" | "st" = "st"
  threadsPerWorker = 1
  activeThreads = 0
  /** MT workers loaded the wide-arithmetic build (engine supports i64.mul_wide_u). */
  wide = false

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
        ? poolShape(workers, config.cores(), isolated)
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
          const d = m.data as { type?: string; threads?: number; wide?: boolean }
          if (d?.type === "ready") {
            w.removeEventListener("message", onMsg)
            if (d.threads) this.activeThreads += d.threads
            if (d.wide) this.wide = true
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
    this.slots = (await Promise.all(spawns)).map((worker) => ({ worker, busy: null }))
  }

  // ProverOverride shape: input already passed through utils.stringifyBigInts
  // by the SDK; resolves {proof, publicSignals}.
  prove(input: Record<string, unknown>): Promise<{ proof: SnarkjsProof; publicSignals: string[] }> {
    const entry: PendingEntry = {
      id: this.id++,
      inputJson: proverInputJson(input),
      startedAt: performance.now(),
      resolve: () => {},
      reject: () => {},
    }
    const promise = new Promise<{ proof: SnarkjsProof; publicSignals: string[] }>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    this.queue.push(entry)
    this.pump()
    return promise
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const next = this.queue.shift()
      if (!next) return
      slot.busy = next
      this.run(slot, next)
    }
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
        // The raw MT worker returns the wasm's compressed-hex output; the
        // bundled ST worker already applies the snarkjs conversion itself.
        const shaped = d.raw
          ? compressedToSnarkjs(d.raw)
          : { proof: d.proof as SnarkjsProof, publicSignals: d.publicSignals ?? [] }
        e.resolve(shaped)
      }
      else {
        // Local dev telemetry only: the error text, never the witness input
        // (it holds the note's private key, blinding and amounts).
        if (import.meta.env.DEV) {
          fetch(`${getBackendUrl()}/api/debug/prover-failure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: d.error ?? "", at: new Date().toISOString() }),
          }).catch(() => {})
        }
        e.reject(new Error(`wasm prover: ${d.error ?? "unknown"}`))
      }
      slot.busy = null
      this.pump()
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
  mode: "mt" | "st" | "native"
  /** Wide-arithmetic wasm build in use. */
  wide?: boolean
  threads: number
}

/** Number of prover workers for this machine. Each prove() saturates a core.
 * 8 logical cores (typically 4P+4E on Apple Silicon) get 6: the last two
 * workers land on efficiency cores and prove slower, but still add aggregate
 * throughput. Below that, stay conservative — the lanes and UI need headroom. */
function workerCount(): number {
  const cores = config.cores()
  return Math.max(2, Math.min(cores >= 8 ? 6 : 4, cores))
}

// Idempotent: fetches artifacts + spawns workers once, then installs the
// setProver hook. Concurrent callers share the same startup.
export function ensureBrowserProver(opts?: { workers?: number; mode?: "mt" | "st" }): Promise<BrowserProverInfo> {
  native = null
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
  return { workers: p.size(), avgMs: p.avgMs(), serviceMs: p.serviceMs(), proves: p.proveCount, mode: p.mode, threads: p.activeThreads, wide: p.wide }
}

export function browserProverInfo(): BrowserProverInfo | null {
  if (native) {
    return { workers: native.jobs, avgMs: native.count ? Math.round(native.totalMs / native.count) : 0,
      serviceMs: native.count ? Math.round(native.totalMs / native.count) : 0, proves: native.count, mode: "native", threads: 0 }
  }
  if (!pool) return null
  return info(pool)
}

// --- Native helper (crates/privacy-cash-prover `prover-server`) ------------
// Optional: same input JSON and compressed output as the wasm prover, proved
// natively on the employer's own machine (~3x faster per core). The witness
// holds note spend keys, so it is only ever sent to a helper the user paired
// with: the helper prints a pairing code, the user enters it in Settings, the
// helper must answer a fresh nonce with HMAC-SHA256(code, nonce) before each
// run, and every input is AES-GCM sealed to a key derived from the code — a
// squatter on the port (even one relaying the challenge) reads nothing.

export const NATIVE_PROVER_URL = "http://127.0.0.1:8790"
const TOKEN_KEY = "payroll:prover-token"

let native: { url: string; token: string; jobs: number; count: number; totalMs: number } | null = null

/** The pairing token the user gave the app (null = native helper off). */
export function nativeProverToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setNativeProverToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable: helper stays off */
  }
}

/** AES-256-GCM under SHA-256("charon-prover-v1:" + token): only the paired
 *  helper can read the witness, even if something relays the challenge. */
async function sealForHelper(token: string, plaintext: string): Promise<string> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`charon-prover-v1:${token}`))
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)))
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return JSON.stringify({ iv: hex(iv), ct: hex(ct) })
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * The paired helper's {url, token, jobs}, or null when no token is stored,
 * nothing answers, or the answer fails the HMAC challenge (not our helper).
 */
export async function detectNativeProver(
  token: string | null = nativeProverToken(),
  url: string = NATIVE_PROVER_URL,
  timeoutMs = 400,
): Promise<{ url: string; token: string; jobs: number } | null> {
  if (!token) return null
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/health?nonce=${nonce}`, { signal: ctl.signal })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; jobs?: number; mac?: string }
    if (!body.ok || body.mac !== (await hmacHex(token, nonce))) return null
    return { url, token, jobs: Math.max(1, Number(body.jobs) || 1) }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Route every SDK proof to the native helper. */
export function useNativeProver(helper: { url: string; token: string; jobs: number }): BrowserProverInfo {
  native = { url: helper.url, token: helper.token, jobs: helper.jobs, count: 0, totalMs: 0 }
  const n = native
  setProver(async (input) => {
    const t = performance.now()
    const res = await fetch(`${n.url}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await sealForHelper(n.token, proverInputJson(input)),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`native prover: ${text.slice(0, 300)}`)
    const out = compressedToSnarkjs(JSON.parse(text))
    n.count++
    n.totalMs += performance.now() - t
    return out
  })
  return browserProverInfo()!
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
 *  whole machine. Queued runs (3+ lanes) are throughput-bound: on isolated
 *  pages with 8+ cores, 2-thread MT teams finish the most proofs per second
 *  (8-core M1, 2026-10-13: 4×2 MT 1.17-1.32 proofs/s vs 6×1 ST 1.01-1.23 and
 *  8×1 ST 1.06; 1×8 MT only 0.87 — one wide team spends its time
 *  coordinating). Smaller or non-isolated machines keep the ST pool. */
export function proverPlan(
  lanes: number,
  cores: number,
  isolated: boolean = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
): { mode: "mt" | "st"; workers: number } {
  if (lanes <= 1) return { mode: "mt", workers: 1 }
  if (lanes === 2) return { mode: "mt", workers: 2 }
  // 2-thread MT teams whenever threads are available: browsers that report
  // fewer cores than the machine has (Helium said 6 on an 8-core M1) used to
  // fall to the single-thread pool, which also skips the wide-arithmetic build
  if (isolated && cores >= 4) return { mode: "mt", workers: Math.min(8, Math.floor(cores / 2)) }
  return { mode: "st", workers: Math.max(2, Math.min(cores >= 8 ? 6 : 4, cores)) }
}

// Prove directly through the pool (bypasses the SDK's prove()); used by the
// browser smoke test and any caller that wants raw access.
export async function proveWithBrowserProver(input: Record<string, unknown>) {
  await ensureBrowserProver()
  return pool!.prove(input)
}
