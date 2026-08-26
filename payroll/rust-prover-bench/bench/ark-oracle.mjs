// validate the arkworks server's snarkjs-format proof against the ceremony vk
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { groth16 } from "snarkjs"

const BIN = "/Users/singupallikartik/Developer/chat/privacy-cash/payroll/rust-prover-bench/target/release/prover-server"
const CIRCUIT = "/Users/singupallikartik/Developer/chat/privacy-cash/programs/privacy-cash/artifacts/circuits/transaction2"
const vk = JSON.parse(readFileSync(CIRCUIT.replace(/transaction2$/, "") + "verifyingkey2.json", "utf8"))

const input = JSON.parse(readFileSync("/Users/singupallikartik/Developer/chat/privacy-cash/payroll/rust-prover-bench/fixtures/input.json", "utf8"))

async function tryOrder(g2mode) {
  const child = spawn(BIN, [], { env: { ...process.env, ARK_G2: g2mode, ARK_THREADS: "4" } })
  let buf = ""
  const lines = []
  const onLine = (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
  child.stdout.on("data", onLine)
  child.stderr.on("data", () => {})
  const waitReady = new Promise(r => child.stdout.once("data", r))
  await waitReady
  const t0 = Date.now()
  child.stdin.write(JSON.stringify({ id: 1, input }) + "\n")
  const resp = await new Promise((resolve) => {
    const poll = setInterval(() => {
      const found = lines.find(l => { try { return JSON.parse(l).id === 1 } catch { return false } })
      if (found) { clearInterval(poll); resolve(JSON.parse(found)) }
    }, 20)
  })
  const ms = Date.now() - t0
  child.kill()
  if (!resp.ok) return { g2mode, ok: false, error: resp.error, ms }
  const v = await groth16.verify(vk, resp.publicSignals, resp.proof)
  return { g2mode, verified: v, ms, witnessMs: resp.witnessMs, nPubs: resp.publicSignals.length }
}

for (const mode of ["c0c1", "c1c0"]) {
  console.log(JSON.stringify(await tryOrder(mode)))
}
