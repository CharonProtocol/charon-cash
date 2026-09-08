// v1 transaction smoke test — proves the chain accepts v1 wire bytes before a
// bench run. Sends a 2-instruction SystemProgram transfer packed into ONE v1
// transaction via the repo builder (v1-tx.mjs) and checks it landed.
//
// Requires: surfpool started with --feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4
// Run: bun run-v1-smoke.mjs [rpcUrl]

import { buildV1Tx, parseV1Tx } from "./v1-tx.mjs"
import { Keypair, SystemProgram } from "@solana/web3.js"

const RPC = process.argv[2] ?? process.env.RPC ?? "http://127.0.0.1:8899"
const rpc = (m, p) =>
  fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  })
    .then(r => r.json())
    .then(j => { if (j.error) throw new Error(JSON.stringify(j.error)); return j.result })

const payer = Keypair.generate()
const to = Keypair.generate().publicKey
const airdrop = await rpc("requestAirdrop", [payer.publicKey.toBase58(), 1_000_000_000])
for (let i = 0; i < 40; i++) {
  const s = await rpc("getSignatureStatuses", [[airdrop]])
  if (s.value[0]?.confirmationStatus) break
  await new Promise(r => setTimeout(r, 250))
}
const { value: { blockhash } } = await rpc("getLatestBlockhash", [])

// two transfers in one v1 tx (dedupe check: payer+to appear in both)
const transfer = lamports => {
  const data = new Uint8Array(12)
  new DataView(data.buffer).setUint32(0, 2, true)
  new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true)
  return data
}
const ixs = [1_000_000, 2_000_000].map(lamports => ({
  programId: SystemProgram.programId.toBase58(),
  accounts: [
    { address: payer.publicKey.toBase58(), role: 3 }, // writable signer
    { address: to.toBase58(), role: 1 },              // writable
  ],
  data: transfer(lamports),
}))

const { bytes, size, signature } = buildV1Tx(payer, blockhash, ixs, {
  cuLimit: 150_000,
  loadedDataSize: 64 * 1024 * 1024,
})
const back = parseV1Tx(Buffer.from(bytes))
console.log(`built v1 tx: ${size}B, ${back.instructions.length} ixs, sig ${signature.slice(0, 12)}…`)

const sent = await rpc("sendTransaction", [
  Buffer.from(bytes).toString("base64"),
  { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
])
if (sent !== signature) throw new Error(`RPC signature mismatch: ${sent} != ${signature}`)
let status = null
for (let i = 0; i < 40; i++) {
  const s = await rpc("getSignatureStatuses", [[sent]])
  if (s.value[0]) { status = s.value[0]; break }
  await new Promise(r => setTimeout(r, 250))
}
if (!status || status.err) throw new Error("v1 tx did not land: " + JSON.stringify(status?.err ?? "timeout"))
const bal = (await rpc("getBalance", [to.toBase58()])).value
if (bal !== 3_000_000) throw new Error(`recipient balance ${bal} != 3_000_000`)
console.log("v1 SMOKE OK: 2 packed instructions executed, recipient got 3_000_000 lamports")
