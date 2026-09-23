// Lightweight read-only + setup backend for LOCAL testing on surfpool (no Yellowstone).
// Reads everything from the on-chain program via RPC: root/fees from the tree
// account + global config, commitments/nullifiers by scanning the program's tx
// history. Also signs setup/config ixs (initialize, initialize-spl, update-*).
// Serves the same routes the client SDK + admin cards call. Run: bun scripts/backend-shim.mjs
import { readFileSync, existsSync, writeFileSync } from "node:fs"
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

import {
  LocalMirror, readGlobalFees, readTreeState, deriveAccounts,
  MERKLE_TREE_DEPTH, buildTransactIxData, buildTransactSplInstruction,
  buildSwapTransaction, signWireTransaction,
} from "privacy-cash-sdk"

const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? "5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P")
const RPC = process.env.SOLANA_RPC_URL ?? "http://localhost:8899"
const PORT = Number(process.env.PORT ?? 8080)
const idJson = process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json")
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const PROVE_URL = process.env.PROVE_URL ?? null
const releaseBin = path.join(repoRoot, "crates/privacy-cash-prover/target/release/privacy-cash-prover")
const debugBin = path.join(repoRoot, "crates/privacy-cash-prover/target/debug/privacy-cash-prover")
const PROVER_BIN = process.env.PROVER_BIN ?? (existsSync(releaseBin) ? releaseBin : debugBin)

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
const wasm = await WasmFactory.getInstance()

// Rent-exempt minimum for one 1-byte NullifierAccount: (128 + 1) * 3480 * 2. The
// account is never closed, so whoever signs a transact pays this twice and never
// gets it back — which is the entire reason a relayed spend has to carry a fee.
const NULLIFIER_RENT_LAMPORTS = 897_840
const TRANSACT_RENT_LAMPORTS = NULLIFIER_RENT_LAMPORTS * 2

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
/** @type {Map<string, { spend_pubkey: string, viewing_pubkey: string }>} */
const registry = new Map()
const REG_FILE = path.join(repoRoot, "frontend/.local-registry.json")
try {
  if (existsSync(REG_FILE)) {
    const saved = JSON.parse(readFileSync(REG_FILE, "utf8"))
    for (const [k, v] of Object.entries(saved ?? {})) {
      if (v && typeof v === "object") registry.set(k, v)
    }
    if (registry.size) console.log(`loaded ${registry.size} registered viewing keys`)
  }
} catch (e) {
  console.warn("registry load:", e.message)
}
function saveRegistry() {
  try {
    writeFileSync(REG_FILE, JSON.stringify(Object.fromEntries(registry), null, 2))
  } catch (e) {
    console.warn("registry save:", e.message)
  }
}

// surfpool (a mainnet-forking local validator) lazy-loads referenced accounts from
// api.mainnet-beta.solana.com on demand; if that fetch is slow/offline it rejects the
// tx with "Failed to fetch accounts from remote". Retry on that (and 429/timeout).
async function sendRawWithRetry(serialized, opts, attempts = 7) {
  let lastErr
  const bytes = Buffer.from(serialized)
  for (let i = 0; i < attempts; i++) {
    try {
      // v1 packets exceed 1232; send via JSON-RPC base64 so web3.js cannot
      // reject them as legacy/v0 wire format.
      if (bytes[0] === 0x81 || bytes.length > 1232) {
        const res = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [
              bytes.toString("base64"),
              {
                encoding: "base64",
                skipPreflight: opts?.skipPreflight ?? true,
                maxRetries: opts?.maxRetries ?? 5,
              },
            ],
          }),
        })
        const json = await res.json()
        if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error))
        return json.result
      }
      return await conn.sendRawTransaction(bytes, opts)
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
  try { await conn.confirmTransaction(sig, "confirmed") } catch { }
  const slot = await conn.getSlot("confirmed")
  return { signature: sig, slot, status: "confirmed" }
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
/** @type {{ treeKey: string, leafIndex: number, commitment: string, encryptedHex: string, signature: string, slot: number }[]} */
let utxos = []
let nullifiers = new Set()
let lastSlot = 0
let lastSig = null
/** @type {Map<string, import('privacy-cash-sdk').LocalMirror>} */
let mirrors = new Map()

function treeKeyForDisc(disc, accountKeys, mintIndexHint) {
  if (disc === 2) return "sol"
  // TransactSpl: mint is account index 7 in the ix keys (see buildTransactSplInstruction)
  try {
    const mintPk = accountKeys[mintIndexHint]
    return mintPk ? mintPk.toBase58() : "spl-unknown"
  } catch {
    return "spl-unknown"
  }
}

function resolveKeys(msg, meta) {
  const staticKeys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) =>
    k.pubkey ? new PublicKey(k.pubkey) : new PublicKey(k),
  )
  const writable = (meta?.loadedAddresses?.writable ?? []).map((k) => new PublicKey(k))
  const readonly = (meta?.loadedAddresses?.readonly ?? []).map((k) => new PublicKey(k))
  return [...staticKeys, ...writable, ...readonly]
}

const V1_PREFIX = 0x81
const V1_CONFIG_CU_LIMIT = 1 << 2
const V1_CONFIG_LOADED_ACCOUNTS = 1 << 3

/** SIMD-0385 v1 unsigned/signed wire → { allKeys, ixs }. Signatures may be appended. */
function parseV1Ixs(wire) {
  if (!wire || wire[0] !== V1_PREFIX) return null
  let o = 1
  o += 3 // numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
  const configMask = wire.readUInt32LE(o)
  o += 4
  o += 32 // blockhash
  const nIx = wire[o++]
  const nAcct = wire[o++]
  const allKeys = []
  for (let i = 0; i < nAcct; i++) {
    allKeys.push(new PublicKey(wire.subarray(o, o + 32)))
    o += 32
  }
  if (configMask & V1_CONFIG_CU_LIMIT) o += 4
  if (configMask & V1_CONFIG_LOADED_ACCOUNTS) o += 4
  const headers = []
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = wire[o++]
    const nKeys = wire[o++]
    const dataLen = wire.readUInt16LE(o)
    o += 2
    headers.push({ programIdIndex, nKeys, dataLen })
  }
  const ixs = []
  for (const h of headers) {
    const accountKeyIndexes = [...wire.subarray(o, o + h.nKeys)]
    o += h.nKeys
    const data = Buffer.from(wire.subarray(o, o + h.dataLen))
    o += h.dataLen
    ixs.push({ programIdIndex: h.programIdIndex, accountKeyIndexes, accounts: accountKeyIndexes, data })
  }
  return { allKeys, ixs }
}

async function fetchTxWireBase64(signature) {
  const rpc = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
    }),
  })
  const j = await rpc.json()
  const b64 = j?.result?.transaction?.[0]
  return b64 ? Buffer.from(b64, "base64") : null
}

async function rescan() {
  const sigs = await conn.getSignaturesForAddress(PROGRAM, { limit: 1000 }, "confirmed")
  lastSlot = sigs[0]?.slot ?? lastSlot
  lastSig = sigs[0]?.signature ?? lastSig
  const ordered = sigs.filter((s) => !s.err).reverse()
  const newUtxos = []
  const newNulls = new Set()
  const perTree = new Map() // treeKey -> commitment decimals[]

  for (const s of ordered) {
    let t = null
    try {
      t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
    } catch {
      t = null
    }
    if (!t) {
      try {
        const rpc = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
          }),
        })
        t = (await rpc.json()).result
      } catch {
        continue
      }
    }
    if (!t) continue
    const msg = t.transaction.message
    const meta = t.meta
    let allKeys = resolveKeys(msg, meta)
    let ixs = msg.compiledInstructions ?? msg.instructions ?? []
    if (t.version === 1 || t.version === "1") {
      try {
        const wire = await fetchTxWireBase64(s.signature)
        const parsed = parseV1Ixs(wire)
        if (parsed) {
          allKeys = parsed.allKeys
          ixs = parsed.ixs
        }
      } catch (e) {
        console.error("v1 parse", s.signature.slice(0, 8), e.message)
      }
    }
    for (const ix of ixs) {
      const prog =
        allKeys[ix.programIdIndex] ??
        allKeys[ix.programIdIndex?.toString?.()]
      if (!prog || !prog.equals?.(PROGRAM)) {
        // legacy: may not have programIdIndex resolution — check data disc only
      }
      const raw = typeof ix.data === "string" ? Buffer.from(ix.data, "base64") : Buffer.from(ix.data)
      if (raw.length < 369) continue
      const disc = raw[0]
      if (disc !== 2 && disc !== 3 && disc !== 7) continue
      const args = raw.subarray(1)
      if (disc === 7) {
        if (args.length < 724) continue
        const mintIdx = ix.accountKeyIndexes?.[14] ?? ix.accounts?.[14]
        const mintPk = mintIdx != null ? allKeys[mintIdx] : null
        const splKey = mintPk ? mintPk.toBase58() : "spl-unknown"
        const inTreeIdx = ix.accountKeyIndexes?.[0] ?? ix.accounts?.[0]
        const inTreePk = inTreeIdx != null ? allKeys[inTreeIdx] : null
        const [splTree] = mintPk
          ? PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mintPk.toBytes()], PROGRAM)
          : [null]
        const inKey = inTreePk && splTree && inTreePk.equals?.(splTree) ? splKey : "sol"
        const outKey = inKey === "sol" ? splKey : "sol"
        let encOffset = 704 + 16 + 4
        const readLenPref = () => {
          const len = args.readUInt32LE(encOffset); encOffset += 4
          const slice = args.subarray(encOffset, encOffset + len); encOffset += len
          return slice
        }
        let encIn1, encIn2, encOut1, encOut2
        try {
          encIn1 = readLenPref(); encIn2 = readLenPref(); encOut1 = readLenPref(); encOut2 = readLenPref()
        } catch { continue }
        const pushPair = (treeKey, c0, c1, e0, e1, n0, n1) => {
          const base = perTree.get(treeKey)?.length ?? 0
          perTree.set(treeKey, [...(perTree.get(treeKey) ?? []), be(args.subarray(c0, c0 + 32)).toString(), be(args.subarray(c1, c1 + 32)).toString()])
          newUtxos.push({ treeKey, leafIndex: base, commitment: Buffer.from(args.subarray(c0, c0 + 32)).toString("hex"), encryptedHex: Buffer.from(e0).toString("hex"), signature: s.signature, slot: s.slot })
          newUtxos.push({ treeKey, leafIndex: base + 1, commitment: Buffer.from(args.subarray(c1, c1 + 32)).toString("hex"), encryptedHex: Buffer.from(e1).toString("hex"), signature: s.signature, slot: s.slot })
          newNulls.add(Buffer.from(args.subarray(n0, n0 + 32)).toString("hex"))
          newNulls.add(Buffer.from(args.subarray(n1, n1 + 32)).toString("hex"))
        }
        pushPair(inKey, 288, 320, encIn1, encIn2, 224, 256)
        pushPair(outKey, 640, 672, encOut1, encOut2, 576, 608)
        continue
      }
      // Transact / TransactSpl: compressed proof 352
      const c0 = be(args.subarray(288, 320)).toString()
      const c1 = be(args.subarray(320, 352)).toString()
      let offset = 352 + 16 // proof + ExtDataMinified
      const readLenPref = () => {
        const len = args.readUInt32LE(offset); offset += 4
        const slice = args.subarray(offset, offset + len); offset += len
        return slice
      }
      let enc1, enc2
      try {
        enc1 = readLenPref()
        enc2 = readLenPref()
      } catch {
        continue
      }

      // mint account index in TransactSpl keys list is 7
      let treeKey = "sol"
      if (disc === 3) {
        const mintIdx = ix.accountKeyIndexes?.[7] ?? ix.accounts?.[7]
        const mintPk = mintIdx != null ? allKeys[mintIdx] : null
        treeKey = mintPk ? mintPk.toBase58() : "spl-unknown"
      }

      const base = perTree.get(treeKey)?.length ?? 0
      perTree.set(treeKey, [...(perTree.get(treeKey) ?? []), c0, c1])
      newUtxos.push({
        treeKey,
        leafIndex: base,
        commitment: Buffer.from(args.subarray(288, 320)).toString("hex"),
        encryptedHex: Buffer.from(enc1).toString("hex"),
        signature: s.signature,
        slot: s.slot,
      })
      newUtxos.push({
        treeKey,
        leafIndex: base + 1,
        commitment: Buffer.from(args.subarray(320, 352)).toString("hex"),
        encryptedHex: Buffer.from(enc2).toString("hex"),
        signature: s.signature,
        slot: s.slot,
      })
      newNulls.add(Buffer.from(args.subarray(224, 256)).toString("hex"))
      newNulls.add(Buffer.from(args.subarray(256, 288)).toString("hex"))
    }
  }

  // Recompute leaf indices correctly in order
  const counts = new Map()
  utxos = newUtxos.map((u) => {
    const i = counts.get(u.treeKey) ?? 0
    counts.set(u.treeKey, i + 1)
    return { ...u, leafIndex: i }
  })
  nullifiers = newNulls
  mirrors = new Map()
  for (const [tk, commits] of perTree) {
    // rebuild commit list in leaf order from utxos
    const orderedCommits = utxos.filter((u) => u.treeKey === tk).map((u) => be(Buffer.from(u.commitment, "hex")).toString())
    mirrors.set(tk, LocalMirror.fromLeaves(wasm, orderedCommits))
  }
}
await rescan()
console.log(`indexed ${utxos.length} utxos across ${mirrors.size} trees, ${nullifiers.size} nullifiers`)
setInterval(() => { rescan().catch((e) => console.error("rescan:", e.message)) }, 4000)

async function proofFor(treeKey, idx) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (utxos.some((u) => u.treeKey === treeKey && u.leafIndex === idx) && mirrors.has(treeKey)) break
    await rescan()
    await new Promise((r) => setTimeout(r, 700))
  }
  const m = mirrors.get(treeKey)
  if (!m) return null
  try {
    const onChain = await readTreeState(conn, PROGRAM, treeKey)
    const mirrorRoot = m.root()
    const leafCount = utxos.filter((u) => u.treeKey === treeKey).length
    if (leafCount !== onChain.nextLeafIndex || mirrorRoot !== onChain.root) {
      throw new Error(
        `merkle indexer mismatch for ${treeKey}: indexed ${leafCount} leaves (mirror root ${mirrorRoot.slice(0, 12)}…) vs on-chain next_index=${onChain.nextLeafIndex}. Restart the shim or ./run.sh --fresh so the tree and indexer match.`,
      )
    }
    return {
      path_elements: m.path(idx).map(dec2hex),
      path_indices: Array.from({ length: MERKLE_TREE_DEPTH }, (_, i) => (idx >> i) & 1),
    }
  } catch (e) {
    if (/merkle indexer mismatch/.test(e.message)) throw e
    return null
  }
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

      if (p === "/indexer/status") return json({ last_signature: lastSig, last_slot: lastSlot, sol_utxo_count: utxos.length })

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
        return json({
          program_id: PROGRAM.toBase58(),
          fee_recipient: payer.publicKey.toBase58(),
          fee_rate_bps: 0,
          withdrawal_fee_rate_bps: fees.withdrawalFeeRateBps,
          fee_error_margin_bps: fees.feeErrorMarginBps,
          supported_mints: [],
          nullifier_rent_lamports: NULLIFIER_RENT_LAMPORTS,
          transact_rent_lamports: TRANSACT_RENT_LAMPORTS,
          estimated_tx_fee_lamports: 7_000,
          // The shim pays out of a funded local keypair, so it has no solvency
          // requirement. Reporting a real floor anyway keeps dev fee arithmetic
          // identical to production instead of only failing after deploy.
          min_transact_fee_lamports: TRANSACT_RENT_LAMPORTS + 7_000,
          spl_relay_available: true,
        })
      }

      const m = p.match(/^\/api\/merkle\/([^/]+)$/)
      if (m && method === "GET") {
        const treeKey = decodeURIComponent(m[1])
        try {
          const st = await readTreeState(conn, PROGRAM, treeKey)
          const count = utxos.filter((u) => u.treeKey === treeKey).length
          return json({ tree_key: treeKey, next_leaf_index: st.nextLeafIndex, current_root: dec2hexU(st.root), known_roots: [dec2hexU(st.root)], leaf_count: count })
        } catch (e) {
          return json({ error: { code: "TREE_NOT_INITIALIZED", message: e.message } }, 404)
        }
      }

      // Bare commitments from `from` onward. This is how clients get Merkle paths:
      // they download every leaf and build the tree themselves, because that request
      // is identical for every caller and so reveals nothing about which leaf is
      // theirs. See the note above `merkleForSpend` in `sdk/src/client.ts`.
      const ml = p.match(/^\/api\/merkle\/([^/]+)\/leaves$/)
      if (ml && method === "GET") {
        const treeKey = decodeURIComponent(ml[1])
        const from = Math.max(0, Number(url.searchParams.get("from") ?? 0))
        const limit = Math.min(20_000, Math.max(1, Number(url.searchParams.get("limit") ?? 10_000)))
        const all = utxos
          .filter((u) => u.treeKey === treeKey && u.leafIndex >= from)
          .sort((a, b) => a.leafIndex - b.leafIndex)
        const page = all.slice(0, limit)
        const total = utxos.filter((u) => u.treeKey === treeKey).length
        return json({
          tree_key: treeKey,
          from,
          next_leaf_index: total,
          has_more: from + page.length < total,
          next_from: from + page.length,
          leaves: page.map((u) => ({ leaf_index: u.leafIndex, commitment: u.commitment })),
        })
      }

      const mp = p.match(/^\/api\/merkle\/([^/]+)\/proof\/(\d+)$/)
      if (mp) {
        const treeKey = decodeURIComponent(mp[1])
        const pr = await proofFor(treeKey, Number(mp[2]))
        if (!pr) return json({ error: { code: "LEAF_NOT_FOUND", message: "leaf not indexed yet" } }, 404)
        return json(pr)
      }

      const look = p.match(/^\/api\/registration\/lookup\/([^/]+)$/)
      if (look && method === "GET") {
        const wallet = decodeURIComponent(look[1])
        const hit = registry.get(wallet)
        if (!hit) return json({ error: { code: "NOT_REGISTERED", message: "recipient has not unlocked in this app yet" } }, 404)
        return json(hit)
      }

      if (p === "/api/registration/register" && method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch { }
        const wallet = String(body.wallet || body.wallet_pubkey || "").trim()
        const spend = String(body.spend_pubkey || body.spendPubkey || "").trim()
        const view = String(body.viewing_pubkey || body.viewingPubkey || "").trim()
        if (!wallet || !spend || !view) {
          return json({ error: { code: "INVALID", message: "wallet, spend_pubkey, viewing_pubkey required" } }, 400)
        }
        registry.set(wallet, { spend_pubkey: spend, viewing_pubkey: view })
        saveRegistry()
        return json({ ok: true })
      }

      if (p === "/api/utxos/range" && method === "GET") {
        const treeKey = url.searchParams.get("tree_key") || "sol"
        const start = Number(url.searchParams.get("start") ?? 0)
        const end = Number(url.searchParams.get("end") ?? start + 2000)
        const page = utxos.filter((u) => u.treeKey === treeKey && u.leafIndex >= start && u.leafIndex < end)
        const total = utxos.filter((u) => u.treeKey === treeKey).length
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
        const hit = utxos.find(
          (u) =>
            u.encryptedHex.toLowerCase() === hex &&
            (!treeKey || u.treeKey === treeKey),
        )
        return json(
          hit
            ? {
              exists: true,
              tree_key: hit.treeKey,
              leaf_index: hit.leafIndex,
              commitment: hit.commitment,
              signature: hit.signature,
              slot: hit.slot,
            }
            : { exists: false },
        )
      }

      const n = p.match(/^\/api\/nullifier\/([^/]+)$/)
      if (n) {
        const hex = n[1].replace(/^0x/i, "")
        let spent = nullifiers.has(hex)
        if (!spent) {
          const h = Buffer.from(hex, "hex")
          const [p0] = PublicKey.findProgramAddressSync([Buffer.from("nullifier0"), h], PROGRAM)
          const [p1] = PublicKey.findProgramAddressSync([Buffer.from("nullifier1"), h], PROGRAM)
          spent = !!(await conn.getAccountInfo(p0)) || !!(await conn.getAccountInfo(p1))
        }
        return json({ nullifier: hex, spent })
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

        if (p === "/api/prove") {
          const proof = await hostedProve(body)
          return json({ success: true, data: proof })
        }
        if (p === "/api/jupiter/route") {
          return json(await jupiterRoute(body))
        }
        if (p === "/api/relayer/swap") {
          return json(await relaySwap(body))
        }
        // Deposit path: client wallet-signed VersionedTransaction hex → broadcast
        if (p === "/api/relayer/submit") {
          const hex = String(body.transaction || "").replace(/^0x/i, "")
          const bytes = Buffer.from(hex, "hex")
          const vtx = VersionedTransaction.deserialize(bytes)
          const sig = await sendRawWithRetry(vtx.serialize(), { skipPreflight: true, maxRetries: 5 })
          try { await conn.confirmTransaction(sig, "confirmed") } catch { }
          let tx = null
          try {
            tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 })
          } catch { }
          if (tx?.meta?.err) {
            const logs = (tx.meta.logMessages ?? []).filter((l) => /failed|Error|custom program/i.test(l))
            const hint = logs.length ? ` — ${logs[logs.length - 1]}` : ""
            return json({ error: { code: "TX_FAILED", message: `transaction failed: ${JSON.stringify(tx.meta.err)}${hint}` } }, 400)
          }
          return json({ signature: sig, slot: tx?.slot ?? null, status: "confirmed" })
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
      console.error("SHIM ERROR:", e?.stack || e)
      return json({ error: { code: "INTERNAL", message: e.message } }, 500)
    }
  },
})
console.log(`backend-shim listening on :${PORT} (program ${PROGRAM.toBase58()})`)

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

/**
 * Dev stand-in for `POST /api/relayer/transact` in the Rust relayer.
 *
 * Same contract, same trust model: the client sends a proof plus the raw extData
 * components and the shim compiles, signs and pays, so the user's wallet never
 * appears in a withdrawal or transfer. The production relayer additionally
 * recomputes `ext_data_hash` and enforces a fee floor before spending its own
 * lamports; the shim skips both because the program's own `ext_data_hash` check is
 * what actually makes tampering impossible, and a local payer has nothing to lose.
 */
async function relayWithdraw(body) {
  const extAmount = BigInt(body.ext_amount)
  if (extAmount > 0n) {
    throw new Error(
      "deposits are not relayed: the program funds them from the signer, so relaying one " +
      "would spend the relayer's balance. Sign deposits with your wallet and POST them to " +
      "/api/relayer/submit.",
    )
  }
  const isSpl = !!body.is_spl
  const proof = proofFromBody(body.proof ?? body)
  const enc1 = hexToBuf(body.encrypted_output1)
  const enc2 = hexToBuf(body.encrypted_output2)
  const fee = BigInt(body.fee)
  const BN = (await import("bn.js")).default
  const extBN = new BN(extAmount.toString())
  const feeBN = new BN(fee.toString())

  const n0 = Uint8Array.from(proof.inputNullifiers[0])
  const n1 = Uint8Array.from(proof.inputNullifiers[1])
  const accounts = deriveAccounts(PROGRAM, n0, n1)

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]

  if (!isSpl) {
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
  } else {
    const mint = new PublicKey(body.mint)
    const owner = new PublicKey(body.recipient)
    // Bound by `ext_data_hash`, so taking it from the client is safe: a wrong value
    // makes the program reject the proof rather than misdirect the payout.
    const recipientAta = new PublicKey(body.recipient_token_account)
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
    return withRelayFees(await sendIxMany(ixs, splAlt), fee)
  }

  return withRelayFees(await sendIxMany(ixs), fee)
}

/** Mirrors the Rust relayer's response so the SDK can report what it paid. */
function withRelayFees(result, fee) {
  return { ...result, rent_lamports: TRANSACT_RENT_LAMPORTS, fee_lamports: Number(fee) }
}

async function sendIxMany(ixs, altAccount = null) {
  const { blockhash } = await conn.getLatestBlockhash()
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
  const sig = await sendRawWithRetry(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  try { await conn.confirmTransaction(sig, "confirmed") } catch { }
  const slot = await conn.getSlot("confirmed")
  return { signature: sig, slot, status: "confirmed" }
}

function proofFromBody(p) {
  return {
    proofA: [...hexToBuf(p.proof_a ?? p.proofA)],
    proofB: [...hexToBuf(p.proof_b ?? p.proofB)],
    proofC: [...hexToBuf(p.proof_c ?? p.proofC)],
    root: [...hexToBuf(p.root)],
    publicAmount: [...hexToBuf(p.public_amount ?? p.publicAmount)],
    extDataHash: [...hexToBuf(p.ext_data_hash ?? p.extDataHash)],
    inputNullifiers: [
      [...hexToBuf(p.input_nullifiers?.[0] ?? p.inputNullifiers[0])],
      [...hexToBuf(p.input_nullifiers?.[1] ?? p.inputNullifiers[1])],
    ],
    outputCommitments: [
      [...hexToBuf(p.output_commitments?.[0] ?? p.outputCommitments[0])],
      [...hexToBuf(p.output_commitments?.[1] ?? p.outputCommitments[1])],
    ],
  }
}

async function hostedProve(circuitInput) {
  if (PROVE_URL) {
    const res = await fetch(PROVE_URL.replace(/\/$/, "") + "/api/prove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(circuitInput),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message ?? "prove proxy failed")
    return json.data ?? json
  }
  const started = Date.now()
  const result = await proveViaServe(circuitInput)
  console.log(`prove latency_ms=${Date.now() - started}`)
  return result
}

let serveProc = null
let stdoutReader = null
let serveStdoutBuf = ""
let proveLock = Promise.resolve()

async function proveViaServe(circuitInput) {
  const run = () => proveViaServeLocked(circuitInput)
  const p = proveLock.then(run, run)
  proveLock = p.catch(() => {})
  return p
}

async function ensureServe() {
  if (serveProc && serveProc.exitCode === null) return
  serveProc = null
  stdoutReader = null
  if (!existsSync(PROVER_BIN)) {
    throw new Error(`prover binary missing at ${PROVER_BIN}; cargo build --release --manifest-path crates/privacy-cash-prover/Cargo.toml`)
  }
  serveStdoutBuf = ""
  serveProc = Bun.spawn([PROVER_BIN, "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CIRCUIT_BASE: process.env.CIRCUIT_BASE ?? path.join(repoRoot, "programs/privacy-cash/artifacts/circuits/transaction2"),
    },
  })
  stdoutReader = serveProc.stdout.getReader()
  ;(async () => {
    try {
      const err = await new Response(serveProc.stderr).text()
      if (err.trim()) console.log(err.trim())
    } catch { /* process ended */ }
  })()
}

async function readServeLine() {
  while (!serveStdoutBuf.includes("\n")) {
    const { done, value } = await stdoutReader.read()
    if (done || !value) {
      serveProc = null
      throw new Error("prover serve stdout closed")
    }
    serveStdoutBuf += new TextDecoder().decode(value)
  }
  const i = serveStdoutBuf.indexOf("\n")
  const line = serveStdoutBuf.slice(0, i)
  serveStdoutBuf = serveStdoutBuf.slice(i + 1)
  return line
}

async function proveViaServeLocked(circuitInput) {
  await ensureServe()
  try {
    serveProc.stdin.write(JSON.stringify(circuitInput) + "\n")
    const line = await readServeLine()
    const parsed = JSON.parse(line)
    if (parsed?.error) throw new Error(String(parsed.error))
    return parsed
  } catch (e) {
    const msg = String(e?.message ?? e)
    // Keep the process up for prove failures (JSON `error` field). Only
    // respawn when stdin/stdout actually died.
    if (/stdout closed|EPIPE|write after end|spawn/i.test(msg) || e instanceof SyntaxError) {
      try { serveProc?.kill() } catch { }
      serveProc = null
    }
    throw e
  }
}

async function jupiterRoute(body) {
  const inputMint = body.inputMint ?? body.input_mint
  const outputMint = body.outputMint ?? body.output_mint
  const amount = String(body.amount ?? "")
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const userPublicKey = body.userPublicKey ?? body.user_public_key ?? globalCfg.toBase58()
  const slippageBps = String(body.slippageBps ?? body.slippage_bps ?? 100)
  if (!inputMint || !outputMint || !amount || amount === "0") {
    throw new Error("jupiter route needs inputMint, outputMint, amount")
  }
  const quoteUrl = new URL("https://lite-api.jup.ag/swap/v1/quote")
  quoteUrl.searchParams.set("inputMint", inputMint)
  quoteUrl.searchParams.set("outputMint", outputMint)
  quoteUrl.searchParams.set("amount", amount)
  quoteUrl.searchParams.set("slippageBps", slippageBps)
  quoteUrl.searchParams.set("maxAccounts", "32")
  quoteUrl.searchParams.set("onlyDirectRoutes", "true")
  quoteUrl.searchParams.set("dexes", "Raydium,Raydium CLMM,Orca,Whirlpool,Meteora,Meteora DLMM")
  const quote = await (await fetch(quoteUrl)).json()
  if (quote.error || !quote.outAmount) {
    throw new Error(`jupiter quote failed: ${JSON.stringify(quote)}`)
  }
  const swap = await (await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: false,
      destinationTokenAccount: undefined,
    }),
  })).json()
  const ix = swap.swapInstruction ?? swap.swap_instruction
  if (!ix) throw new Error(`jupiter swap-instructions failed: ${JSON.stringify(swap)}`)
  const routeAccounts = (ix.accounts ?? ix.keys ?? []).map((a) => ({
    pubkey: a.pubkey,
    isWritable: !!(a.isWritable ?? a.is_writable),
  }))
  return {
    minOut: String(quote.otherAmountThreshold ?? quote.outAmount),
    outAmount: String(quote.outAmount),
    route_data: "0x" + Buffer.from(ix.data, "base64").toString("hex"),
    route_accounts: routeAccounts,
  }
}

async function relaySwap(body) {
  const BN = (await import("bn.js")).default
  const fromMint = body.from_mint ?? body.fromMint
  const outMint = new PublicKey(body.out_mint ?? body.outMint)
  const { blockhash } = await conn.getLatestBlockhash()
  const { bytes } = buildSwapTransaction({
    programId: PROGRAM,
    signer: payer.publicKey,
    proofIn: proofFromBody(body.proof_in ?? body.proofIn),
    proofOut: proofFromBody(body.proof_out ?? body.proofOut),
    extAmountIn: new BN(String(body.ext_amount_in ?? body.extAmountIn)),
    extAmountOut: new BN(String(body.ext_amount_out ?? body.extAmountOut)),
    encryptedOutputIn1: hexToBuf(body.encrypted_output_in1 ?? body.encryptedOutputIn1),
    encryptedOutputIn2: hexToBuf(body.encrypted_output_in2 ?? body.encryptedOutputIn2),
    encryptedOutputOut1: hexToBuf(body.encrypted_output_out1 ?? body.encryptedOutputOut1),
    encryptedOutputOut2: hexToBuf(body.encrypted_output_out2 ?? body.encryptedOutputOut2),
    fromMint,
    outMint,
    routeData: hexToBuf(body.route_data ?? body.routeData),
    routeAccounts: (body.route_accounts ?? body.routeAccounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isWritable: !!a.isWritable,
    })),
    blockhash,
    computeUnitLimit: 1_400_000,
  })
  const signed = signWireTransaction(bytes, [payer.secretKey])
  if (signed.length > 4096) throw new Error(`v1 swap packet ${signed.length} > 4096`)
  const sig = await sendRawWithRetry(Buffer.from(signed), { skipPreflight: true, maxRetries: 5 })
  try { await conn.confirmTransaction(sig, "confirmed") } catch { }
  const slot = await conn.getSlot("confirmed")
  return { signature: sig, slot, status: "confirmed", size: signed.length }
}
