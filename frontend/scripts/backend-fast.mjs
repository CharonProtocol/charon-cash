// Fast local backend: same routes as backend-shim.mjs, but the chain mirror is
// an in-memory incremental tree fed by push (websocket logs + the relayer's
// own sends) and ordered exactly as the chain executed (fast-indexer.mjs).
// Paths, roots, commitments and nullifiers are answered from memory; the
// relay answers the moment the tx is broadcast. Run: bun scripts/backend-fast.mjs
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import nacl from "tweetnacl"
import { createHash, timingSafeEqual } from "node:crypto"
import { FastIndexer, ROOT_HISTORY } from "./fast-indexer.mjs"
import { startGrpcSource } from "./grpc-source.mjs"
import { createStateStore } from "./state-store.mjs"
import { buildV1Tx } from "../../payroll/rust-prover-bench/bench/v1-tx.mjs"

import {
  LocalMirror, readGlobalFees, readTreeState, deriveAccounts,
  MERKLE_TREE_DEPTH, buildTransactIxData, buildTransactSplInstruction,
} from "privacy-cash-sdk"

const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? "5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P")
const RPC = process.env.SOLANA_RPC_URL ?? "http://localhost:8899"
const PORT = Number(process.env.PORT ?? 8080)
const idJson = process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json")

// Address Lookup Table — required to compress the SPL transact's many accounts
// into a v0 message (without it compileToV0Message overruns on SPL withdraw).
function readDotEnv() {
  try {
    const out = {}
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}
const ALT_ADDRESS = process.env.ALT_ADDRESS ?? readDotEnv().VITE_ALT_ADDRESS ?? null

const conn = new Connection(RPC, "confirmed")
const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(idJson, "utf8"))))

// Recipient registry: in-memory, seeded from a JSON file (wallet ->
// {note_pubkey, enc_pubkey}) so test employees can be enrolled without running
// the employee app. Enrollments via PUT are additive and written back to the
// file (public keys only), so a restart never turns enrolled wallets into
// "not enrolled".
const recipients = new Map()
const RECIPIENTS_FILE = process.env.RECIPIENTS_FILE
try {
  if (RECIPIENTS_FILE && existsSync(RECIPIENTS_FILE)) {
    for (const [w, k] of Object.entries(JSON.parse(readFileSync(RECIPIENTS_FILE, "utf8")))) {
      recipients.set(w, k)
    }
    console.log(`loaded ${recipients.size} recipients from ${RECIPIENTS_FILE}`)
  }
} catch (e) {
  console.error("recipients seed load failed:", e.message)
}
function saveRecipients() {
  stateDirty = true
  if (!RECIPIENTS_FILE) return
  try {
    const tmp = `${RECIPIENTS_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(recipients), null, 1))
    renameSync(tmp, RECIPIENTS_FILE)
  } catch (e) {
    console.error("recipients save failed:", e.message)
  }
}
// Same checks as the deployed relayer: the wallet signed this exact key set.
const RECIPIENT_PUT_PREFIX = "privacy-cash-recipients-v1"
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** `backupKey` (optional): the same signature also links the wallet's note-backup key. */
function recipientPutError(wallet, note, enc, signature, backupKey = "") {
  let walletBytes
  try { walletBytes = new PublicKey(wallet).toBytes() } catch { return "wallet must be a 32-byte base58 pubkey" }
  if (!/^(0|[1-9][0-9]{0,77})$/.test(note) || BigInt(note) >= BN254_R) return "note_pubkey must be a canonical decimal field element"
  if (!/^[0-9a-f]{64}$/i.test(enc)) return "enc_pubkey must be 64 hex chars (32 bytes)"
  if (backupKey) {
    try { if (new PublicKey(backupKey).toBase58() !== backupKey) throw 0 } catch { return "backup_key must be a base58 pubkey" }
  }
  const sig = Buffer.from(signature, "base64")
  if (sig.length !== 64) return "signature must be 64 bytes (base64)"
  const msg = new TextEncoder().encode(`${RECIPIENT_PUT_PREFIX}\n${wallet}\n${note}\n${enc}${backupKey ? `\n${backupKey}` : ""}`)
  if (!nacl.sign.detached.verify(msg, sig, walletBytes)) return "signature does not verify for this wallet and key set"
  return null
}
const wasm = await WasmFactory.getInstance()

const dec2hex = (dec) => "0x" + BigInt(dec).toString(16).padStart(64, "0")
const dec2hexU = (dec) => BigInt(dec).toString(16).padStart(64, "0").toUpperCase()
const be = (b) => { let r = 0n; for (const x of b) r = (r << 8n) + BigInt(x); return r }
// ---- access control ----
// ALLOWED_ORIGINS (comma-separated, e.g. https://app.example.com): the only
// browser origins that get CORS headers and may open /ws. Unset = any
// origin (local dev). ADMIN_PASSWORD guards the operator routes (unset =
// they are off). DEBUG_ROUTES=1 enables the local telemetry sinks.
// TRUST_PROXY=1 reads the client IP from x-forwarded-for (behind Caddy).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null
const DEBUG_ROUTES = process.env.DEBUG_ROUTES === "1"
const TRUST_PROXY = process.env.TRUST_PROXY === "1"
const originAllowed = (origin) => ALLOWED_ORIGINS.length === 0 || (origin != null && ALLOWED_ORIGINS.includes(origin))
const sha = (v) => createHash("sha256").update(String(v)).digest()
function isAdmin(req) {
  const got = req.headers.get("x-admin-password")
  return !!ADMIN_PASSWORD && !!got && timingSafeEqual(sha(got), sha(ADMIN_PASSWORD))
}
function clientIp(req, server) {
  if (TRUST_PROXY) {
    const fwd = req.headers.get("x-forwarded-for")
    if (fwd) return fwd.split(",")[0].trim()
  }
  return server.requestIP(req)?.address ?? "unknown"
}
// Per-IP cap on the relay routes: each relayed tx costs the relayer a fee
// even when the program rejects it. A 100-row payroll run is ~110/min.
const RELAY_LIMIT_PER_MIN = Number(process.env.RELAY_LIMIT_PER_MIN ?? 300)
const relayHits = new Map()
function relayAllowed(ip) {
  const now = Date.now()
  const w = relayHits.get(ip)
  if (!w || now - w.start >= 60_000) {
    relayHits.set(ip, { start: now, n: 1 })
    return true
  }
  return ++w.n <= RELAY_LIMIT_PER_MIN
}
setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [ip, w] of relayHits) if (w.start < cutoff) relayHits.delete(ip)
}, 60_000)
// Shared budget for public routes that cost an RPC call (unknown tx status,
// nullifier chain check, lookup-table read, indexer kick): 20/s overall.
const RPC_BUDGET_PER_SEC = 20
let rpcBudget = { at: 0, left: RPC_BUDGET_PER_SEC }
function spendRpc() {
  const sec = Math.floor(Date.now() / 1000)
  if (rpcBudget.at !== sec) rpcBudget = { at: sec, left: RPC_BUDGET_PER_SEC }
  return rpcBudget.left-- > 0
}

const corsHeaders = {
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-password",
  "access-control-max-age": "86400",
}
const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status,
  headers: { "content-type": "application/json", ...corsHeaders },
})
// Persistent state (mirror snapshot + user data): disk, plus an S3/R2 copy
// when S3_BUCKET is set. A restart resumes from it instead of replaying
// the whole program history over RPC.
const store = createStateStore({
  file: process.env.STATE_FILE ?? path.join(homedir(), ".privacy-cash-backend", `${PROGRAM.toBase58()}.state.gz`),
})
const saved = await store.load()
let stateDirty = false
for (const [w, k] of saved?.recipients ?? []) if (!recipients.has(w)) recipients.set(w, k)

/** @type {Map<string, { ciphertext: string, updatedAt: string }>} */
const noteBlobs = new Map(saved?.noteBlobs ?? [])
// Note backups are writable only with the wallet's backup key, which the
// wallet links once by signature. wallet -> { key (base58), lastTs }
const noteKeys = new Map(saved?.noteKeys ?? [])
const NOTE_TS_SKEW_MS = 10 * 60_000
const b58Bytes = (s) => {
  try {
    return new PublicKey(s).toBytes()
  } catch {
    return null
  }
}
function noteKeyLinkError(wallet, key, signature) {
  const walletBytes = b58Bytes(wallet)
  const keyBytes = b58Bytes(key)
  if (!walletBytes || !keyBytes) return "wallet and key must be base58 pubkeys"
  const sig = Buffer.from(String(signature || ""), "base64")
  if (sig.length !== 64) return "signature must be 64 bytes (base64)"
  const msg = new TextEncoder().encode(["charon-notes-key-v1", wallet, key].join("\n"))
  return nacl.sign.detached.verify(msg, sig, walletBytes) ? null : "signature does not verify for this wallet"
}
function noteBackupError(wallet, ciphertext, ts, key, signature) {
  const link = noteKeys.get(wallet)
  if (!link || link.key !== key) return { status: 401, code: "NOTES_KEY_UNLINKED", message: "link this wallet's backup key first" }
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > NOTE_TS_SKEW_MS) return { status: 400, code: "BAD_TS", message: "ts out of range" }
  if (ts <= link.lastTs) return { status: 409, code: "STALE_BACKUP", message: "a newer backup is already stored" }
  const sig = Buffer.from(String(signature || ""), "base64")
  const blobHash = createHash("sha256").update(ciphertext).digest("hex")
  const msg = new TextEncoder().encode(["charon-notes-v1", wallet, String(ts), blobHash].join("\n"))
  if (sig.length !== 64 || !nacl.sign.detached.verify(msg, sig, b58Bytes(key))) return { status: 401, code: "BAD_SIGNATURE", message: "backup signature does not verify" }
  return null
}

// Tx outcomes for the browsers' /ws confirm feed: the backend's one RPC
// websocket decides, so browsers never hold RPC subscriptions themselves.
// Outcomes stay for TX_TTL_MS so a watch that arrives after the tx landed
// still gets its answer.
const TX_TTL_MS = 5 * 60_000
const MAX_WATCHES_PER_SOCKET = 512
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/
/** sig -> { outcome: "confirmed" | "failed" | null, at } */
const txOutcome = new Map()
/** sig -> Set<ServerWebSocket> */
const txWatchers = new Map()
function trackTx(sig) {
  if (!txOutcome.has(sig)) txOutcome.set(sig, { outcome: null, at: Date.now() })
}
/** sig -> callback for a relayed tx that fails on-chain */
const failHooks = new Map()
function settleTx(sig, outcome) {
  const cur = txOutcome.get(sig)
  if (cur?.outcome) return
  txOutcome.set(sig, { outcome, at: Date.now() })
  const onFailed = failHooks.get(sig)
  failHooks.delete(sig)
  if (outcome === "failed") onFailed?.()
  const ws = txWatchers.get(sig)
  if (!ws) return
  txWatchers.delete(sig)
  const msg = JSON.stringify({ sig, outcome })
  for (const w of ws) {
    w.data.sigs.delete(sig)
    w.send(msg)
  }
}
/** One status read for a tx we didn't relay (or whose subscription gave up). */
async function statusOnce(sig) {
  try {
    const st = (await conn.getSignatureStatuses([sig])).value?.[0]
    if (st?.err) settleTx(sig, "failed")
    else if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") settleTx(sig, "confirmed")
  } catch {}
}
// A watched tx the logs stream hasn't settled (not a program tx, or relayed
// before a restart): a few spaced status reads until it settles. Program
// txs that land later are settled by the stream first. Capped: browsers
// can't turn watches into a stream of RPC reads.
const MAX_FOREIGN_WATCHES = 32
const FOREIGN_READS_MS = [0, 3_000, 10_000, 25_000]
let foreignWatches = 0
function watchForeign(sig) {
  trackTx(sig)
  if (foreignWatches >= MAX_FOREIGN_WATCHES) return
  foreignWatches++
  ;(async () => {
    let waited = 0
    for (const at of FOREIGN_READS_MS) {
      await new Promise((r) => setTimeout(r, at - waited))
      waited = at
      if (txOutcome.get(sig)?.outcome) return
      await statusOnce(sig)
    }
  })().finally(() => foreignWatches--)
}
/** Resolve with the tx's outcome (from the logs stream), or null on timeout. */
async function waitTx(sig, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const o = txOutcome.get(sig)?.outcome
    if (o) return o
    await new Promise((r) => setTimeout(r, 50))
  }
  await statusOnce(sig)
  return txOutcome.get(sig)?.outcome ?? null
}
setInterval(() => {
  const cutoff = Date.now() - TX_TTL_MS
  for (const [sig, t] of txOutcome) {
    if (t.at >= cutoff) continue
    txOutcome.delete(sig)
    failHooks.delete(sig)
    for (const w of txWatchers.get(sig) ?? []) w.data.sigs.delete(sig)
    txWatchers.delete(sig)
  }
}, 60_000)

// Blockhash on demand: fetched only while txs are being built, once the
// cached one is older than BLOCKHASH_MAX_AGE_MS. With 200 ms slots a
// blockhash lives 150 blocks (~30 s), so 10 s leaves ~20 s to land.
// Idle = no calls.
const BLOCKHASH_MAX_AGE_MS = 10_000
let bh = null
let bhInflight = null
async function recentBlockhash() {
  if (bh && Date.now() - bh.at < BLOCKHASH_MAX_AGE_MS) return bh
  bhInflight ??= conn
    .getLatestBlockhashAndContext("confirmed")
    .then((r) => (bh = { blockhash: r.value.blockhash, slot: r.context.slot, at: Date.now() }))
    .finally(() => (bhInflight = null))
  return bhInflight
}

// Lookup tables change only when extended: one read per 10 min, not per tx.
const ALT_TTL_MS = 10 * 60_000
const altCache = new Map()
async function lookupTableAccount(address) {
  const hit = altCache.get(address)
  if (hit && Date.now() - hit.at < ALT_TTL_MS) return hit.value
  const value = (await conn.getAddressLookupTable(new PublicKey(address))).value
  altCache.set(address, { value, at: Date.now() })
  return value
}
const altDataCache = new Map()
// Short-lived on purpose: a client polls its freshly extended table here, so
// a stale or missing answer must never outlive a couple of seconds.
const ALT_DATA_TTL_MS = 2_000
async function lookupTableData(address) {
  const hit = altDataCache.get(address)
  if (hit && Date.now() - hit.at < ALT_DATA_TTL_MS) return hit.data
  const acct = await conn.getAccountInfo(new PublicKey(address))
  const data = acct ? Buffer.from(acct.data) : null
  if (data) altDataCache.set(address, { data, at: Date.now() })
  else altDataCache.delete(address)
  return data
}

/**
 * Track a sent tx: the logs stream settles it and indexes its leaves. If no
 * outcome shows up in ABSORB_CHECK_MS (a stalled socket), one status read
 * and one catch-up pass decide instead.
 */
const ABSORB_CHECK_MS = 20_000
function absorb(sig, onFailed) {
  trackTx(sig)
  const settled = txOutcome.get(sig).outcome
  if (settled === "failed") onFailed?.()
  else if (!settled && onFailed) failHooks.set(sig, onFailed)
  setTimeout(() => {
    if (txOutcome.get(sig)?.outcome) return
    statusOnce(sig)
      .then(() => txOutcome.get(sig)?.outcome === "confirmed" && indexer.sync())
      .catch(() => {})
  }, ABSORB_CHECK_MS)
}

// Send endpoints, each paced under its own sendTransaction limit. Devnet
// free tier: SEND_RPC_URLS="https://api.devnet.solana.com,<helius url>" with
// SEND_RPC_RATES="4,1" (public devnet allows 40 per 10 s per method per IP,
// Helius free 1/s). Every send takes the endpoint that is free soonest, so
// bursts queue for a moment instead of hitting 429s. Unset = SOLANA_RPC_URL,
// unpaced (local).
const SEND_URLS = (process.env.SEND_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean)
const SEND_RATES = (process.env.SEND_RPC_RATES ?? "").split(",").map(Number)
const senders = (SEND_URLS.length ? SEND_URLS : [RPC]).map((url, i) => {
  const rate = SEND_RATES[i] > 0 ? SEND_RATES[i] : Infinity
  return { conn: url === RPC ? conn : new Connection(url, "confirmed"), host: new URL(url).host, gapMs: 1000 / rate, next: 0 }
})
const sendWaitMs = []
async function sendSlot() {
  const now = Date.now()
  const ep = senders.reduce((a, b) => (Math.max(b.next, now) < Math.max(a.next, now) ? b : a))
  const at = Math.max(ep.next, now)
  ep.next = at + ep.gapMs
  sendWaitMs.push(at - now)
  if (sendWaitMs.length > 1000) sendWaitMs.shift()
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
  return ep
}

// surfpool (a mainnet-forking local validator) lazy-loads referenced accounts from
// api.mainnet-beta.solana.com on demand; if that fetch is slow/offline it rejects the
// tx with "Failed to fetch accounts from remote". Retry on that (and 429/timeout);
// a 429 also parks that endpoint for a second.
async function sendRawWithRetry(serialized, opts, attempts = 7) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const ep = await sendSlot()
    try {
      return await ep.conn.sendRawTransaction(serialized, opts)
    } catch (e) {
      lastErr = e
      const msg = String(e?.message ?? e)
      if (/429|Too Many/i.test(msg)) {
        ep.next = Math.max(ep.next, Date.now() + 1000)
        console.warn(`send: ${ep.host} rate-limited, backing off 1s`)
        continue
      }
      if (/Failed to fetch accounts from remote|mainnet-beta|timeout|error sending request/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 900))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function sendIx(ix) {
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix] }).compileToV0Message()
  const tx = new VersionedTransaction(msg); tx.sign([payer])
  const sig = await sendRawWithRetry(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  absorb(sig)
  return { signature: sig, slot: null, status: "submitted" }
}

// ---- ensure the SOL pool is initialized ----
const solTree = deriveAccounts(PROGRAM, new Uint8Array(32), new Uint8Array(32)).treeAccount
if (!(await conn.getAccountInfo(solTree))) {
  console.log("initializing SOL pool…")
  const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
  const [tT, ttb] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
  const [gC, gb] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  await sendIx(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: tA, isSigner: false, isWritable: true },
      { pubkey: tT, isSigner: false, isWritable: true },
      { pubkey: gC, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, tb, ttb, gb]),
  }))
  console.log("initialized.")
}

// ---- index: scan program tx history -> commitments / encrypted outputs / nullifiers ----
const indexer = new FastIndexer({
  conn,
  program: PROGRAM,
  wasm,
  pollMs: Number(process.env.POLL_MS ?? 0),
  // Outcomes ride the same logs stream: no per-tx signature subscription.
  // Kept for every tx (TTL-pruned): on a fast chain the notification can
  // beat the relay's own bookkeeping.
  onOutcome: (sig, outcome) => settleTx(sig, outcome),
})
// a snapshot from another chain (reset) also drops its per-mint lookup tables
let chainReset = false
const restored = saved?.mirror ? indexer.restore(saved.mirror) : false
const restoredLeaves = indexer.applied * 2
await indexer.start()
if (restored) {
  if (await indexer.matchesChain()) {
    console.log(`state: resumed from snapshot (${restoredLeaves} leaves), caught up to ${indexer.applied * 2}`)
  } else {
    console.log("state: snapshot does not match the chain (reset?), rebuilding from RPC")
    chainReset = true
    indexer.reset()
    await indexer.sync()
  }
}
// GRPC_URL (e.g. http://127.0.0.1:10000 for surfpool -g, or a LaserStream
// endpoint + GRPC_X_TOKEN): leaves arrive pushed with the tx itself.
if (process.env.GRPC_URL) {
  void startGrpcSource({
    url: process.env.GRPC_URL,
    xToken: process.env.GRPC_X_TOKEN,
    commitment: process.env.GRPC_COMMITMENT ?? "confirmed",
    indexer,
  })
}

// relay -> indexed latency per relayed tx (ms), for /indexer/status
const relayedAt = new Map()
const indexLagMs = []
const applyTransact = indexer.applyTransact.bind(indexer)
indexer.applyTransact = (sig, slot, t) => {
  applyTransact(sig, slot, t)
  stateDirty = true
  // Only txs someone relayed or watches: a catch-up sync replays history.
  if (txOutcome.has(sig)) settleTx(sig, "confirmed")
  const at = relayedAt.get(sig)
  if (at !== undefined) {
    relayedAt.delete(sig)
    indexLagMs.push(Date.now() - at)
    if (indexLagMs.length > 1000) indexLagMs.shift()
  }
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null
}

// Nullifiers of relayed txs the mirror hasn't indexed yet. They count as
// spent everywhere (relay guard + nullifier queries): otherwise a ledger
// refresh in that window resurrects the note and a second lane re-spends it
// in the same slot (AccountAlreadyInitialized on-chain). Cleared when the tx
// fails on-chain or after the TTL; indexed ones fall through to the mirror.
const INFLIGHT_TTL_MS = 90_000
/** nullifier hex -> { sig, at } */
const inflight = new Map()
/** wallet:key -> signed employer UI doc (local dev, in memory) */
const uiDocs = new Map(saved?.uiDocs ?? [])
/** mint -> its relay lookup table address (created once per mint) */
const splAltAddrs = new Map(chainReset ? [] : saved?.splAlts ?? [])

const stateNow = () => ({
  v: 1,
  mirror: indexer.snapshot(),
  noteBlobs: [...noteBlobs],
  noteKeys: [...noteKeys],
  uiDocs: [...uiDocs],
  recipients: [...recipients],
  splAlts: [...splAltAddrs],
})
// Disk at most every 5 s while things change; the bucket at most every 60 s.
let remoteDirty = false
function flushDisk() {
  if (!stateDirty) return
  stateDirty = false
  remoteDirty = true
  try {
    store.saveDisk(stateNow())
  } catch (e) {
    stateDirty = true
    console.error("state: disk save failed:", e.message)
  }
}
async function flushRemote() {
  if (!remoteDirty || !store.remote) return
  remoteDirty = false
  try {
    await store.saveRemote(stateNow())
  } catch (e) {
    remoteDirty = true
    console.error("state: remote save failed:", e.message)
  }
}
stateDirty = true // first save right after boot
setInterval(flushDisk, 5_000)
setInterval(() => void flushRemote(), 60_000)
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    flushDisk()
    remoteDirty = remoteDirty || store.remote
    await flushRemote()
    process.exit(0)
  })
}
function spentBy(hex) {
  const indexed = indexer.nullifiers.get(hex)
  if (indexed) {
    inflight.delete(hex)
    return indexed
  }
  const f = inflight.get(hex)
  if (f && Date.now() - f.at < INFLIGHT_TTL_MS) return f.sig
  if (f) inflight.delete(hex)
  return null
}
console.log(`indexed ${indexer.applied} transacts across ${indexer.pools.size} trees, ${indexer.nullifiers.size} nullifiers`)

async function proofFor(treeKey, idx) {
  await indexer.waitFor(() => (indexer.pools.get(treeKey)?.leaves.length ?? 0) > idx, 3000)
  return indexer.pools.get(treeKey)?.proof(idx) ?? null
}

let lastKickAt = 0
const SUBMIT_PROGRAMS = new Set([
  PROGRAM.toBase58(),
  "AddressLookupTab1e1111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
])

Bun.serve({
  port: PORT,
  // HOST=127.0.0.1 behind a reverse proxy (the VM): only the proxy reaches it.
  hostname: process.env.HOST ?? "0.0.0.0",
  idleTimeout: 120, // Merkle/ZK witness gen can exceed Bun's 10s default
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(req, server) {
    const origin = req.headers.get("origin")
    if (new URL(req.url).pathname === "/ws") {
      if (origin && !originAllowed(origin)) return json({ error: { code: "FORBIDDEN", message: "origin not allowed" } }, 403)
      if (server.upgrade(req, { data: { sigs: new Set() } })) return
      return json({ error: { code: "BAD_REQUEST", message: "websocket upgrade required" } }, 400)
    }
    const res = await handle(req, server)
    if (originAllowed(origin)) {
      res.headers.set("access-control-allow-origin", ALLOWED_ORIGINS.length ? origin : "*")
      if (ALLOWED_ORIGINS.length) res.headers.append("vary", "origin")
    }
    return res
  },
  // Confirm feed: {"watch": sig} -> {"sig", "outcome"} once the tx settles.
  websocket: wsHandlers(),
})
console.log(`backend-fast listening on :${PORT} (program ${PROGRAM.toBase58()})`)
// Shared per-mint lookup tables up front (after module init), so a payer's
// first SPL deposit already finds one and never creates its own: every pool
// with leaves, plus known tokens (USDC) whose pool exists but is still empty.
setTimeout(async () => {
  const mints = new Set([...indexer.pools.keys(), ...Object.keys(KNOWN_SYMBOLS)])
  mints.delete("sol")
  for (const mint of mints) {
    try {
      const key = new PublicKey(mint)
      if (!indexer.pools.has(mint)) {
        const [tree] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), key.toBytes()], PROGRAM)
        if (!(await conn.getAccountInfo(tree))) continue
      }
      await ensureSplAlt(key)
    } catch (e) {
      console.error(`lookup table for ${mint}: ${e.message}`)
    }
  }
}, 0)

async function handle(req, server) {
    const url = new URL(req.url)
    const p = url.pathname
    const method = req.method
    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    try {
      if (p === "/health") return json({ status: "ok", program: PROGRAM.toBase58() })

      // HTTP twin of the /ws feed, for a browser whose socket dropped.
      const txm = p.match(/^\/api\/tx\/([^/]+)$/)
      if (txm && method === "GET") {
        const sig = txm[1]
        if (!SIG_RE.test(sig)) return json({ error: { code: "BAD_REQUEST", message: "bad signature" } }, 400)
        if (!txOutcome.get(sig)?.outcome && spendRpc()) await statusOnce(sig)
        return json({ sig, outcome: txOutcome.get(sig)?.outcome ?? null })
      }

      // Local prover telemetry: failing circuit inputs land in
      // /tmp/prover-failures.json for offline diagnosis.
      if (p.startsWith("/api/debug/") && !DEBUG_ROUTES) {
        return json({ error: { code: "NOT_FOUND", message: `no route ${method} ${p}` } }, 404)
      }
      if (p === "/api/debug/prover-failure" && method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        try {
          const arr = existsSync("/tmp/prover-failures.json")
            ? JSON.parse(readFileSync("/tmp/prover-failures.json", "utf8"))
            : []
          arr.push({ at: body.at ?? new Date().toISOString(), error: String(body.error ?? ""), input: body.input ?? "" })
          while (arr.length > 50) arr.shift()
          writeFileSync("/tmp/prover-failures.json", JSON.stringify(arr, null, 1))
        } catch { }
        return json({ ok: true })
      }
      // Local run telemetry: per-row timing breakdown per completed run.
      if (p === "/api/debug/run-telemetry" && method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        try {
          const arr = existsSync("/tmp/run-telemetry.json")
            ? JSON.parse(readFileSync("/tmp/run-telemetry.json", "utf8"))
            : []
          arr.push(body)
          while (arr.length > 20) arr.shift()
          writeFileSync("/tmp/run-telemetry.json", JSON.stringify(arr, null, 1))
        } catch { }
        return json({ ok: true })
      }

      if (p === "/indexer/status") {
        return json({ last_signature: indexer.lastSig, last_slot: indexer.lastSlot, passes: indexer.passes, applied: indexer.applied, stats: indexer.stats,
          index_lag_ms: { n: indexLagMs.length, p50: pct(indexLagMs, 50), p90: pct(indexLagMs, 90), max: pct(indexLagMs, 100) },
          send_queue_wait_ms: { n: sendWaitMs.length, p50: pct(sendWaitMs, 50), p90: pct(sendWaitMs, 90), max: pct(sendWaitMs, 100) },
          remote_state: store.remote ? store.usage() : null,
          pools: [...indexer.pools.values()].map((q) => ({ tree_key: q.treeKey, leaves: q.leaves.length, root: q.root() })) })
      }

      // Encrypted note blob backup (in-memory for local shim)
      if (p === "/api/notes" && method === "PUT") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const wallet = String(body.wallet || "").trim()
        const ciphertext = String(body.ciphertext || "").trim()
        if (!wallet || !/^[0-9a-f]+$/i.test(ciphertext)) {
          return json({ error: { code: "BAD_REQUEST", message: "wallet and hex ciphertext required" } }, 400)
        }
        const bad = noteBackupError(wallet, ciphertext, Number(body.ts), String(body.key || ""), body.signature)
        if (bad) return json({ error: { code: bad.code, message: bad.message } }, bad.status)
        noteKeys.get(wallet).lastTs = Number(body.ts)
        noteBlobs.set(wallet, { ciphertext, updatedAt: new Date().toISOString() })
        stateDirty = true
        return new Response(null, { status: 204, headers: corsHeaders })
      }
      // One wallet signature links the backup key (re-linking needs a fresh one).
      if (p === "/api/notes/key" && method === "PUT") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const wallet = String(body.wallet || "").trim()
        const key = String(body.key || "").trim()
        const bad = noteKeyLinkError(wallet, key, body.signature)
        if (bad) return json({ error: { code: "BAD_REQUEST", message: bad } }, 400)
        const prev = noteKeys.get(wallet)
        noteKeys.set(wallet, { key, lastTs: prev?.key === key ? prev.lastTs : 0 })
        stateDirty = true
        return json({ ok: true })
      }
      const notesGet = p.match(/^\/api\/notes\/([^/]+)$/)
      if (notesGet && method === "GET") {
        const wallet = decodeURIComponent(notesGet[1])
        const hit = noteBlobs.get(wallet)
        // 200 (not 404) so the browser console stays quiet when no backup yet.
        if (!hit) {
          return json({ wallet, ciphertext: null, updated_at: null, exists: false })
        }
        return json({
          wallet,
          ciphertext: hit.ciphertext,
          updated_at: hit.updatedAt,
          exists: true,
        })
      }

      if (p === "/api/relayer/info") {
        let fees = { withdrawalFeeRateBps: 25, feeErrorMarginBps: 500 }
        try { fees = await readGlobalFees(conn, PROGRAM) } catch { }
        const mints = [...new Set([...indexer.pools.keys(), ...splAltAddrs.keys()])].filter((k) => k !== "sol")
        const supported = await Promise.all(mints.map(async (mint) => ({
          mint,
          fee_ata: getAssociatedTokenAddressSync(new PublicKey(mint), payer.publicKey, true).toBase58(),
          ...(splAltAddrs.has(mint) ? { alt: splAltAddrs.get(mint) } : {}),
          ...(await mintMeta(mint)),
        })))
        return json({ program_id: PROGRAM.toBase58(), fee_recipient: payer.publicKey.toBase58(), fee_rate_bps: 0, withdrawal_fee_rate_bps: fees.withdrawalFeeRateBps, fee_error_margin_bps: fees.feeErrorMarginBps, supported_mints: supported })
      }

      const m = p.match(/^\/api\/merkle\/([^/]+)$/)
      if (m && method === "GET") {
        const pool = indexer.pool(decodeURIComponent(m[1]))
        return json({ tree_key: pool.treeKey, next_leaf_index: pool.leaves.length, current_root: pool.root().toUpperCase(),
          known_roots: pool.roots.map((r) => r.toUpperCase()), leaf_count: pool.leaves.length })
      }

      // Root + every requested path from ONE in-memory snapshot (same JS tick).
      const snap = p.match(/^\/api\/merkle\/([^/]+)\/snapshot$/)
      if (snap && method === "GET") {
        const treeKey = decodeURIComponent(snap[1])
        const idxs = [...new Set(url.searchParams.getAll("idx").map(Number))].filter((i) => i >= 0).sort((a, b) => a - b).slice(0, 8)
        await indexer.waitFor(() => (indexer.pools.get(treeKey)?.leaves.length ?? 0) > (idxs[idxs.length - 1] ?? -1), 2000)
        const pool = indexer.pool(treeKey)
        const missing = idxs.filter((i) => i >= pool.leaves.length)
        return json({ tree_key: treeKey, current_root: pool.root().toUpperCase(), next_leaf_index: pool.leaves.length,
          proofs: missing.length ? [] : idxs.map((i) => pool.proof(i)), missing })
      }

      // Employer UI docs (run history + team), same contract as the Workers
      // backend: wallet-signed writes bound to the doc's sha256, signed reads,
      // 10-minute timestamp window, 256 KiB cap. In memory: local dev only.
      const ui = p.match(/^\/api\/ui\/([A-Za-z0-9_-]{1,64})(?:\/([^/]+))?$/)
      if (ui && (method === "PUT" || method === "GET")) {
        const key = ui[1]
        const bad = (code, message) => json({ error: { code, message } }, 400)
        const verify = (prefix, wallet, ts, sigB64, docHash) => {
          let pk
          try { pk = new PublicKey(wallet) } catch { return "INVALID_WALLET" }
          if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60_000) return "STALE_TIMESTAMP"
          const sig = Buffer.from(String(sigB64 ?? ""), "base64")
          if (sig.length !== 64) return "INVALID_SIGNATURE"
          const msg = [prefix, wallet, key, String(ts), ...(docHash ? [docHash] : [])].join("\n")
          return nacl.sign.detached.verify(new TextEncoder().encode(msg), sig, pk.toBytes()) ? null : "BAD_SIGNATURE"
        }
        if (method === "PUT" && !ui[2]) {
          let body = {}
          try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
          const wallet = String(body.wallet ?? "").trim()
          const doc = String(body.doc ?? "").trim()
          if (doc.length > 256 * 1024) return bad("DOC_TOO_LARGE", "doc exceeds 256 KiB")
          const err = verify("charon-ui-v1", wallet, Number(body.ts), body.signature, createHash("sha256").update(doc).digest("hex"))
          if (err) return bad(err, "signature does not verify for this wallet, key, timestamp and doc")
          uiDocs.set(`${wallet}:${key}`, doc)
          stateDirty = true
          return new Response(null, { status: 204, headers: corsHeaders })
        }
        if (method === "GET" && ui[2]) {
          const wallet = decodeURIComponent(ui[2])
          const err = verify("charon-ui-read-v1", wallet, Number(url.searchParams.get("ts")), url.searchParams.get("signature"))
          if (err) return bad(err, "signature does not verify for this wallet, key and timestamp")
          return json({ doc: uiDocs.get(`${wallet}:${key}`) ?? null })
        }
      }

      const cm = p.match(/^\/api\/commitment\/([^/]+)$/)
      if (cm && method === "GET") {
        const hex = decodeURIComponent(cm[1]).replace(/^0x/i, "").toLowerCase()
        const treeKey = url.searchParams.get("tree_key") || "sol"
        const find = () => indexer.pools.get(treeKey)?.byCommitment.get(hex)
        await indexer.waitFor(() => find() !== undefined, 1500)
        const idx = find()
        if (idx === undefined) return json({ error: { code: "LEAF_NOT_FOUND", message: "commitment not indexed yet" } }, 404)
        return json({ tree_key: treeKey, commitment: hex, leaf_index: idx })
      }

      const mp = p.match(/^\/api\/merkle\/([^/]+)\/proof\/(\d+)$/)
      if (mp) {
        const treeKey = decodeURIComponent(mp[1])
        const pr = await proofFor(treeKey, Number(mp[2]))
        if (!pr) return json({ error: { code: "LEAF_NOT_FOUND", message: "leaf not indexed yet" } }, 404)
        // root + paths come from one mirror snapshot (see proofFor)
        return json(pr)
      }

      if (p === "/api/utxos/range" && method === "GET") {
        const treeKey = url.searchParams.get("tree_key") || "sol"
        const start = Number(url.searchParams.get("start") ?? 0)
        const end = Number(url.searchParams.get("end") ?? start + 2000)
        const leaves = indexer.pools.get(treeKey)?.leaves ?? []
        const page = leaves.slice(start, end).map((u, k) => ({ ...u, leafIndex: start + k }))
        const total = leaves.length
        return json({
          tree_key: treeKey,
          start,
          end,
          total,
          next_index: total,
          has_more: end < total,
          utxos: page.map((u) => ({
            leaf_index: u.leafIndex,
            commitment: u.commitment,
            encrypted_output_hex: u.encryptedHex,
            signature: u.signature,
            slot: u.slot,
          })),
        })
      }

      const chk = p.match(/^\/api\/utxos\/check\/([^/]+)$/)
      if (chk && method === "GET") {
        const hex = decodeURIComponent(chk[1]).replace(/^0x/i, "").toLowerCase()
        const treeKey = url.searchParams.get("tree_key")
        const pools = treeKey ? [indexer.pools.get(treeKey)].filter(Boolean) : [...indexer.pools.values()]
        const pool = pools.find((q) => q.byEncrypted.has(hex))
        const idx = pool?.byEncrypted.get(hex)
        const leaf = pool ? pool.leaves[idx] : null
        return json(
          leaf
            ? { exists: true, tree_key: pool.treeKey, leaf_index: idx, commitment: leaf.commitment, signature: leaf.signature, slot: leaf.slot }
            : { exists: false },
        )
      }

      const n = p.match(/^\/api\/nullifier\/([^/]+)$/)
      if (n) {
        const hex = n[1].replace(/^0x/i, "")
        let signature = spentBy(hex)
        let spent = signature !== null
        if (!spent && /^[0-9a-f]{64}$/i.test(hex) && spendRpc()) {
          const h = Buffer.from(hex, "hex")
          const [marker] = PublicKey.findProgramAddressSync([Buffer.from("nullifier"), h], PROGRAM)
          spent = (await conn.getAccountInfo(marker)) !== null
        }
        // in-flight spends are spent, but "pending" is no signature to hand out
        return json({ nullifier: hex, spent, signature: signature === "pending" ? null : signature, pending: signature === "pending" })
      }
      if (p === "/api/nullifiers/batch" && method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const hashes = Array.isArray(body.hashes) ? body.hashes : []
        return json({ results: hashes.map((raw) => {
          const hex = String(raw).replace(/^0x/i, "")
          const signature = spentBy(hex)
          return { hash: hex, spent: signature !== null, signature: signature === "pending" ? null : signature }
        }) })
      }
      // Public: one catch-up pass per 2 s at most, however many callers kick.
      if (p === "/api/indexer/kick" && method === "POST") {
        const n0 = indexer.applied
        if (Date.now() - lastKickAt >= 2000 && spendRpc()) {
          lastKickAt = Date.now()
          await indexer.sync()
        } else if (indexer.running) {
          await indexer.running
        }
        return json({ processed: indexer.applied - n0, walked: 1 })
      }

      // ---- recipient registry (in-memory, optional seed file) ----
      const rk = p.match(/^\/api\/recipients\/([^/]+)$/)
      if (rk && method === "GET") {
        const hit = recipients.get(decodeURIComponent(rk[1]))
        if (!hit) return json({ error: { code: "NOT_FOUND", message: "wallet has not enrolled" } }, 404)
        return json(hit)
      }
      if (p === "/api/recipients" && method === "PUT") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const wallet = String(body.wallet || "").trim()
        const note = String(body.note_pubkey || "").trim()
        const enc = String(body.enc_pubkey || "").trim()
        const backupKey = String(body.backup_key || "").trim()
        const bad = recipientPutError(wallet, note, enc, String(body.signature || "").trim(), backupKey)
        if (bad) return json({ error: { code: "BAD_REQUEST", message: bad } }, 400)
        recipients.set(wallet, { note_pubkey: note, enc_pubkey: enc })
        if (backupKey) {
          // one signature enrolled the wallet AND linked its backup key
          const prev = noteKeys.get(wallet)
          noteKeys.set(wallet, { key: backupKey, lastTs: prev?.key === backupKey ? prev.lastTs : 0 })
          stateDirty = true
        }
        saveRecipients()
        return json({ ok: true })
      }

      // ---- relay endpoints the backend-only client SDK calls ----
      if (p === "/api/relayer/blockhash" && method === "GET") {
        const { blockhash, slot } = await recentBlockhash()
        return json({ blockhash, last_valid_block_height: 0, slot })
      }
      const altm = p.match(/^\/api\/relayer\/alt\/([^/]+)$/)
      if (altm && method === "GET") {
        let address
        try {
          address = new PublicKey(altm[1]).toBase58()
        } catch {
          return json({ error: { code: "BAD_REQUEST", message: "bad address" } }, 400)
        }
        const hit = altDataCache.get(address)
        if (!(hit && Date.now() - hit.at < ALT_DATA_TTL_MS) && !spendRpc()) {
          return json({ error: { code: "RATE_LIMITED", message: "try again shortly" } }, 429)
        }
        const data = await lookupTableData(address)
        if (!data) return json({ exists: false, data_hex: "" })
        return json({ exists: true, data_hex: data.toString("hex") })
      }

      // ---- POST setup/config (payer = authority signs) ----
      if (method === "POST") {
        if (p === "/api/admin/verify") {
          return isAdmin(req) ? json({ ok: true }) : json({ error: { code: "HTTP_401", message: "invalid admin password" } }, 401)
        }
        const operatorRoute = /^\/api\/relayer\/(initialize|initialize-spl|update-config|update-deposit-limit|update-deposit-limit-spl)$/.test(p)
        if (operatorRoute && !isAdmin(req)) {
          return json({ error: { code: "HTTP_401", message: "invalid admin password" } }, 401)
        }
        if ((p === "/api/relayer" || p === "/api/relayer/transact" || p === "/api/relayer/submit" || p === "/api/relayer/swap" || p === "/api/jupiter/route") && !relayAllowed(clientIp(req, server))) {
          return json({ error: { code: "RATE_LIMITED", message: "too many relay requests, slow down" } }, 429)
        }
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }

        if (p === "/api/recipients/batch") {
          const wallets = Array.isArray(body.wallets) ? body.wallets.map(String) : []
          const results = wallets
            .filter((w) => recipients.has(w))
            .map((w) => ({ wallet: w, ...recipients.get(w) }))
          return json({ results })
        }

        // Deposit path: client wallet-signed VersionedTransaction hex → broadcast
        if (p === "/api/relayer/submit") {
          const hex = String(body.transaction || "").replace(/^0x/i, "")
          const bytes = Buffer.from(hex, "hex")
          const vtx = VersionedTransaction.deserialize(bytes)
          // Not a free broadcast service: the pool program, plus the setup an
          // SPL payer signs first (its lookup table, token accounts, budget).
          const keys = vtx.message.staticAccountKeys
          const programs = vtx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex])
          if (programs.length === 0 || !programs.every((p) => p && SUBMIT_PROGRAMS.has(p.toBase58()))) {
            return json({ error: { code: "BAD_REQUEST", message: "transaction calls a program this relayer does not broadcast" } }, 400)
          }
          // Preflight on: a client-signed tx the node rejects (unfunded payer,
          // stale blockhash) fails this request now instead of after the
          // ~90s confirm timeout, and a landed-but-failed tx is an error too.
          const sig = await sendRawWithRetry(vtx.serialize(), { skipPreflight: false, preflightCommitment: "processed", maxRetries: 5 })
          // Setup txs (lookup table, token accounts) never reach the pool's
          // logs stream: confirm them by status instead of waiting out the
          // stream's stall check (that cost ~25 s per setup step).
          const pool = programs.some((p) => p.equals(PROGRAM))
          if (pool) absorb(sig)
          const outcome = pool ? await waitTx(sig, 60_000) : await setupOutcome(sig)
          if (outcome === "failed") return json({ error: { message: "transaction failed on-chain" } }, 400)
          if (pool) await indexer.waitFor(() => indexer.appliedSigs.has(sig), 5000)
          return json({ signature: sig, slot: null, status: "submitted" })
        }

        // Private swap: Jupiter quote for the pool, then the relayer-signed v1 packet
        if (p === "/api/jupiter/route") return json(await jupiterRoute(body))
        if (p === "/api/relayer/swap") return json(await relaySwap(body))

        // Withdraw path: proof JSON → shim signs with local payer (relayer role)
        if (p === "/api/relayer" || p === "/api/relayer/transact") {
          return json(await relayWithdraw(body))
        }
        if (p === "/api/relayer/initialize") {
          if (await conn.getAccountInfo(solTree)) return json({ signature: "-", slot: null, status: "already-initialized" })
          return json(await sendIx(buildInitializeSolIx()))
        }
        if (p === "/api/relayer/initialize-spl") {
          const mint = new PublicKey(body.mint)
          const max = BigInt(body.max_deposit_amount ?? 1_000_000_000_000)
          const [treeAccount, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
          const [gC] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
          const data = Buffer.alloc(17); data[0] = 1; data.writeBigUInt64LE(max, 1); data[9] = tb
          // the pool's shared lookup table goes up with it, so the first
          // payer deposit already finds one (re-running just ensures it)
          if (await conn.getAccountInfo(treeAccount)) {
            const alt = await ensureSplAlt(mint)
            return json({ signature: "-", slot: null, status: "already-initialized", alt: alt.key.toBase58() })
          }
          const init = await sendIx(new TransactionInstruction({
            programId: PROGRAM, keys: [
              { pubkey: treeAccount, isSigner: false, isWritable: true },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: gC, isSigner: false, isWritable: false },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ], data
          }))
          await setupOutcome(init.signature)
          const alt = await ensureSplAlt(mint)
          return json({ ...init, alt: alt.key.toBase58() })
        }
        if (p === "/api/relayer/update-config") {
          const [gC] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
          let mask = 0
          if (body.deposit_fee_rate != null) mask |= 1
          if (body.withdrawal_fee_rate != null) mask |= 2
          if (body.fee_error_margin != null) mask |= 4
          const data = Buffer.alloc(7); data[0] = 6; data.writeUInt16LE(body.deposit_fee_rate ?? 0, 1); data.writeUInt16LE(body.withdrawal_fee_rate ?? 0, 3); data.writeUInt16LE(body.fee_error_margin ?? 0, 5); data[6] = mask
          return json(await sendIx(new TransactionInstruction({
            programId: PROGRAM, keys: [
              { pubkey: gC, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            ], data
          })))
        }
        if (p === "/api/relayer/update-deposit-limit") {
          const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
          const data = Buffer.alloc(10); data[0] = 4; data.writeBigUInt64LE(BigInt(body.new_limit), 1); data[9] = tb
          return json(await sendIx(new TransactionInstruction({
            programId: PROGRAM, keys: [
              { pubkey: tA, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            ], data
          })))
        }
        if (p === "/api/relayer/update-deposit-limit-spl") {
          const mint = new PublicKey(body.mint)
          const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
          const data = Buffer.alloc(10); data[0] = 5; data.writeBigUInt64LE(BigInt(body.new_limit), 1); data[9] = tb
          return json(await sendIx(new TransactionInstruction({
            programId: PROGRAM, keys: [
              { pubkey: tA, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            ], data
          })))
        }
      }

      return json({ error: { code: "NOT_FOUND", message: `no route ${method} ${p}` } }, 404)
    } catch (e) {
      if (e?.status) {
        console.warn(`${method} ${p} -> ${e.status} ${e.code}: ${String(e.message).slice(0, 160)}`)
        return json({ error: { code: e.code, message: e.message } }, e.status)
      }
      console.error("FAST BACKEND ERROR:", e?.stack || e)
      return json({ error: { code: "INTERNAL", message: e.message } }, 500)
    }
}

function wsHandlers() {
  return {
    idleTimeout: 120,
    message(ws, raw) {
      let sig
      try {
        sig = JSON.parse(String(raw)).watch
      } catch {}
      if (typeof sig !== "string" || !SIG_RE.test(sig) || ws.data.sigs.size >= MAX_WATCHES_PER_SOCKET) return
      const t = txOutcome.get(sig)
      if (t?.outcome) return void ws.send(JSON.stringify({ sig, outcome: t.outcome }))
      ws.data.sigs.add(sig)
      if (!txWatchers.has(sig)) txWatchers.set(sig, new Set())
      txWatchers.get(sig).add(ws)
      if (!t) watchForeign(sig)
    },
    close(ws) {
      for (const sig of ws.data.sigs) {
        const set = txWatchers.get(sig)
        set?.delete(ws)
        if (set?.size === 0) txWatchers.delete(sig)
      }
    },
  }
}

function buildInitializeSolIx() {
  const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
  const [tT, ttb] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
  const [gC, gb] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  return new TransactionInstruction({
    programId: PROGRAM, keys: [
      { pubkey: tA, isSigner: false, isWritable: true },
      { pubkey: tT, isSigner: false, isWritable: true },
      { pubkey: gC, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data: Buffer.from([0, tb, ttb, gb])
  })
}

function hexToBuf(h) {
  return Buffer.from(String(h).replace(/^0x/i, ""), "hex")
}

// Token pools the app can pay in: decimals read once from the mint, symbol
// from Circle's USDC mints or TOKEN_SYMBOLS ("<mint>:USDC,..." for local test
// mints). A mint without a symbol is still listed, just unlabeled.
const KNOWN_SYMBOLS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
}
for (const pair of (process.env.TOKEN_SYMBOLS ?? "").split(",")) {
  const [mint, symbol] = pair.split(":").map((x) => x?.trim())
  if (mint && symbol) KNOWN_SYMBOLS[mint] = symbol
}
const mintMetas = new Map()
async function mintMeta(mint) {
  if (!mintMetas.has(mint)) {
    const info = await conn.getAccountInfo(new PublicKey(mint)).catch(() => null)
    // SPL mint layout: decimals is the u8 at offset 44
    if (!info || info.data.length < 45) return KNOWN_SYMBOLS[mint] ? { symbol: KNOWN_SYMBOLS[mint] } : {}
    mintMetas.set(mint, { decimals: info.data[44], ...(KNOWN_SYMBOLS[mint] ? { symbol: KNOWN_SYMBOLS[mint] } : {}) })
  }
  return mintMetas.get(mint)
}

// Setup txs (lookup tables, token accounts) aren't program txs, so the logs
// stream never settles them: poll their status until they land. Rare (once
// per mint, once per new withdrawal recipient), so the reads stay small.
async function setupOutcome(signature) {
  for (let i = 0; i < 75; i++) {
    const st = (await conn.getSignatureStatuses([signature])).value?.[0]
    if (st?.err) return "failed"
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return "confirmed"
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}
async function sendConfirmed(ixs) {
  const { signature } = await sendIxMany(ixs)
  const outcome = await setupOutcome(signature)
  if (outcome !== "confirmed") throw new Error(`setup tx ${signature} ${outcome ?? "not confirmed within 30s"}`)
  return signature
}

// Token accounts known to exist; single-flight per address so concurrent
// lanes never send the same create tx twice ("already been processed").
const knownAtas = new Set()
const ataInflight = new Map()
function ensureAta(mint, owner, ata = getAssociatedTokenAddressSync(mint, owner, true)) {
  const key = ata.toBase58()
  if (knownAtas.has(key)) return Promise.resolve()
  if (!ataInflight.has(key)) {
    ataInflight.set(key, (async () => {
      if (!(await conn.getAccountInfo(ata, "confirmed"))) {
        await sendConfirmed([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint)])
      }
      knownAtas.add(key)
    })().finally(() => ataInflight.delete(key)))
  }
  return ataInflight.get(key)
}

// SPL transact references a mint-specific splTree, so it needs a per-mint ALT to
// compress under Solana's 1232-byte tx limit. The mint-agnostic .env ALT won't
// match enough accounts. One table per mint, created once and kept in the state
// snapshot, so restarts reuse it.
const splAlts = new Map()
function ensureSplAlt(mint) {
  const key = mint.toBase58()
  if (!splAlts.has(key)) {
    splAlts.set(key, (async () => {
      const addr = splAltAddrs.get(key)
      const table = addr ? await lookupTableAccount(addr) : null
      if (table) return table
      const created = await createSplAlt(mint)
      splAltAddrs.set(key, created.key.toBase58())
      stateDirty = true
      return created
    })().catch((e) => {
      splAlts.delete(key)
      throw e
    }))
  }
  return splAlts.get(key)
}

async function createSplAlt(mint) {
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const [splTree] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
  const treeAta = getAssociatedTokenAddressSync(mint, globalCfg, true)
  const feeAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true)
  const altAddrs = [
    PROGRAM, globalCfg, splTree, treeAta, payer.publicKey, feeAta, mint, SystemProgram.programId,
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    ComputeBudgetProgram.programId,
  ]
  const slot = await conn.getSlot("confirmed")
  const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot - 1 })
  await sendConfirmed([createIx])
  for (let i = 0; i < altAddrs.length; i += 20) {
    await sendConfirmed([AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: altAddr, addresses: altAddrs.slice(i, i + 20) })])
  }
  await new Promise((r) => setTimeout(r, 1500))
  return (await conn.getAddressLookupTable(altAddr)).value
}

/** Shape check at the boundary: a malformed relay body is a 400, not a crash. */
function relayBodyError(body) {
  const hex = (v) => typeof v === "string" && /^(0x)?[0-9a-fA-F]*$/.test(v)
  for (const k of ["proof_a", "proof_b", "proof_c", "root", "public_amount", "ext_data_hash"]) {
    if (!hex(body?.[k]) || body[k].replace(/^0x/i, "").length === 0) return `${k} must be hex`
  }
  for (const k of ["input_nullifiers", "output_commitments"]) {
    if (!Array.isArray(body[k]) || body[k].length !== 2 || !body[k].every(hex)) return `${k} must be 2 hex strings`
  }
  for (const k of ["encrypted_output1", "encrypted_output2"]) if (body[k] != null && !hex(body[k])) return `${k} must be hex`
  if (typeof body.recipient !== "string") return "recipient required"
  return null
}

// ---- private swap (instruction 7): Jupiter route + relayer-signed v1 tx ----
// Jupiter only routes mainnet liquidity; SWAP_ENABLED=0 (devnet) answers with
// a clear error instead of a quote no devnet pool can fill.
const SWAP_ENABLED = process.env.SWAP_ENABLED !== "0"
const JUPITER_API = process.env.JUPITER_API ?? "https://lite-api.jup.ag/swap/v1"
const SOL_MIXER_MINT = "11111111111111111111111111111112"
const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112"
const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
const SWAP_CU_LIMIT = 1_400_000
const MAX_ROUTE_ACCOUNTS = 64

function swapDisabled() {
  return Object.assign(new Error("private swap is available on mainnet only (Jupiter has no devnet liquidity)"), { status: 503, code: "SWAP_UNAVAILABLE" })
}

/** Quote SOL<->SPL for the pool (global config is the Jupiter user) and return the route instruction. */
async function jupiterRoute(body) {
  if (!SWAP_ENABLED) throw swapDisabled()
  const amount = String(body?.amount ?? "")
  if (!/^[1-9]\d*$/.test(amount)) throw Object.assign(new Error("amount must be a positive integer"), { status: 400, code: "BAD_REQUEST" })
  for (const k of ["inputMint", "outputMint"]) new PublicKey(String(body[k]))
  const slippage = Math.min(Math.max(Number(body.slippageBps ?? 100) | 0, 1), 5000)
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const q = new URLSearchParams({
    inputMint: body.inputMint, outputMint: body.outputMint, amount, slippageBps: String(slippage),
    maxAccounts: "32", onlyDirectRoutes: "true", dexes: "Raydium,Raydium CLMM,Orca,Whirlpool,Meteora,Meteora DLMM",
  })
  const quote = await (await fetch(`${JUPITER_API}/quote?${q}`)).json()
  if (quote.error || !quote.outAmount) throw Object.assign(new Error(`jupiter quote: ${quote.error ?? "no route"}`), { status: 502, code: "JUPITER" })
  const ixs = await (await fetch(`${JUPITER_API}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: globalCfg.toBase58(), wrapAndUnwrapSol: false }),
  })).json()
  const swapIx = ixs.swapInstruction
  if (!swapIx?.data) throw Object.assign(new Error("jupiter returned no swap instruction"), { status: 502, code: "JUPITER" })
  return {
    minOut: String(quote.otherAmountThreshold ?? quote.outAmount),
    outAmount: String(quote.outAmount),
    route_data: Buffer.from(swapIx.data, "base64").toString("hex"),
    route_accounts: swapIx.accounts.map((a) => ({ pubkey: a.pubkey, isWritable: !!a.isWritable })),
  }
}

/** Bounded hex -> bytes; `len` exact when given. */
function hexField(name, v, { len, max = 1024 } = {}) {
  const h = String(v ?? "").replace(/^0x/i, "")
  const bad = !/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0 || (len !== undefined ? h.length !== len * 2 : h.length / 2 > max)
  if (bad) throw Object.assign(new Error(`${name} must be ${len ?? `<= ${max}`} bytes of hex`), { status: 400, code: "BAD_REQUEST" })
  return Buffer.from(h, "hex")
}

/** Compressed swap proof leg: a 32, b 64, c 32 + the 7 public inputs (352 bytes). */
function swapProofBytes(name, p) {
  const pi = (k) => hexField(`${name}.${k}`, p?.[k], { len: 32 })
  if (!Array.isArray(p?.input_nullifiers) || p.input_nullifiers.length !== 2 || !Array.isArray(p?.output_commitments) || p.output_commitments.length !== 2) {
    throw Object.assign(new Error(`${name} needs 2 input_nullifiers and 2 output_commitments`), { status: 400, code: "BAD_REQUEST" })
  }
  const nfs = p.input_nullifiers.map((h, i) => hexField(`${name}.input_nullifiers[${i}]`, h, { len: 32 }))
  const cms = p.output_commitments.map((h, i) => hexField(`${name}.output_commitments[${i}]`, h, { len: 32 }))
  return {
    nfs,
    bytes: Buffer.concat([
      hexField(`${name}.proof_a`, p.proof_a, { len: 32 }), hexField(`${name}.proof_b`, p.proof_b, { len: 64 }),
      hexField(`${name}.proof_c`, p.proof_c, { len: 32 }), pi("root"), pi("public_amount"), pi("ext_data_hash"), ...nfs, ...cms,
    ]),
  }
}

/** Build, sign (relayer) and send one v1 swap packet; same layout main's relayer builds. */
async function relaySwap(body) {
  if (!SWAP_ENABLED) throw swapDisabled()
  const bad = (m) => Object.assign(new Error(m), { status: 400, code: "BAD_REQUEST" })
  const proofIn = swapProofBytes("proof_in", body?.proof_in)
  const proofOut = swapProofBytes("proof_out", body?.proof_out)
  const extIn = BigInt(String(body.ext_amount_in ?? "x").match(/^-\d+$/)?.[0] ?? (() => { throw bad("ext_amount_in must be a negative integer") })())
  const extOut = BigInt(String(body.ext_amount_out ?? "x").match(/^\d+$/)?.[0] ?? (() => { throw bad("ext_amount_out must be a positive integer") })())
  const encs = ["encrypted_output_in1", "encrypted_output_in2", "encrypted_output_out1", "encrypted_output_out2"].map((k) => hexField(k, body[k], { max: 512 }))
  const routeData = hexField("route_data", body.route_data, { max: 1024 })
  const routeAccounts = Array.isArray(body.route_accounts) ? body.route_accounts : []
  if (routeAccounts.length === 0 || routeAccounts.length > MAX_ROUTE_ACCOUNTS) throw bad(`route_accounts must hold 1..${MAX_ROUTE_ACCOUNTS} accounts`)
  const solToSpl = body.from_mint === SOL_MIXER_MINT && body.out_mint !== SOL_MIXER_MINT
  const splToSol = body.from_mint !== SOL_MIXER_MINT && body.out_mint === SOL_MIXER_MINT
  if (!solToSpl && !splToSol) throw bad("swap is SOL to SPL or SPL to SOL only")
  const splMint = new PublicKey(solToSpl ? body.out_mint : body.from_mint)
  const nativeMint = new PublicKey(JUPITER_SOL_MINT)

  // spent-elsewhere / in-flight check, as for withdrawals
  const nfs = [...proofIn.nfs, ...proofOut.nfs].map((b) => b.toString("hex"))
  for (const hex of nfs) {
    const by = spentBy(hex)
    if (by) throw Object.assign(new Error(`one of the input nullifiers has already been spent (by tx ${by})`), { status: 409, code: "NULLIFIER_SPENT" })
  }

  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)
  const [solTree] = pda(Buffer.from("merkle_tree"))
  const [splTree] = pda(Buffer.from("merkle_tree"), splMint.toBytes())
  const [treeToken] = pda(Buffer.from("tree_token"))
  const [globalCfg] = pda(Buffer.from("global_config"))
  const poolWsol = getAssociatedTokenAddressSync(nativeMint, globalCfg, true)
  const poolSpl = getAssociatedTokenAddressSync(splMint, globalCfg, true)
  const accIn = deriveAccounts(PROGRAM, proofIn.nfs[0], proofIn.nfs[1])
  const accOut = deriveAccounts(PROGRAM, proofOut.nfs[0], proofOut.nfs[1])
  const RO = 0, W = 1, WS = 3
  // 17 fixed accounts (program swap.rs), then the route's extra accounts
  const keys = [
    [solToSpl ? solTree : splTree, W], [accIn.nullifier0, W], [accIn.nullifier1, W],
    [accOut.nullifier0, W], [accOut.nullifier1, W],
    [treeToken, W], [solToSpl ? splTree : solTree, W], [globalCfg, W], [nativeMint, RO], [poolWsol, W],
    [splMint, RO], [poolSpl, W], [payer.publicKey, WS], [JUPITER_PROGRAM, RO], [TOKEN_PROGRAM, RO],
    [ATA_PROGRAM, RO], [SystemProgram.programId, RO],
  ].map(([pk, role]) => ({ pk, role }))
  const jupIdx = []
  for (const a of routeAccounts) {
    const pk = new PublicKey(String(a.pubkey))
    // the program rejects any signer in the route (swap.rs invoke_route); refuse
    // here too so a crafted route can't make the relayer pay for a doomed tx
    if (pk.equals(payer.publicKey)) throw bad("route may not reference the relayer")
    const writable = !!(a.isWritable ?? a.is_writable)
    const at = keys.findIndex((k) => k.pk.equals(pk))
    if (at >= 0) {
      if (writable) keys[at].role |= W
      jupIdx.push(at | (writable ? 0x80 : 0))
    } else {
      jupIdx.push(keys.length | (writable ? 0x80 : 0))
      keys.push({ pk, role: writable ? W : RO })
    }
  }
  const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b }
  const lp = (b) => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]) }
  const data = Buffer.concat([
    Buffer.from([7]), proofIn.bytes, proofOut.bytes, i64le(extIn), i64le(extOut),
    Buffer.from([accIn.bump0, accIn.bump1, accOut.bump0, accOut.bump1]),
    ...encs.map(lp), lp(routeData), lp(Buffer.from(jupIdx)),
  ])
  const ix = (programId, accounts, d) => ({ programId, accounts: accounts.map(([address, role]) => ({ address, role })), data: d })
  const createAtaIdem = (mint, a) => ix(ATA_PROGRAM, [[payer.publicKey, WS], [a, W], [globalCfg, RO], [mint, RO], [SystemProgram.programId, RO], [TOKEN_PROGRAM, RO]], Buffer.from([1]))
  const instructions = [createAtaIdem(nativeMint, poolWsol), createAtaIdem(splMint, poolSpl)]
  if (solToSpl) {
    const amt = Buffer.alloc(8); amt.writeBigUInt64LE(-extIn)
    // wrap_sol checks (instructions sysvar) that SyncNative + this swap follow, for this amount
    instructions.push(ix(PROGRAM, [[treeToken, W], [poolWsol, W], [nativeMint, RO], [payer.publicKey, WS], [TOKEN_PROGRAM, RO], [SystemProgram.programId, RO], [SYSVAR_INSTRUCTIONS_PUBKEY, RO]], Buffer.concat([Buffer.from([8]), amt])))
    instructions.push(ix(TOKEN_PROGRAM, [[poolWsol, W]], Buffer.from([17]))) // SyncNative
  }
  instructions.push({ programId: PROGRAM, accounts: keys.map((k) => ({ address: k.pk, role: k.role })), data })

  const { blockhash } = await recentBlockhash()
  let tx
  try {
    tx = buildV1Tx(payer, blockhash, instructions, { cuLimit: SWAP_CU_LIMIT, loadedDataSize: 64 * 1024 * 1024 })
  } catch (e) {
    throw bad(`${e.message}; request a route with fewer accounts`)
  }
  for (const hex of nfs) inflight.set(hex, { sig: "pending", at: Date.now() })
  try {
    const sig = await sendRawWithRetry(Buffer.from(tx.bytes), { skipPreflight: true, maxRetries: 5 })
    for (const hex of nfs) inflight.set(hex, { sig, at: Date.now() })
    absorb(sig, () => nfs.forEach((hex) => inflight.delete(hex)))
    return { signature: sig, status: "submitted", size: tx.size }
  } catch (e) {
    for (const hex of nfs) inflight.delete(hex)
    throw e
  }
}

async function relayWithdraw(body) {
  const bad = relayBodyError(body)
  if (bad) throw Object.assign(new Error(bad), { status: 400, code: "BAD_REQUEST" })
  const nfs = (body.input_nullifiers ?? []).map((h) => String(h).replace(/^0x/i, "").toLowerCase())
  for (const hex of nfs) {
    const by = spentBy(hex)
    if (by) {
      throw Object.assign(new Error(`one of the input nullifiers has already been spent (by tx ${by})`), {
        status: 409,
        code: "NULLIFIER_SPENT",
      })
    }
  }
  for (const hex of nfs) inflight.set(hex, { sig: "pending", at: Date.now() })
  const t0 = Date.now()
  try {
    const res = await relayWithdrawInner(body)
    for (const hex of nfs) inflight.set(hex, { sig: res.signature, at: Date.now() })
    relayedAt.set(res.signature, t0)
    absorb(res.signature, () => nfs.forEach((hex) => inflight.delete(hex)))
    return res
  } catch (e) {
    for (const hex of nfs) inflight.delete(hex)
    throw e
  }
}

async function relayWithdrawInner(body) {
  const kind = String(body.kind || "").toLowerCase()
  // ext < 0: public withdrawal (SOL moves to the recipient). ext == 0:
  // shielded note transfer (payroll payouts — nothing public moves).
  if (Number(body.ext_amount) > 0) {
    throw new Error("relayer only handles withdrawals and shielded transfers (ext_amount must be <= 0)")
  }
  const proof = {
    proofA: [...hexToBuf(body.proof_a)],
    proofB: [...hexToBuf(body.proof_b)],
    proofC: [...hexToBuf(body.proof_c)],
    root: [...hexToBuf(body.root)],
    publicAmount: [...hexToBuf(body.public_amount)],
    extDataHash: [...hexToBuf(body.ext_data_hash)],
    inputNullifiers: [[...hexToBuf(body.input_nullifiers[0])], [...hexToBuf(body.input_nullifiers[1])]],
    outputCommitments: [[...hexToBuf(body.output_commitments[0])], [...hexToBuf(body.output_commitments[1])]],
  }
  const enc1 = hexToBuf(body.encrypted_output1)
  const enc2 = hexToBuf(body.encrypted_output2)
  const extAmount = BigInt(body.ext_amount)
  const fee = BigInt(body.fee)
  const BN = (await import("bn.js")).default
  const extBN = new BN(extAmount.toString())
  const feeBN = new BN(fee.toString())

  const n0 = Uint8Array.from(proof.inputNullifiers[0])
  const n1 = Uint8Array.from(proof.inputNullifiers[1])
  for (const nf of [n0, n1]) {
    const by = indexer.nullifiers.get(Buffer.from(nf).toString("hex"))
    if (by) throw Object.assign(new Error(`one of the input nullifiers has already been spent (by tx ${by})`), { status: 409, code: "NULLIFIER_SPENT" })
  }
  const rootHex = Buffer.from(proof.root).toString("hex")
  const treeKey = kind === "spl" ? String(body.mint) : "sol"
  const known = indexer.pools.get(treeKey)?.roots
  if (known && known.length >= ROOT_HISTORY && !known.includes(rootHex)) {
    throw Object.assign(new Error("proof root is not in the root history (tree may have advanced)"), { status: 400, code: "UNKNOWN_ROOT" })
  }
  const accounts = deriveAccounts(PROGRAM, n0, n1)

  // No compute-budget ix: a transact (~136-145k CU) fits the 200k default per
  // instruction, and the ~40 bytes keep worst-case SPL payouts under 1232.
  const ixs = []

  if (kind === "sol") {
    const recipient = new PublicKey(body.recipient)
    const feeRecipient = payer.publicKey
    const data = buildTransactIxData(false, proof, extBN, feeBN, enc1, enc2, accounts.bump0, accounts.bump1)
    ixs.push(new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: accounts.treeAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.nullifier0, isSigner: false, isWritable: true },
        { pubkey: accounts.nullifier1, isSigner: false, isWritable: true },
        { pubkey: accounts.treeTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }))
  } else if (kind === "spl") {
    const mint = new PublicKey(body.mint)
    const owner = new PublicKey(body.recipient_owner)
    const recipientAta = new PublicKey(body.recipient)
    const feeAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true)
    const signerAta = getAssociatedTokenAddressSync(mint, payer.publicKey)

    // The program reads the relayer's token account (signer + fee ATA, one
    // address) on every SPL transact; the recipient's only receives tokens on
    // a withdrawal, so shielded payouts never pay rent for employee ATAs.
    // Both land (confirmed) before the transact, never racing it.
    await Promise.all([
      ensureAta(mint, payer.publicKey, feeAta),
      extAmount < 0n && recipientAta.equals(getAssociatedTokenAddressSync(mint, owner, true))
        ? ensureAta(mint, owner, recipientAta)
        : null,
    ])

    const { ix: splIx } = buildTransactSplInstruction({
      connection: conn,
      programId: PROGRAM,
      signer: payer.publicKey,
      isSpl: true,
      proof,
      extAmount: extBN,
      fee: feeBN,
      encryptedOutput1: enc1,
      encryptedOutput2: enc2,
      recipient: owner,
      feeRecipient: payer.publicKey,
      mint,
      signerTokenAccount: signerAta,
      recipientTokenAccount: recipientAta,
      feeRecipientAta: feeAta,
    })
    ixs.push(splIx)
    // SPL transact references a mint-specific splTree; use a per-mint ALT so the
    // tx compresses under Solana's 1232-byte limit (the .env ALT is mint-agnostic).
    const splAlt = await ensureSplAlt(mint)
    return sendIxMany(ixs, splAlt)
  } else {
    throw new Error(`kind must be sol or spl, got ${kind}`)
  }

  return sendIxMany(ixs)
}

async function sendIxMany(ixs, altAccount = null) {
  const { blockhash } = await recentBlockhash()
  const alts = []
  if (altAccount) {
    alts.push(altAccount)
  } else {
    // Fall back to the .env ALT (e.g. for SOL, which is mint-agnostic).
    const altAddr = process.env.ALT_ADDRESS ?? readDotEnv().VITE_ALT_ADDRESS ?? null
    if (altAddr) {
      const table = await lookupTableAccount(altAddr)
      if (table) alts.push(table)
    }
  }
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  tx.sign([payer])
  // answer on broadcast; relayWithdraw tracks the outcome (absorb)
  const sig = await sendRawWithRetry(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  return { signature: sig, slot: null, status: "submitted" }
}
