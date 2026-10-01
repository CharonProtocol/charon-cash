// Real-engine 210-salary E2E, paid for by the BROWSER prover engine: proofs
// come from the wasm-arkworks prover (sdk/prover-wasm in v2, vendored here as
// prover-wasm/) behind the SDK's setProver hook -- no server-side proving, no
// snarkjs. Workers run in a pool sized for the box (each prove() is
// synchronous and blocks its thread). Everything else is the standard
// PayrollEngine flow on the local simnet stack (surfpool + wrangler :8787).
// Usage: bun --smol run-e2e-wasm.mjs [rows] [lanes] [workers]

const BACKEND = "http://127.0.0.1:8787"
const RPC = "http://127.0.0.1:8899"
const PROGRAM_ID = "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr"
const ROWS = Number(process.argv[2] ?? 210)
const LANES = Number(process.argv[3] ?? 8)
const WORKERS = Number(process.argv[4] ?? 4)

globalThis.localStorage = {
  getItem: () => JSON.stringify({ backendUrl: BACKEND, rpcUrl: RPC }),
  setItem: () => {},
  removeItem: () => {},
}

import { readFileSync } from "node:fs"
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import nacl from "tweetnacl"
import {
  PrivacyCashClient,
  setCircuitBuffers,
  setBackendUrl,
  setProver,
  fetchTreeState,
  unspentNotes,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"
import { PayrollEngine } from "../../src/lib/engine.ts"
import { WasmProverPool } from "./wasm-prover-pool.mjs"

async function engine_waitIndexed(tree, leaf) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const st = await fetchTreeState(tree)
      if (st.nextLeafIndex > leaf) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("not indexed in 30s")
}
async function engine_confirm(sig) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
      const st = value?.[0]
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true
      if (st?.err) return false
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const CIRCUIT_DIR = new URL("../../public/circuit/", import.meta.url).pathname

function localSigner(kp) {
  return {
    publicKey: kp.publicKey,
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: async (tx) => {
      if (typeof tx.partialSign === "function") tx.partialSign(kp)
      else tx.sign([kp])
      return tx
    },
  }
}

const t0 = performance.now()
const el = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`

const conn = new Connection(RPC, "confirmed")
setBackendUrl(BACKEND)
setCircuitBuffers(
  new Uint8Array(readFileSync(`${CIRCUIT_DIR}/transaction2.wasm`)),
  new Uint8Array(readFileSync(`${CIRCUIT_DIR}/transaction2.zkey`)),
)

console.log(`spawning ${WORKERS} wasm prover workers...`)
const pool = await WasmProverPool.create(WORKERS)
setProver(async (input) => pool.prove(input))
console.log(`[${el()}] prover pool ready (wasm-arkworks, ${WORKERS} workers)`)

const treasurer = Keypair.generate()
let bal = await conn.getBalance(treasurer.publicKey)
if (bal < 5 * LAMPORTS_PER_SOL) {
  const sig = await conn.requestAirdrop(treasurer.publicKey, 20 * LAMPORTS_PER_SOL)
  await conn.confirmTransaction(sig, "confirmed")
}
console.log(`[${el()}] treasurer ${treasurer.publicKey.toBase58()} funded ${await conn.getBalance(treasurer.publicKey)}`)

const client = new PrivacyCashClient(localSigner(treasurer), new PublicKey(PROGRAM_ID))
await client.init()
await client.unlock()

const entries = Array.from({ length: ROWS }, (_, i) => ({
  address: Keypair.generate().publicKey.toBase58(),
  amountHuman: "0.01",
  memo: `emp-${i}`,
}))

let lastDone = 0
const failedSeen = new Set()
const engine = new PayrollEngine({
  client,
  listNotes: (asset) =>
    unspentNotes(client.publicKey)
      .filter((n) => n.mintAddress === WRAPPED_SOL_MINT)
      .map((n) => ({ id: n.id, amount: n.amount, blinding: n.blinding })),
  waitUntilIndexed: engine_waitIndexed,
  confirmSignature: engine_confirm,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
})
const p = engine.run(
  {
    fileHash: "ab".repeat(32),
    asset: { kind: "sol" },
    entries,
    bps: 100,
    vaultRaw: 0n,
    mode: "public",
    lanes: LANES,
  },
  (s) => {
    const done = s.rows.filter((r) => ["confirmed", "confirming", "failed"].includes(r.status)).length
    if (done - lastDone >= 20 || (done > 0 && done === ROWS)) {
      lastDone = done
      const proving = s.rows.filter((r) => r.status === "proving").length
      const st = pool.stats()
      console.log(`[${el()}] paying: ${done}/${ROWS} done, ${proving} proving, proves=${st.proves} avg=${st.avgMs}ms max=${st.maxMs}ms`)
    }
    for (const r of s.rows) {
      if (r.status === "failed" && !failedSeen.has(r.memo)) {
        failedSeen.add(r.memo)
        console.log(`    ROW FAILED memo=${r.memo}: ${r.error}`)
      }
    }
  },
)
const receipt = await p
const sent = receipt.summary.sent
const failed = receipt.summary.failed
const totalSec = (performance.now() - t0) / 1000
const st = pool.stats()

// spot-check 10 recipients got paid publicly
let paid = 0
for (const e of receipt.entries.filter((x) => x.status === "sent").slice(0, 10)) {
  const b = await conn.getBalance(new PublicKey(e.address))
  if (b > 0) paid++
}
console.log(`\n=== RESULT (local simnet, ${ROWS} rows, ${LANES} lanes, wasm prover x${WORKERS}) ===`)
console.log(`sent=${sent} failed=${failed} total=${receipt.summary.total}`)
console.log(`funding: ${receipt.funding ? Number(receipt.funding.depositedRaw) / 1e9 + " SOL" : "none"}`)
console.log(`proofs: ${st.proves} prove-bucket=${(st.totalMs / 1000).toFixed(1)}s avg=${st.avgMs}ms max=${st.maxMs}ms`)
console.log(`total wall: ${totalSec.toFixed(1)}s  -> ${(ROWS / totalSec).toFixed(1)} rows/s`)
console.log(`spot-check: ${paid}/10 recipients hold SOL`)
if (failed > 0) console.log("failures:", receipt.entries.filter((e) => e.status === "failed").slice(0, 5).map((e) => e.error))
await pool.close()
process.exit(failed > 0 || paid < Math.min(10, sent) ? 1 : 0)
