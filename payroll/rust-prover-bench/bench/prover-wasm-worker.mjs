// One wasm-arkworks prover per worker thread. Loads the glue, wasm module,
// zkey and witness graph once at startup, then answers prove requests.
// Each proof comes back decompressed into the snarkjs shape the SDK's
// parseProofToBytesArray consumes, so setProver can hand it straight through.
import { parentPort } from "node:worker_threads"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))

const { initSync, WasmProver } = await import(join(HERE, "prover-wasm/privacy_cash_prover.js"))
initSync({
  module: new WebAssembly.Module(
    readFileSync(join(HERE, "prover-wasm/privacy_cash_prover_bg.wasm")),
  ),
})

const zkey = new Uint8Array(readFileSync(join(HERE, "../../public/circuit/transaction2.zkey")))
const graph = new Uint8Array(readFileSync(join(HERE, "prover-wasm/transaction2.graph")))
const prover = new WasmProver(zkey, graph)

const { compressedToSnarkjs } = await import(join(HERE, "groth16-decompress.mjs"))

parentPort.on("message", ({ id, inputJson }) => {
  try {
    const out = JSON.parse(prover.prove(inputJson))
    const { proof, publicSignals } = compressedToSnarkjs(out)
    parentPort.postMessage({ id, ok: true, proof, publicSignals })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) })
  }
})
parentPort.postMessage({ id: 0, ok: true, ready: true })
