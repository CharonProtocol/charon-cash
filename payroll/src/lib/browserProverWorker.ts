// One wasm-arkworks prover per web worker. Receives the zkey and witness
// graph once from the pool (fetched a single time on the main thread), then
// proves on demand. Proofs come back decompressed into the snarkjs shape the
// SDK's parseProofToBytesArray consumes.
import { default as init, WasmProver } from "./prover-wasm/privacy_cash_prover.js"
import { compressedToSnarkjs } from "./groth16-decompress"

interface InitMessage {
  type: "init"
  zkey: ArrayBuffer
  graph: ArrayBuffer
  /** "mt" = threaded build (cross-origin isolated page); "st" = per-core build. */
  mode?: "mt" | "st"
  /** Rayon threads for the mt build (the pool splits cores across workers). */
  threads?: number
}
interface ProveMessage {
  type: "prove"
  id: number
  inputJson: string
}
type WorkerMessage = InitMessage | ProveMessage

let prover: WasmProver | null = null
let mtProve: ((inputJson: string) => string) | null = null

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data
  if (msg.type === "init") {
    try {
      if (msg.mode === "mt" && crossOriginIsolatedSafe()) {
        // Threaded build: rayon spawns real threads from this worker and one
        // proof uses them all (the branch's measured 0.6-0.9s per proof).
        // Lives in src/ (not /public) so Vite bundles it as a real module.
        const mt = (await import("./prover-wasm-mt/privacy_cash_prover.js")) as unknown as {
          default: () => Promise<unknown>
          initThreadPool: (n: number) => Promise<void>
          WasmProver: new (zkey: Uint8Array, graph: Uint8Array) => { prove: (input: string) => string }
        }
        await mt.default()
        const threads = Math.max(2, msg.threads ?? 2)
        await mt.initThreadPool(threads)
        const p = new mt.WasmProver(new Uint8Array(msg.zkey), new Uint8Array(msg.graph))
        mtProve = (input: string) => p.prove(input)
        self.postMessage({ type: "ready", threads })
      } else {
        await init("/prover-wasm/privacy_cash_prover_bg.wasm")
        prover = new WasmProver(new Uint8Array(msg.zkey), new Uint8Array(msg.graph))
        self.postMessage({ type: "ready", threads: 1 })
      }
    } catch (err) {
      self.postMessage({ type: "fatal", error: String((err as Error)?.message ?? err) })
    }
    return
  }
  if (msg.type === "prove") {
    if (!prover && !mtProve) {
      self.postMessage({ type: "error", id: msg.id, error: "worker not initialized" })
      return
    }
    try {
      const out = JSON.parse(mtProve ? mtProve(msg.inputJson) : prover!.prove(msg.inputJson))
      const { proof, publicSignals } = compressedToSnarkjs(out)
      self.postMessage({ type: "proof", id: msg.id, proof, publicSignals })
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

function crossOriginIsolatedSafe(): boolean {
  try {
    return typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  } catch {
    return false
  }
}
