// Times the wasm prover outside the browser (same .wasm the Worker loads).
//   node sdk/bench/prove-timing.mjs     # V8, the engine in Chrome/Brave/Edge
//   bun  sdk/bench/prove-timing.mjs     # JavaScriptCore, the engine in Safari
// Prints load time, then cold + warm prove times for each fixture.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import init, { WasmProver } from "../prover-wasm/privacy_cash_prover.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const circuits = path.join(root, "programs/privacy-cash/artifacts/circuits")
const fixtures = path.join(root, "crates/privacy-cash-prover/tests/fixtures")
const runs = Number(process.env.RUNS ?? 5)
const engine = typeof Bun !== "undefined" ? `bun ${Bun.version} (JavaScriptCore)` : `node ${process.version} (V8)`

const ms = (t) => Math.round(performance.now() - t)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

let t = performance.now()
const wasm = await init({ module_or_path: readFileSync(path.join(root, "sdk/prover-wasm/privacy_cash_prover_bg.wasm")) })
const instantiate = ms(t)
const memMB = () => (wasm.memory.buffer.byteLength / 2 ** 20).toFixed(0)

const zkey = readFileSync(path.join(circuits, "transaction2.zkey"))
const graph = readFileSync(path.join(circuits, "transaction2.graph"))
t = performance.now()
const prover = new WasmProver(zkey, graph)
const parse = ms(t)

console.log(`engine: ${engine}`)
console.log(`wasm instantiate: ${instantiate} ms, zkey+graph parse: ${parse} ms, wasm memory ${memMB()} MB`)
for (const name of ["deposit", "withdraw", "spl"]) {
  const input = readFileSync(path.join(fixtures, `${name}_circuit.json`), "utf8")
  const times = []
  for (let i = 0; i < runs; i++) {
    t = performance.now()
    JSON.parse(prover.prove(input))
    times.push(ms(t))
  }
  console.log(`${name.padEnd(8)} prove: first ${times[0]} ms, median ${median(times)} ms over ${runs}`)
}
// Linear memory only grows, so this is the peak.
console.log(`wasm memory after proving: ${memMB()} MB`)
