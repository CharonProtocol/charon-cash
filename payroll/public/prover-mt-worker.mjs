// Raw (un-bundled) module worker for the threaded wasm prover. Served as a
// static file so the wasm-bindgen-rayon snippet can self-spawn thread
// workers relative to its own URL — bundlers break that resolution.
import init, { initThreadPool, WasmProver } from "./prover-wasm-mt/privacy_cash_prover.js"

let prover = null

self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === "init") {
    try {
      await init()
      await initThreadPool(msg.threads ?? navigator.hardwareConcurrency)
      prover = new WasmProver(new Uint8Array(msg.zkey), new Uint8Array(msg.graph))
      self.postMessage({ type: "ready", threads: msg.threads ?? 0 })
    } catch (err) {
      self.postMessage({ type: "fatal", error: String(err?.message ?? err) })
    }
    return
  }
  if (msg.type === "prove") {
    if (!prover) {
      self.postMessage({ type: "error", id: msg.id, error: "worker not initialized" })
      return
    }
    try {
      // Raw wasm output {proof_a, proof_b, proof_c, public_signals}; the pool
      // decompresses to the snarkjs shape on the main thread.
      const out = JSON.parse(prover.prove(msg.inputJson))
      self.postMessage({ type: "proof", id: msg.id, raw: out })
    } catch (err) {
      self.postMessage({
        type: "error",
        id: msg.id,
        error: String(err?.message ?? err),
        input: msg.inputJson,
      })
    }
  }
}
