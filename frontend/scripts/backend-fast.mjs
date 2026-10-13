// Fast local backend: same routes as backend-shim.mjs, but the chain mirror is
// an in-memory incremental tree fed by push (websocket logs + the relayer's
// own sends) and ordered exactly as the chain executed (fast-indexer.mjs).
// Paths, roots, commitments and nullifiers are answered from memory; the
// relay answers the moment the tx is broadcast. Run: bun scripts/backend-fast.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import { FastIndexer, ROOT_HISTORY } from "./fast-indexer.mjs"
import { startGrpcSource } from "./grpc-source.mjs"

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

// Recipient registry: in-memory, optionally seeded from a JSON file
// (wallet -> {note_pubkey, enc_pubkey}) so test employees can be enrolled
// without running the employee app. Enrollments via PUT are additive.
const recipients = new Map()
try {
  const rf = process.env.RECIPIENTS_FILE
  if (rf && existsSync(rf)) {
    for (const [w, k] of Object.entries(JSON.parse(readFileSync(rf, "utf8")))) {
      recipients.set(w, k)
    }
    console.log(`loaded ${recipients.size} recipients from ${rf}`)
  }
} catch (e) {
  console.error("recipients seed load failed:", e.message)
}
const wasm = await WasmFactory.getInstance()

const dec2hex = (dec) => "0x" + BigInt(dec).toString(16).padStart(64, "0")
const dec2hexU = (dec) => BigInt(dec).toString(16).padStart(64, "0").toUpperCase()
const be = (b) => { let r = 0n; for (const x of b) r = (r << 8n) + BigInt(x); return r }
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-password",
  "access-control-max-age": "86400",
}
const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status,
  headers: { "content-type": "application/json", ...corsHeaders },
})
/** @type {Map<string, { ciphertext: string, updatedAt: string }>} */
const noteBlobs = new Map()

// surfpool (a mainnet-forking local validator) lazy-loads referenced accounts from
// api.mainnet-beta.solana.com on demand; if that fetch is slow/offline it rejects the
// tx with "Failed to fetch accounts from remote". Retry on that (and 429/timeout).
async function sendRawWithRetry(serialized, opts, attempts = 7) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await conn.sendRawTransaction(serialized, opts)
    } catch (e) {
      lastErr = e
      const msg = String(e?.message ?? e)
      if (/Failed to fetch accounts from remote|mainnet-beta|429|Too Many|timeout|error sending request/i.test(msg)) {
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
const indexer = new FastIndexer({ conn, program: PROGRAM, wasm, pollMs: Number(process.env.POLL_MS ?? 1000) })
await indexer.start()
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

// Blockhash cache: relays never wait on getLatestBlockhash.
let cachedBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash
setInterval(() => {
  conn.getLatestBlockhash("confirmed").then((b) => (cachedBlockhash = b.blockhash)).catch(() => {})
}, 2000)

/** Background: once `sig` confirms, pull it into the mirror right away. */
function absorb(sig, onFailed) {
  conn
    .confirmTransaction(sig, "confirmed")
    .then((r) => {
      if (r?.value?.err) onFailed?.()
    })
    .catch(() => {})
    .finally(() => indexer.sync().catch(() => {}))
}

// Nullifiers of relayed txs the mirror hasn't indexed yet. They count as
// spent everywhere (relay guard + nullifier queries): otherwise a ledger
// refresh in that window resurrects the note and a second lane re-spends it
// in the same slot (AccountAlreadyInitialized on-chain). Cleared when the tx
// fails on-chain or after the TTL; indexed ones fall through to the mirror.
const INFLIGHT_TTL_MS = 90_000
/** nullifier hex -> { sig, at } */
const inflight = new Map()
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

Bun.serve({
  port: PORT,
  idleTimeout: 120, // Merkle/ZK witness gen can exceed Bun's 10s default
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    const method = req.method
    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    try {
      if (p === "/health") return json({ status: "ok" })

      // Local prover telemetry: failing circuit inputs land in
      // /tmp/prover-failures.json for offline diagnosis.
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
          pools: [...indexer.pools.values()].map((q) => ({ tree_key: q.treeKey, leaves: q.leaves.length, root: q.root() })) })
      }

      // Encrypted note blob backup (in-memory for local shim)
      if (p === "/api/notes" && method === "PUT") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const wallet = String(body.wallet || "").trim()
        const ciphertext = String(body.ciphertext || "").trim()
        if (!wallet || !ciphertext) {
          return json({ error: { code: "BAD_REQUEST", message: "wallet and ciphertext required" } }, 400)
        }
        noteBlobs.set(wallet, { ciphertext, updatedAt: new Date().toISOString() })
        return new Response(null, { status: 204, headers: corsHeaders })
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
        return json({ program_id: PROGRAM.toBase58(), fee_recipient: payer.publicKey.toBase58(), fee_rate_bps: 0, withdrawal_fee_rate_bps: fees.withdrawalFeeRateBps, fee_error_margin_bps: fees.feeErrorMarginBps, supported_mints: [] })
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
        if (!spent) {
          const h = Buffer.from(hex, "hex")
          const [p0] = PublicKey.findProgramAddressSync([Buffer.from("nullifier0"), h], PROGRAM)
          const [p1] = PublicKey.findProgramAddressSync([Buffer.from("nullifier1"), h], PROGRAM)
          spent = !!(await conn.getAccountInfo(p0)) || !!(await conn.getAccountInfo(p1))
        }
        return json({ nullifier: hex, spent, signature })
      }
      if (p === "/api/nullifiers/batch" && method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const hashes = Array.isArray(body.hashes) ? body.hashes : []
        return json({ results: hashes.map((raw) => {
          const hex = String(raw).replace(/^0x/i, "")
          const signature = spentBy(hex)
          return { hash: hex, spent: signature !== null, signature }
        }) })
      }
      if (p === "/api/indexer/kick" && method === "POST") {
        const n0 = indexer.applied
        await indexer.sync()
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
        const wallet = String(body.wallet || "")
        const note = String(body.note_pubkey || "")
        const enc = String(body.enc_pubkey || "")
        if (!wallet || !note || !enc) {
          return json({ error: { code: "BAD_REQUEST", message: "wallet, note_pubkey, enc_pubkey required" } }, 400)
        }
        recipients.set(wallet, { note_pubkey: note, enc_pubkey: enc })
        return json({ ok: true })
      }

      // ---- relay endpoints the backend-only client SDK calls ----
      if (p === "/api/relayer/blockhash" && method === "GET") {
        const { blockhash } = await conn.getLatestBlockhash()
        const slot = await conn.getSlot("confirmed")
        return json({ blockhash, last_valid_block_height: 0, slot })
      }
      const altm = p.match(/^\/api\/relayer\/alt\/([^/]+)$/)
      if (altm && method === "GET") {
        const acct = await conn.getAccountInfo(new PublicKey(altm[1]))
        if (!acct) return json({ exists: false, data_hex: "" })
        return json({ exists: true, data_hex: Buffer.from(acct.data).toString("hex") })
      }

      // ---- POST setup/config (payer = authority signs) ----
      if (method === "POST") {
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
          const sig = await sendRawWithRetry(vtx.serialize(), { skipPreflight: true, maxRetries: 5 })
          try { await conn.confirmTransaction(sig, "confirmed") } catch { }
          await indexer.sync()
          return json({ signature: sig, slot: null, status: "submitted" })
        }

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
          return json(await sendIx(new TransactionInstruction({
            programId: PROGRAM, keys: [
              { pubkey: treeAccount, isSigner: false, isWritable: true },
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: gC, isSigner: false, isWritable: false },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ], data
          })))
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
      if (e?.status) return json({ error: { code: e.code, message: e.message } }, e.status)
      console.error("FAST BACKEND ERROR:", e?.stack || e)
      return json({ error: { code: "INTERNAL", message: e.message } }, 500)
    }
  },
})
console.log(`backend-fast listening on :${PORT} (program ${PROGRAM.toBase58()})`)

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

// SPL transact references a mint-specific splTree, so it needs a per-mint ALT to
// compress under Solana's 1232-byte tx limit. The mint-agnostic .env ALT won't
// match enough accounts. Build one matching buildTransactSplInstruction's accounts.
async function ensureSplAlt(mint) {
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
  await sendIxMany([createIx])
  for (let i = 0; i < altAddrs.length; i += 20) {
    await sendIxMany([AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: altAddr, addresses: altAddrs.slice(i, i + 20) })])
  }
  await new Promise((r) => setTimeout(r, 1500))
  return (await conn.getAddressLookupTable(altAddr)).value
}

async function relayWithdraw(body) {
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
  try {
    const res = await relayWithdrawInner(body)
    for (const hex of nfs) inflight.set(hex, { sig: res.signature, at: Date.now() })
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

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]

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
        { pubkey: accounts.nullifier2, isSigner: false, isWritable: false },
        { pubkey: accounts.nullifier3, isSigner: false, isWritable: false },
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

    // Ensure recipient + relayer fee ATAs exist in their own tx first, so the SPL
    // transact tx stays within @solana/web3.js v0 message-serialize limits.
    await sendIxMany([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, recipientAta, owner, mint),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeAta, payer.publicKey, mint),
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
  const blockhash = cachedBlockhash
  const alts = []
  if (altAccount) {
    alts.push(altAccount)
  } else {
    // Fall back to the .env ALT (e.g. for SOL, which is mint-agnostic).
    const altAddr = process.env.ALT_ADDRESS ?? readDotEnv().VITE_ALT_ADDRESS ?? null
    if (altAddr) {
      const fetched = await conn.getAddressLookupTable(new PublicKey(altAddr))
      if (fetched.value) alts.push(fetched.value)
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
