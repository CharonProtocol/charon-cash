// Minimal local backend for the payroll bench: only the endpoints the bench
// passes through to the "real" worker. Everything else (merkle proofs,
// blockhash, nullifiers, leaf indices) is served by bench/proxy.mjs on 8788.
// Wire contracts copied verbatim from sdk/src/merkle.ts + recipients.ts.
import http from "node:http"
import {
  Keypair, PublicKey, Connection, SystemProgram, Transaction,
  ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js"
import { deriveAccounts, buildTransactIxData } from "privacy-cash-sdk"

const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const PORT = Number(process.env.PORT ?? 8787)
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr")

const conn = new Connection(RPC, "confirmed")
const relayer = Keypair.generate()
const recipients = new Map()

const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0]
const TREE = pda("merkle_tree")
const TREE_TOKEN = pda("tree_token")
const GLOBAL = pda("global_config")

async function confirm(sig) {
  // web3.js gives up at 30s; surfpool under bench load confirms late (~77
  // slots observed) — poll ourselves with a wider window
  const deadline = Date.now() + 90_000
  for (;;) {
    const st = await conn.getSignatureStatuses([sig])
    const s = st?.value?.[0]
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return
    if (s?.err) throw new Error(`tx failed on chain: ${JSON.stringify(s.err)}`)
    if (Date.now() > deadline) throw new Error("not confirmed in 90s")
    await new Promise(r => setTimeout(r, 500))
  }
}

// Serialize send->confirm like the production relayer: one tx in flight at a
// time. Without this, surfpool lands several same-slot txs whose
// getSignaturesForAddress order doesn't match block execution order, so the
// merkle replica's leaf order (and roots) diverge -> phantom roots -> spurious
// UnknownRoot rejections under lane concurrency.
let chainLock = Promise.resolve()
const withChainLock = (fn) => {
  const p = chainLock.then(fn)
  chainLock = p.catch(() => {})
  return p
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)) }
  try {
    if (req.method === "GET" && url.pathname === "/api/relayer/info") {
      return send(200, {
        program_id: PROGRAM_ID.toBase58(),
        fee_recipient: relayer.publicKey.toBase58(),
        withdrawal_fee_rate_bps: 25,
        fee_error_margin_bps: 1000,
        min_transfer_fee: 10000,
        supported_mints: [],
      })
    }
    if (req.method === "GET" && url.pathname === "/api/relayer/blockhash") {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
      return send(200, { blockhash, slot: await conn.getSlot() })
    }
    if (req.method === "POST" && url.pathname === "/api/relayer/submit") {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      const raw = Buffer.from(body.transaction, "hex")
      // no JS deserialize here: v1 4096B txs use the grouped-header wire
      // layout that web3.js can't parse — the relayer only forwards raw bytes
      // surfpool preflight sim fails spuriously on these txs; real on-chain
      // errors still surface at confirm. Matches frontend/scripts/backend-shim.mjs.
      const sig = await withChainLock(async () => {
        const t0 = Date.now()
        const s = await conn.sendRawTransaction(raw, { skipPreflight: true })
        try {
          await confirm(s)
        } catch (e) {
          // dropped tx forensics: bytes + chain view at drop time
          const { writeFileSync } = await import("node:fs")
          writeFileSync(`/tmp/dropped-${s.slice(0, 12)}.hex`, raw)
          const slot = await conn.getSlot()
          const bh = await conn.getLatestBlockhash()
          console.error(`[submit] CONFIRM FAILED sig=${s.slice(0, 16)} after ${Date.now() - t0}ms slot=${slot} latestBH=${bh.value.blockhash.slice(0, 12)} lastValid=${bh.value.lastValidBlockHeight} rawLen=${raw.length} err=${e.message}`)
          try {
            const st = await conn.getSignatureStatuses([s])
            console.error(`[submit] status of dropped sig: ${JSON.stringify(st.value[0])}`)
          } catch {}
          throw e
        }
        console.log(`[submit] ${s.slice(0, 16)} confirmed +${Date.now() - t0}ms len=${raw.length}`)
        return s
      })
      return send(200, { signature: sig, status: "confirmed" })
    }
    if (req.method === "PUT" && url.pathname === "/api/recipients") {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const b = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      recipients.set(b.wallet, { note_pubkey: b.note_pubkey, enc_pubkey: b.enc_pubkey })
      return send(200, { ok: true })
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/recipients/")) {
      const wallet = decodeURIComponent(url.pathname.split("/")[3])
      const row = recipients.get(wallet)
      if (!row) return send(404, { error: { message: "not found" } })
      return send(200, row)
    }
    if (req.method === "POST" && url.pathname === "/api/recipients/batch") {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const b = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      const wallets = b.wallets ?? []
      return send(200, { rows: wallets.map((w) => ({ wallet: w, ...(recipients.get(w) ?? {}) })) })
    }
    // POST {hashes: [hex 32B]} -> {results: [{spent}]} via on-chain nullifier PDAs
    if (req.method === "POST" && url.pathname === "/api/nullifiers/batch") {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const b = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      const results = []
      for (const hex of b.hashes ?? []) {
        const h = Buffer.from(hex.replace(/^0x/, ""), "hex")
        const p0 = PublicKey.findProgramAddressSync([Buffer.from("nullifier0"), h], PROGRAM_ID)[0]
        const p1 = PublicKey.findProgramAddressSync([Buffer.from("nullifier1"), h], PROGRAM_ID)[0]
        results.push({ spent: !!(await conn.getAccountInfo(p0)) || !!(await conn.getAccountInfo(p1)) })
      }
      return send(200, { results })
    }
    // POST /api/relayer — gasless relayer-built transact (the engine's public
    // payout path). Mirrors frontend/scripts/backend-shim.mjs relayWithdraw
    // (sol kind): rebuild the transact ix from the proof body, relayer pays gas.
    if (req.method === "POST" && (url.pathname === "/api/relayer" || url.pathname === "/api/relayer/transact")) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const b = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      if (Number(b.ext_amount) > 0) throw new Error("ext_amount must be <= 0")
      const hexBuf = (h) => Buffer.from(String(h).replace(/^0x/i, ""), "hex")
      const proof = {
        proofA: [...hexBuf(b.proof_a)],
        proofB: [...hexBuf(b.proof_b)],
        proofC: [...hexBuf(b.proof_c)],
        root: [...hexBuf(b.root)],
        publicAmount: [...hexBuf(b.public_amount)],
        extDataHash: [...hexBuf(b.ext_data_hash)],
        inputNullifiers: [[...hexBuf(b.input_nullifiers[0])], [...hexBuf(b.input_nullifiers[1])]],
        outputCommitments: [[...hexBuf(b.output_commitments[0])], [...hexBuf(b.output_commitments[1])]],
      }
      const accounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(hexBuf(b.input_nullifiers[0])), Uint8Array.from(hexBuf(b.input_nullifiers[1])))
      const { default: BN } = await import("bn.js")
      const data = buildTransactIxData(
        false, proof,
        new BN(BigInt(b.ext_amount).toString()), new BN(BigInt(b.fee).toString()),
        hexBuf(b.encrypted_output1), hexBuf(b.encrypted_output2),
        accounts.bump0, accounts.bump1,
      )
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]
      ixs.push(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: accounts.treeAccount, isSigner: false, isWritable: true },
          { pubkey: accounts.nullifier0, isSigner: false, isWritable: true },
          { pubkey: accounts.nullifier1, isSigner: false, isWritable: true },
          { pubkey: accounts.nullifier2, isSigner: false, isWritable: false },
          { pubkey: accounts.nullifier3, isSigner: false, isWritable: false },
          { pubkey: accounts.treeTokenAccount, isSigner: false, isWritable: true },
          { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(b.recipient), isSigner: false, isWritable: true },
          { pubkey: relayer.publicKey, isSigner: false, isWritable: true },
          { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }))
      const { blockhash } = await conn.getLatestBlockhash()
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: ixs,
      }).compileToV0Message([]))
      tx.sign([relayer])
      const sig = await withChainLock(async () => {
        const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
        try { await conn.confirmTransaction(s, "confirmed") } catch {}
        return s
      })
      return send(200, { signature: sig, slot: await conn.getSlot("confirmed"), status: "confirmed" })
    }
    if (url.pathname === "/api/indexer/kick") return send(200, { ok: true })
    send(404, { error: { message: "bench shim: no route " + url.pathname } })
  } catch (e) {
    send(500, { error: { message: String(e?.message ?? e) } })
  }
})

server.listen(PORT, async () => {
  console.log(`bench shim on :${PORT} relayer ${relayer.publicKey.toBase58()}`)
  // one-time tree initialize (mirrors workers/src/relayer.rs initialize_default)
  const gi = await conn.getAccountInfo(GLOBAL)
  if (gi && gi.data.length > 0) { console.log("already initialized"); return }
  await conn.requestAirdrop(relayer.publicKey, 10_000_000_000)
  const [, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM_ID)
  const [, tokenBump] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM_ID)
  const [, globalBump] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM_ID)
  const tx = new Transaction().add({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: TREE, isSigner: false, isWritable: true },
      { pubkey: TREE_TOKEN, isSigner: false, isWritable: true },
      { pubkey: GLOBAL, isSigner: false, isWritable: true },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, treeBump, tokenBump, globalBump]),
  })
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  tx.sign(relayer)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
  await confirm(sig)
  console.log("tree initialized:", sig)
})
