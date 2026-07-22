// End-to-end test of the REAL button flow: PrivacyCashClient (the class the UI
// uses) deposit -> withdraw, through the backend shim + surfpool.
// Run: VITE_BACKEND_URL=http://localhost:8080 bun scripts/test-client-flow.mjs
import { readFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

// localStorage shim for Node (browser has it natively)
const _store = new Map()
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => void _store.set(k, String(v)),
  removeItem: (k) => void _store.delete(k),
}

import nacl from "tweetnacl"
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"

import { PrivacyCashClient, setCircuitBuffers } from "@privacy-cash/client"

// load circuit from disk (browser fetches /circuit/*; Node can't fetch relative)
const cdir = path.join(import.meta.dirname, "..", "..", "privacy-cash-sdk", "circuit2")
setCircuitBuffers(
  new Uint8Array(readFileSync(path.join(cdir, "transaction2.wasm"))),
  new Uint8Array(readFileSync(path.join(cdir, "transaction2.zkey"))),
)

const idJson = path.join(homedir(), ".config/solana/id.json")
// fresh wallet per run (so it has its own note set)
const kp = Keypair.generate()
const conn = new Connection("http://localhost:8899", "confirmed")
// fund it
const air = await conn.requestAirdrop(kp.publicKey, 2_000_000_000)
await conn.confirmTransaction(air)
console.log("wallet:", kp.publicKey.toBase58(), "funded")

const signer = {
  publicKey: kp.publicKey,
  signMessage: (m) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)),
  signTransaction: async (tx) => { tx.sign([kp]); return tx },
}

const client = new PrivacyCashClient(conn, signer, new PublicKey("5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P"))

console.log("\n--- DEPOSIT ---")
const dep = await client.depositSOL(0.05 * 1e9)
console.log("deposit:", dep)

// give the backend a moment to index the new deposit
await new Promise((r) => setTimeout(r, 3000))
console.log("private balance:", (Number(client.getPrivateBalanceSOL()) / 1e9).toFixed(6), "SOL")

console.log("\n--- WITHDRAW ---")
const wd = await client.withdrawSOL(0.05 * 1e9, kp.publicKey)
console.log("withdraw:", wd)
console.log("\n✅ client deposit -> withdraw worked through the backend")
