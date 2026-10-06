/**
 * Web Worker that owns the wasm prover. The spend key and the rest of the
 * witness enter this worker and never leave the device; only the proof and
 * the public signals are posted back. On a cross-origin isolated page the
 * threaded build spawns its rayon threads from here.
 */
import { loadCircuitArtifacts } from "./circuit-artifacts.js"
import { createWasmProver, type LoadedProver } from "./prover-core.js"

export type ProverRequest =
  | { id: number; type: "init"; circuitBaseUrl: string; threads?: number }
  | { id: number; type: "prove"; circuitBaseUrl: string; threads?: number; input: string }

/** `init` answers with `{ threads, threadError? }` JSON as `result`; `prove` with the proof JSON. */
export type ProverResponse =
  | { id: number; ok: true; result?: string }
  | { id: number; ok: false; error: string }

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<ProverRequest>) => void) | null
  postMessage(msg: ProverResponse): void
}

let prover: Promise<LoadedProver> | null = null

function getProver(msg: ProverRequest): Promise<LoadedProver> {
  prover ??= loadCircuitArtifacts(msg.circuitBaseUrl)
    .then((artifacts) => createWasmProver(artifacts, { threads: msg.threads }))
    .catch((e) => {
      prover = null
      throw e
    })
  return prover
}

ctx.onmessage = async (ev) => {
  const msg = ev.data
  try {
    const p = await getProver(msg)
    if (msg.type === "init") {
      const info = { threads: p.threads, threadError: p.threadError }
      ctx.postMessage({ id: msg.id, ok: true, result: JSON.stringify(info) })
      return
    }
    ctx.postMessage({ id: msg.id, ok: true, result: p.prover.prove(msg.input) })
  } catch (e) {
    ctx.postMessage({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
