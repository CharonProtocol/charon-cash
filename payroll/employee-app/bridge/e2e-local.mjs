// Local E2E for the employee app: drives the REAL built bridge bundle
// (bridge/dist/bridge.html) in a browser-ish harness, stubbing the
// ReactNativeWebView channel exactly like the RN layer does (signMessage /
// signTransaction round-trips), and walks the employee flow against the local
// surfpool chain:
//
//   registered=false -> enableReceiving (3 sigs) -> registered=true
//   deposit 2 SOL (direct signer) -> unlock -> refresh -> balance
//   claim 1 SOL (withdrawSOL, gasless via relayer) -> balances verified
//
// Prereqs:
//   1. Fresh local stack:  zsh payroll/rust-prover-bench/bench/reset-env.sh
//      (the workers indexer only decodes 1-1 Transact txs; any earlier batch3
//      smoke txs on the chain leave the D1 mirror behind and later 1-1
//      deposits fail UnknownRoot -- so start from a reset chain.)
//   2. bun install && bun run build:bridge   (in this folder)
//
// Run:  bun bridge/e2e-local.mjs
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Keypair, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"

const REPO = fileURLToPath(new URL("../../..", import.meta.url)) // payroll/employee-app/bridge -> repo
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:8787" // the real backend: its D1 mirror is chain-true
const ADMIN_PW = () =>
  readFileSync(REPO + "/workers/.dev.vars", "utf8").match(/ADMIN_PASSWORD=(.*)/)[1].trim()

// ---- tiny circuit host: the SDK fetches "/circuit/transaction2.{wasm,zkey}"
// (relative) and the bridge rewrites those onto circuitBase ----
const CIRCUIT_DIR = REPO + "programs/privacy-cash/artifacts/circuits"
const circuitServer = Bun.serve({
  port: 0,
  fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/circuit\/(transaction2\.(wasm|zkey))$/)
    if (!m) return new Response("not found", { status: 404 })
    return new Response(Bun.file(CIRCUIT_DIR + "/" + m[1]))
  },
})
const CIRCUITS = "http://127.0.0.1:" + circuitServer.port

// ---- extract the two <script> bodies from the built bridge ----
const html = readFileSync(new URL("./dist/bridge.html", import.meta.url), "utf8")
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
if (scripts.length !== 2) throw new Error("expected 2 scripts, got " + scripts.length)

// ---- browser-ish shims (window === globalThis exposes fetch/crypto/btoa) ----
const b2u = (b64) => new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)))
const u2b = (u8) => btoa(String.fromCharCode(...u8))
globalThis.window = globalThis
globalThis.self = globalThis

const kp = Keypair.generate()
window.__PCASH_CONFIG__ = {
  walletPubkey: kp.publicKey.toBase58(),
  backendUrl: BACKEND,
  circuitBase: CIRCUITS,
}

// pending RPC results + inbound bridge messages
const pending = new Map()
let idc = 0
const state = { ready: null, signs: 0, signTxs: 0 }
window.ReactNativeWebView = {
  postMessage: (s) => {
    const msg = JSON.parse(s)
    if (msg.type === "ready") { state.ready = msg; return }
    if (msg.type === "signRequest") {
      // the RN layer signs with the native wallet; here we sign with kp
      state.signs++
      const sig = nacl.sign.detached(b2u(msg.messageB64), kp.secretKey)
      window.__pcash.inject({ signId: msg.signId, type: "signResponse", signatureB64: u2b(sig) })
      return
    }
    if (msg.type === "signTxRequest") {
      state.signTxs++
      const tx = VersionedTransaction.deserialize(b2u(msg.txB64))
      tx.sign([kp])
      window.__pcash.inject({ signId: msg.signId, type: "signTxResponse", signedTxB64: u2b(tx.serialize()) })
      return
    }
    if (msg.type === "result") {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  },
}
function call(method, args = []) {
  const id = ++idc
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    window.__pcash.inject({ id, type: "call", method, args })
  })
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error))
  return j.result
}
async function pokeSync() {
  await fetch(BACKEND + "/api/admin/sync", { method: "POST", headers: { "x-admin-password": ADMIN_PW() } })
}

// ---- boot the bridge ----
for (const s of scripts) (0, eval)(s)
if (!state.ready) throw new Error("bridge never posted ready")
console.log("bridge ready: hasSdk=" + state.ready.hasSdk + " webcrypto=" + state.ready.webcrypto)
if (!state.ready.hasSdk) throw new Error("SDK missing in bundle")

const assert = (cond, label) => { if (!cond) throw new Error("FAIL: " + label); console.log("ok  " + label) }

// ---- employee flow ----
await rpc("requestAirdrop", [kp.publicKey.toBase58(), 10_000_000_000])

// 1. registry check on a fresh wallet -> not enrolled
const r1 = await call("registered")
assert(r1.registered === false, "registered=false on fresh wallet")

// 2. fee schedule
const info = await call("relayerInfo")
assert(typeof info.bps === "number" && info.bps >= 0, "relayerInfo bps=" + info.bps + " minFee=" + info.minFee)

// 3. one-time enrollment (3 wallet signatures via the round-trip channel)
const t0 = Date.now()
const r2 = await call("enableReceiving")
assert(r2.registered === true, "enableReceiving -> registered")
assert(state.signs === 3, "3 signature round-trips (got " + state.signs + ")")
const r3 = await call("registered")
assert(r3.registered === true, "registered=true after enrollment")

// 4. deposit a 2 SOL note to self (direct signer; not the employee path)
const SDK = window.PrivacyCashSDK
const direct = {
  publicKey: kp.publicKey,
  signMessage: async (m) => nacl.sign.detached(new Uint8Array(m), kp.secretKey),
  signTransaction: async (tx) => { tx.sign([kp]); return tx },
}
const dep = new SDK.PrivacyCashClient(direct)
await dep.depositSOL(2_000_000_000)
// wait for the leaf to land in the backend mirror (syncs lazily; poke it)
for (let i = 0; i < 60; i++) {
  const t = await (await fetch(BACKEND + "/api/merkle/sol")).json()
  if (t.next_leaf_index >= 1) break
  await pokeSync()
  await new Promise((r) => setTimeout(r, 1000))
}

// 5. THE employee path through the bridge: unlock -> refresh -> balance -> notes
await call("unlock")
const rf = await call("refresh")
console.log("refresh:", JSON.stringify(rf))
const bal = await call("balance")
assert(bal.lamports === 2_000_000_000, "bridge balance = 2 SOL (got " + bal.lamports + ")")
const notes = await call("getNotes")
assert(notes.filter((n) => !n.spent).length === 1, "1 unspent note via getNotes")

// 6. claim: withdraw 1 SOL to own wallet, gasless via relayer (retry while the
//    mirror catches up, like a user re-tapping Claim)
const t1 = Date.now()
let w = null
let lastErr = null
for (let attempt = 0; attempt < 3 && !w; attempt++) {
  try {
    w = await call("withdraw", [1_000_000_000])
  } catch (e) {
    lastErr = e
    console.log("claim attempt " + (attempt + 1) + " failed: " + e.message + " -> sync + retry")
    await pokeSync()
    await new Promise((r) => setTimeout(r, 2000))
  }
}
if (!w) throw lastErr
console.log("withdraw took " + ((Date.now() - t1) / 1000).toFixed(1) + "s:", JSON.stringify(w).slice(0, 160))
assert(typeof w.signature === "string" && w.signature.length > 30, "withdraw signature present")
assert(w.recipientLamports > 0 && w.recipientLamports <= 1_000_000_000, "recipientLamports=" + w.recipientLamports)

// 7. post-claim state: shielded balance drops, wallet SOL rises
const bal2 = await call("balance")
assert(bal2.lamports === 1_000_000_000, "bridge balance = 1 SOL after claim (got " + bal2.lamports + ")")
const chainBal = (await rpc("getBalance", [kp.publicKey.toBase58()])).value
console.log("wallet SOL on chain after claim: " + (chainBal / 1e9).toFixed(6))
// ~7.998 SOL before the claim (surfpool airdrops land slightly under), ~8.995
// after: the 8 SOL boundary discriminates received-the-claim cleanly.
assert(chainBal > 8_000_000_000, "wallet SOL increased by the net claim (" + chainBal + ")")

console.log("\nALL EMPLOYEE BRIDGE CHECKS PASSED")
console.log(`flow: enrolled(${((Date.now() - t0) / 1000).toFixed(1)}s incl. 3 sigs), deposit, unlock+refresh, claim`)
circuitServer.stop(true)
process.exit(0)
