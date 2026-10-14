// Raw (un-bundled) module worker for the threaded wasm prover. Served as a
// static file so the wasm-bindgen-rayon snippet can self-spawn thread
// workers relative to its own URL — bundlers break that resolution.
//
// Engines that validate the wide-arithmetic proposal's i64.mul_wide_u (V8
// behind --experimental-wasm-wide-arithmetic today) get the build compiled
// with it: field multiplication stops emulating 64x64->128 with four 32-bit
// products. Everyone else loads the baseline build.
const WIDE_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  0x01, 0x08, 0x01, 0x60, 0x02, 0x7e, 0x7e, 0x02, 0x7e, 0x7e, // type: (i64 i64) -> (i64 i64)
  0x03, 0x02, 0x01, 0x00, // func 0: type 0
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x20, 0x00, 0x20, 0x01, 0xfc, 0x16, 0x0b, // local.get 0 1; i64.mul_wide_u
])
let wide = false
try {
  wide = WebAssembly.validate(WIDE_PROBE)
} catch {}
// Not awaited at top level: the pool posts "init" right after spawning, and a
// message that arrives before onmessage is installed is dropped.
const glue = import(wide ? "./prover-wasm-mt-wide/privacy_cash_prover.js" : "./prover-wasm-mt/privacy_cash_prover.js")

let prover = null

self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === "init") {
    try {
      const { default: init, initThreadPool, WasmProver } = await glue
      await init()
      await initThreadPool(msg.threads ?? navigator.hardwareConcurrency)
      prover = new WasmProver(new Uint8Array(msg.zkey), new Uint8Array(msg.graph))
      self.postMessage({ type: "ready", threads: msg.threads ?? 0, wide })
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
