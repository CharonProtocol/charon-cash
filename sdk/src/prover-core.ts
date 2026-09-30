import type { WasmProver } from "../prover-wasm/privacy_cash_prover.js"

import type { CircuitArtifacts } from "./circuit-artifacts"

/** Anything wasm-bindgen's `init` accepts: a URL, a Response, or raw bytes. */
export type ProverWasmSource = URL | string | Response | BufferSource | WebAssembly.Module

export interface WasmProverOptions {
  /** Single-threaded wasm bytes or URL; forces the single-threaded build. */
  wasm?: ProverWasmSource
  /** Max rayon threads for the threaded build; `1` forces single-threaded. Default: all cores. */
  threads?: number
}

export interface LoadedProver {
  prover: WasmProver
  /** Threads the prover actually runs on (1 = single-threaded build). */
  threads: number
  /** Why the threaded build was tried and not used, if it was. */
  threadError?: string
}

type Glue = typeof import("../prover-wasm/privacy_cash_prover.js")
type LoadedGlue = { mod: Glue; threads: number; threadError?: string }

let glue: Promise<LoadedGlue> | null = null

/**
 * Threads need SharedArrayBuffer, which browsers only expose to cross-origin
 * isolated pages (COOP `same-origin` + COEP `require-corp`), and a Worker
 * constructor to spawn rayon's threads from.
 */
function threadBudget(requested?: number): number {
  if (requested !== undefined && requested <= 1) return 1
  const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number } }
  if (!g.crossOriginIsolated || typeof SharedArrayBuffer === "undefined" || typeof Worker === "undefined") {
    return 1
  }
  const cores = Math.max(1, g.navigator?.hardwareConcurrency ?? 1)
  return Math.min(requested ?? cores, cores)
}

async function loadGlue(opts: WasmProverOptions): Promise<LoadedGlue> {
  const budget = opts.wasm === undefined ? threadBudget(opts.threads) : 1
  let threadError: string | undefined
  if (budget > 1) {
    try {
      const mt = await import("../prover-wasm-mt/privacy_cash_prover.js")
      await mt.default()
      await mt.initThreadPool(budget)
      return { mod: mt as unknown as Glue, threads: mt.proverThreads() }
    } catch (e) {
      threadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }
  const st = await import("../prover-wasm/privacy_cash_prover.js")
  await st.default(opts.wasm === undefined ? undefined : { module_or_path: opts.wasm })
  return { mod: st, threads: 1, threadError }
}

/**
 * Instantiates the prover wasm (once per realm; threaded when the page allows
 * it) and parses the proving key and witness graph. Keep the returned prover.
 */
export async function createWasmProver(
  artifacts: CircuitArtifacts,
  opts: WasmProverOptions = {},
): Promise<LoadedProver> {
  glue ??= loadGlue(opts).catch((e) => {
    glue = null
    throw e
  })
  const { mod, threads, threadError } = await glue
  return { prover: new mod.WasmProver(artifacts.zkey, artifacts.graph), threads, threadError }
}

export type { WasmProver }
