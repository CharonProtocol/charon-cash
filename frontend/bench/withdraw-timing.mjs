// Times a full relayed SOL withdraw through PrivacyCashClient on a local stack
// (surfpool :8899 + backend shim), split into leaf sync, Merkle path, proof,
// and relay + confirmation. Proving runs in-thread with the same wasm the
// browser Worker loads.
//   cd frontend && BACKEND=http://localhost:8080 bun bench/withdraw-timing.mjs
import "../scripts/local-prover.mjs"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import nacl from "tweetnacl"
import {
  PrivacyCashClient, buildUnlockMessage, fetchTreeLeavesFrom, fetchTreeState, preloadProver,
  setBackendUrl,
} from "privacy-cash-sdk"

import { WasmProver } from "../../sdk/prover-wasm/privacy_cash_prover.js"

const _ls = new Map()
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)) },
  removeItem: (k) => { _ls.delete(k) },
  clear: () => _ls.clear(),
}

const RPC = process.env.RPC ?? "http://localhost:8899"
const BACKEND = process.env.BACKEND ?? "http://localhost:8080"
setBackendUrl(BACKEND)

const spans = {}
const add = (name, ms) => { spans[name] = (spans[name] ?? 0) + ms }
const time = async (name, fn) => {
  const t = performance.now()
  try { return await fn() } finally { add(name, performance.now() - t) }
}
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]))

const proveImpl = WasmProver.prototype.prove
WasmProver.prototype.prove = function (json) {
  const t = performance.now()
  try { return proveImpl.call(this, json) } finally { add("prove", performance.now() - t) }
}

const kp = Keypair.generate()
const conn = new Connection(RPC, "confirmed")
await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 3e9), "confirmed")
const signer = {
  publicKey: kp.publicKey,
  signMessage: async (msg) => nacl.sign.detached(new Uint8Array(msg), kp.secretKey),
  signTransaction: async (tx) => { tx.sign([kp]); return tx },
  signIn: async (input) => {
    const signedMessage = new TextEncoder().encode(buildUnlockMessage(input))
    return { signedMessage, signature: nacl.sign.detached(signedMessage, kp.secretKey) }
  },
}

const info = await (await fetch(`${BACKEND}/api/relayer/info`)).json()
const client = new PrivacyCashClient(signer, new PublicKey(info.program_id))
for (const m of ["syncNotes", "merkleForSpend"]) {
  const orig = client[m].bind(client)
  client[m] = (...a) => time(m, () => orig(...a))
}

let t = performance.now()
await client.unlock()
await preloadProver()
const unlockAndLoad = performance.now() - t

t = performance.now()
await client.depositSOL(1_000_000_000)
const deposit = { total: performance.now() - t, ...spans }
for (const k of Object.keys(spans)) delete spans[k]

// Let the indexer catch up with the deposit first, so the withdraw's Merkle
// step measures the leaf download + path build rather than indexer lag.
t = performance.now()
for (let i = 0; i < 80; i++) {
  const { nextLeafIndex } = await fetchTreeState("sol")
  const { leaves } = await fetchTreeLeavesFrom("sol", 0)
  if (leaves.length >= nextLeafIndex && client.getPrivateBalanceSOL() >= 1_000_000_000n) break
  await client.syncNotes("sol").catch(() => {})
  await new Promise((r) => setTimeout(r, 250))
}
const indexerLag = performance.now() - t
for (const k of Object.keys(spans)) delete spans[k]

t = performance.now()
const wd = await client.withdrawSOL(500_000_000, Keypair.generate().publicKey)
const total = performance.now() - t
const withdraw = {
  total,
  ...spans,
  "relay + confirmation + rest": total - (spans.syncNotes ?? 0) - (spans.merkleForSpend ?? 0) - (spans.prove ?? 0),
}

console.log(JSON.stringify({
  runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
  backend: BACKEND,
  poolLeaves: (await fetchTreeState("sol")).nextLeafIndex,
  unlockAndLoadMs: Math.round(unlockAndLoad),
  depositMs: round(deposit),
  waitForIndexerMs: Math.round(indexerLag),
  withdrawMs: round(withdraw),
  signature: wd.signature,
}, null, 2))
