// Drives the backend-only PrivacyCashClient through SOL deposit + withdraw on surfpool.
// The SDK talks ONLY to the backend (shim on :8080). The Connection below is test-
// harness funding only — PrivacyCashClient itself makes NO rpc calls.
// Run: PROGRAM_ID=... bun scripts/sdk-e2e.mjs
import { readFileSync } from "node:fs"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import nacl from "tweetnacl"
import { PrivacyCashClient, setBackendUrl, setCircuitBuffers } from "privacy-cash-sdk"

// Polyfill localStorage — the SDK persists notes (browser API, absent in node).
const _ls = new Map()
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)) },
  removeItem: (k) => { _ls.delete(k) },
  clear: () => _ls.clear(),
}

const RPC = "http://localhost:8899"
const BACKEND = "http://localhost:8080"
const PROGRAM = process.env.PROGRAM_ID ?? "5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P"
setBackendUrl(BACKEND)

// Browser fetches /circuit/...; in node we preload the proving circuit from disk.
setCircuitBuffers(
  new Uint8Array(readFileSync("public/circuit/transaction2.wasm")),
  new Uint8Array(readFileSync("public/circuit/transaction2.zkey")),
)

// ---- test wallet (this Connection funds the wallet; the SDK never uses it) ----
const fundConn = new Connection(RPC, "confirmed")
const kp = Keypair.generate()
console.log("test wallet:", kp.publicKey.toBase58())
await fundConn.confirmTransaction(await fundConn.requestAirdrop(kp.publicKey, 5e9), "confirmed")
console.log("funded 5 SOL")

const signer = {
  publicKey: kp.publicKey,
  signMessage: async (msg) => nacl.sign.detached(new Uint8Array(msg), kp.secretKey),
  signTransaction: async (tx) => { tx.sign([kp]); return tx },
}

const client = new PrivacyCashClient(signer, new PublicKey(PROGRAM))
await client.unlock()
console.log("unlocked — spending key derived client-side")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitBalance(target) {
  for (let i = 0; i < 40; i++) {
    await client.syncNotes("sol").catch(() => {})
    const b = client.getPrivateBalanceSOL()
    if (b >= target) return b
    await sleep(1500)
  }
  return client.getPrivateBalanceSOL()
}

const AMT = 2_000_000_000 // 2 SOL (enough for two 0.5 withdrawals + change)
console.log("\n— DEPOSIT 2 SOL —")
const dep = await client.depositSOL(AMT)
console.log("deposit signature:", dep.signature, "leafIndex:", dep.leafIndex)

console.log("\n— SYNC + BALANCE —")
const bal = await waitBalance(BigInt(AMT))
console.log("private balance (lamports):", bal.toString())
if (bal <= 0n) throw new Error("deposit not indexed / balance 0")

console.log("\n— WITHDRAW 0.5 SOL · gasless (relayer-signed, default relay=true) —")
const wd1 = await client.withdrawSOL(500_000_000, kp.publicKey)
console.log("gasless withdraw:", wd1.signature, " recipient got:", wd1.recipientLamports, " fee:", wd1.feeLamports)

await waitBalance(1_000_000_000n) // wait for the change note to index before the next spend

console.log("\n— WITHDRAW 0.5 SOL · client-signed (relay:false → /api/relayer/submit) —")
const wd2 = await client.withdrawSOL(500_000_000, kp.publicKey, { relay: false })
console.log("client-signed withdraw:", wd2.signature, " recipient got:", wd2.recipientLamports, " fee:", wd2.feeLamports)

console.log("\n✅ PASSED: deposit + BOTH withdraw modes (gasless relayer-signed + client-signed broadcast) via the merged backend-only SDK.")
