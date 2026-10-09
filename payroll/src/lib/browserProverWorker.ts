// One wasm-arkworks prover per web worker. Receives the zkey and witness
// graph once from the pool (fetched a single time on the main thread), then
// proves on demand. Proofs come back as the wasm prover's compressed hex
// (32/64/32) and pass through untouched — the SDK feeds them straight to
// the program, no snarkjs-shape detour.
import { default as init, WasmProver } from "./prover-wasm/privacy_cash_prover.js"

interface InitMessage {
  type: "init"
  zkey: ArrayBuffer
  graph: ArrayBuffer
  /** Unused here; the threaded build runs from /prover-mt-worker.mjs. */
  mode?: "mt" | "st"
  threads?: number
}
interface ProveMessage {
  type: "prove"
  id: number
  inputJson: string
}
type WorkerMessage = InitMessage | ProveMessage

let prover: WasmProver | null = null

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data
  if (msg.type === "init") {
    try {
      await init("/prover-wasm/privacy_cash_prover_bg.wasm")
      prover = new WasmProver(new Uint8Array(msg.zkey), new Uint8Array(msg.graph))
      self.postMessage({ type: "ready", threads: 1 })
    } catch (err) {
      self.postMessage({ type: "fatal", error: String((err as Error)?.message ?? err) })
    }
    return
  }
  if (msg.type === "prove") {
    if (!prover) {
      self.postMessage({ type: "error", id: msg.id, error: "worker not initialized" })
      return
    }
    try {
      const out = JSON.parse(prover.prove(msg.inputJson)) as {
        proof_a: string
        proof_b: string
        proof_c: string
        public_signals: string[]
      }
      self.postMessage({
        type: "proof",
        id: msg.id,
        proof: { proof_a: out.proof_a, proof_b: out.proof_b, proof_c: out.proof_c },
        publicSignals: out.public_signals ?? [],
      })
    } catch (err) {
      // Local telemetry: ship the exact failing circuit input to the shim so
      // multi-lane proof failures can be diagnosed offline.
      self.postMessage({
        type: "error",
        id: msg.id,
        error: String((err as Error)?.message ?? err),
        input: msg.inputJson,
      })
    }
  }
}
