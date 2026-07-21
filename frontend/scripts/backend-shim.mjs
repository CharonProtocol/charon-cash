// Lightweight read-only + setup backend for LOCAL testing on surfpool (no Yellowstone).
// Reads everything from the on-chain program via RPC: root/fees from the tree
// account + global config, commitments/nullifiers by scanning the program's tx
// history. Also signs setup/config ixs (initialize, initialize-spl, update-*).
// Serves the same routes the client SDK + admin cards call. Run: bun scripts/backend-shim.mjs
import { readFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import { LocalMirror, readGlobalFees, readSolTreeState } from "../src/lib/client-sdk/local-provider.ts"
import { deriveAccounts } from "../src/lib/client-sdk/program.ts"
import { MERKLE_TREE_DEPTH } from "../src/lib/client-sdk/constants.ts"

const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? "5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P")
const RPC = process.env.SOLANA_RPC_URL ?? "http://localhost:8899"
const PORT = Number(process.env.PORT ?? 8080)
const idJson = process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json")

const conn = new Connection(RPC, "confirmed")
const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(idJson, "utf8"))))
const wasm = await WasmFactory.getInstance()

const dec2hex = (dec) => "0x" + BigInt(dec).toString(16).padStart(64, "0")
const dec2hexU = (dec) => BigInt(dec).toString(16).padStart(64, "0").toUpperCase()
const be = (b) => { let r = 0n; for (const x of b) r = (r << 8n) + BigInt(x); return r }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } })

async function sendIx(ix) {
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix] }).compileToV0Message()
  const tx = new VersionedTransaction(msg); tx.sign([payer])
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  try { await conn.confirmTransaction(sig, "confirmed") } catch {}
  const slot = await conn.getSlot("confirmed")
  return { signature: sig, slot, status: "ok" }
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

// ---- index: scan program tx history -> commitments (leaves) + nullifiers ----
let leaves = []
let nullifiers = new Set()
let lastSlot = 0
let lastSig = null
let mirror = new LocalMirror(wasm)

async function rescan() {
  const sigs = await conn.getSignaturesForAddress(PROGRAM, { limit: 1000 }, "confirmed")
  lastSlot = sigs[0]?.slot ?? lastSlot
  lastSig = sigs[0]?.signature ?? lastSig
  const ordered = sigs.filter((s) => !s.err).reverse()
  const newLeaves = []
  const newNulls = new Set()
  for (const s of ordered) {
    const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
    const msg = t?.transaction?.message
    const ixs = msg?.compiledInstructions ?? msg?.instructions ?? []
    for (const ix of ixs) {
      const data = Buffer.from(ix.data, "base64")
      if (data.length < 481) continue
      const disc = data[0]
      if (disc !== 2 && disc !== 3) continue
      newLeaves.push(be(data.subarray(1 + 416, 1 + 448)).toString())
      newLeaves.push(be(data.subarray(1 + 448, 1 + 480)).toString())
      newNulls.add(Buffer.from(data.subarray(1 + 352, 1 + 384)).toString("hex"))
      newNulls.add(Buffer.from(data.subarray(1 + 384, 1 + 416)).toString("hex"))
    }
  }
  leaves = newLeaves
  nullifiers = newNulls
  mirror = LocalMirror.fromLeaves(wasm, leaves)
}
await rescan()
console.log(`indexed ${leaves.length} leaves, ${nullifiers.size} nullifiers`)
setInterval(() => { rescan().catch((e) => console.error("rescan:", e.message)) }, 4000)

async function proofFor(idx) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (idx < leaves.length) break
    await rescan()
    if (idx < leaves.length) break
    await new Promise((r) => setTimeout(r, 700))
  }
  if (idx >= leaves.length) return null
  return { path_elements: mirror.path(idx).map(dec2hex), path_indices: Array.from({ length: MERKLE_TREE_DEPTH }, (_, i) => (idx >> i) & 1) }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    const method = req.method
    // CORS preflight: browsers send OPTIONS before a JSON POST
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } })
    }
    try {
      if (p === "/health") return json({ status: "ok" })

      if (p === "/indexer/status") return json({ last_signature: lastSig, last_slot: lastSlot, sol_utxo_count: leaves.length })

      if (p === "/api/relayer/info") {
        let fees = { withdrawalFeeRateBps: 25, feeErrorMarginBps: 500 }
        try { fees = await readGlobalFees(conn, PROGRAM) } catch {}
        return json({ program_id: PROGRAM.toBase58(), fee_recipient: payer.publicKey.toBase58(), fee_rate_bps: 0, withdrawal_fee_rate_bps: fees.withdrawalFeeRateBps, fee_error_margin_bps: fees.feeErrorMarginBps, supported_mints: [] })
      }

      const m = p.match(/^\/api\/merkle\/([^/]+)$/)
      if (m && method === "GET") {
        const st = await readSolTreeState(conn, PROGRAM)
        return json({ tree_key: m[1], next_leaf_index: st.nextLeafIndex, current_root: dec2hexU(st.root), known_roots: [dec2hexU(st.root)], leaf_count: leaves.length })
      }

      const mp = p.match(/^\/api\/merkle\/([^/]+)\/proof\/(\d+)$/)
      if (mp) {
        const pr = await proofFor(Number(mp[2]))
        if (!pr) return json({ error: { code: "LEAF_NOT_FOUND", message: "leaf not indexed yet" } }, 404)
        return json(pr)
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

      // ---- POST setup/config (payer = authority signs) ----
      if (method === "POST") {
        let body = {}
        try { const text = await req.text(); if (text.trim()) body = JSON.parse(text) } catch {}
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
          return json(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
            { pubkey: treeAccount, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: gC, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ], data })))
        }
        if (p === "/api/relayer/update-config") {
          const [gC] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
          let mask = 0
          if (body.deposit_fee_rate != null) mask |= 1
          if (body.withdrawal_fee_rate != null) mask |= 2
          if (body.fee_error_margin != null) mask |= 4
          const data = Buffer.alloc(7); data[0] = 4; data.writeUInt16LE(body.deposit_fee_rate ?? 0, 1); data.writeUInt16LE(body.withdrawal_fee_rate ?? 0, 3); data.writeUInt16LE(body.fee_error_margin ?? 0, 5); data[6] = mask
          return json(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
            { pubkey: gC, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ], data })))
        }
        if (p === "/api/relayer/update-deposit-limit") {
          const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
          const data = Buffer.alloc(10); data[0] = 5; data.writeBigUInt64LE(BigInt(body.new_limit), 1); data[9] = tb
          return json(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
            { pubkey: tA, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ], data })))
        }
        if (p === "/api/relayer/update-deposit-limit-spl") {
          const mint = new PublicKey(body.mint)
          const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
          const data = Buffer.alloc(10); data[0] = 6; data.writeBigUInt64LE(BigInt(body.new_limit), 1); data[9] = tb
          return json(await sendIx(new TransactionInstruction({ programId: PROGRAM, keys: [
            { pubkey: tA, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ], data })))
        }
      }

      return json({ error: { code: "NOT_FOUND", message: `no route ${method} ${p}` } }, 404)
    } catch (e) {
      return json({ error: { code: "INTERNAL", message: e.message } }, 500)
    }
  },
})
console.log(`backend-shim listening on :${PORT} (program ${PROGRAM.toBase58()})`)

function buildInitializeSolIx() {
  const [tA, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
  const [tT, ttb] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
  const [gC, gb] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  return new TransactionInstruction({ programId: PROGRAM, keys: [
    { pubkey: tA, isSigner: false, isWritable: true },
    { pubkey: tT, isSigner: false, isWritable: true },
    { pubkey: gC, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: Buffer.from([0, tb, ttb, gb]) })
}
