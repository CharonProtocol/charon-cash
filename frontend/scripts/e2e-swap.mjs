// Surfpool e2e: deposit SOL, then atomic SOL↔USDC swap via shim-signed v1 Swap ix.
// Merkle paths come from a local mirror of leaves this script inserted (same as
// e2e-surfpool private transfer). Both trees must start at next_index 0.
// Requires ./run.sh (surfpool + shim) and `cargo build --manifest-path crates/privacy-cash-prover/Cargo.toml`.
// Run: bun scripts/e2e-swap.mjs
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import { NATIVE_MINT } from "@solana/spl-token"
import nacl from "tweetnacl"
import BN from "bn.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import {
  EncryptionService, Keypair as UtxoKeypair, Utxo,
  getExtDataHash, getSwapInExtDataHash, getSwapOutExtDataHash,
  prove, parseToBytesArray,
  buildTransactIxData, deriveAccounts,
  FIELD_SIZE, MERKLE_TREE_DEPTH, WRAPPED_SOL_MINT,
  setBackendUrl, relaySwap,
} from "privacy-cash-sdk"

const here = fileURLToPath(new URL(".", import.meta.url))
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8080"
const DEPTH = MERKLE_TREE_DEPTH
const ROOT_HISTORY_OFF = 848, NEXT_INDEX_OFF = 8, ROOT_INDEX_OFF = 12
const SIGN_MSG = "Privacy Money account sign in"
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const FIELD = BigInt(FIELD_SIZE.toString())
const mod = (x) => ((x % FIELD) + FIELD) % FIELD
const be = (b) => { let r = 0n; for (const x of b) r = (r << 8n) + BigInt(x); return r }

setBackendUrl(BACKEND)

function readDotEnv() {
  try {
    const out = {}
    for (const line of readFileSync(path.join(here, "..", ".env"), "utf8").split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  } catch { return {} }
}

const PROGRAM = new PublicKey(
  process.env.PROGRAM_ID ?? readDotEnv().VITE_PROGRAM_ID ?? "6e5ioWVHAyuzfNSGAmJLfiGwKrmwr2GkqoDYWAhqvdjX",
)

class Mirror {
  constructor(wasm) {
    this.wasm = wasm
    this.zeros = ["0"]
    for (let i = 1; i <= DEPTH; i++) this.zeros[i] = wasm.poseidonHashString([this.zeros[i - 1], this.zeros[i - 1]])
    this.layers = [[]]
  }
  insert(leaf) {
    const ix = this.layers[0].length
    this.layers[0][ix] = leaf
    let i = ix
    for (let lv = 1; lv <= DEPTH; lv++) {
      i >>= 1
      const l = this.layers[lv - 1][i * 2]
      const r = i * 2 + 1 < this.layers[lv - 1].length ? this.layers[lv - 1][i * 2 + 1] : this.zeros[lv - 1]
      ;(this.layers[lv] ??= [])[i] = this.wasm.poseidonHashString([l, r])
    }
  }
  indexOf(leaf) { return this.layers[0].indexOf(leaf) }
  /** Path for a real note. Leaf index must match the on-chain insert index. */
  pathForNote(n, dummyPath) {
    if (!n.amount || n.amount.toString() === "0") return dummyPath
    const local = this.indexOf(n.getCommitment())
    if (local < 0) throw new Error("spend note is not in the local merkle mirror")
    if (local !== Number(n.index)) {
      throw new Error(
        `local leaf ${local} != chain index ${n.index}; prove from a mirror of on-chain leaves only (empty tree + inserts), not the shim indexer`,
      )
    }
    return this.path(local)
  }
  path(index) {
    const els = []
    for (let lv = 0; lv < DEPTH; lv++) {
      const sib = index ^ 1
      els[lv] = sib < (this.layers[lv]?.length ?? 0) ? this.layers[lv][sib] : this.zeros[lv]
      index >>= 1
    }
    return els
  }
}

let conn, wasm, payer

async function ensureCircuit() {
  // Hosted /api/prove only — do not load snarkjs buffers or prove() will
  // silently fall back to an uncompressed leftover path.
}

function toProof(proofA, proofB, proofC, pub) {
  return {
    proofA, proofB, proofC,
    root: pub[0], publicAmount: pub[1], extDataHash: pub[2],
    inputNullifiers: [pub[3], pub[4]],
    outputCommitments: [pub[5], pub[6]],
  }
}

async function proveLeg(input) {
  const started = Date.now()
  const r = await prove(input)
  console.log("    prove latency_ms", Date.now() - started)
  const pub = parseToBytesArray(r.publicSignals)
  return toProof(r.proofA, r.proofB, r.proofC, pub)
}

async function sendWithRetry(tx, attempts = 6) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5, skipPreflight: true })
    } catch (e) {
      lastErr = e
      const msg = String(e?.message ?? e)
      if (/Failed to fetch accounts from remote|mainnet-beta|429|Too Many|timeout/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function sendIx(ix, signerKp) {
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({
    payerKey: signerKp.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg); tx.sign([signerKp])
  const sig = await sendWithRetry(tx)
  const r = await conn.confirmTransaction(sig, "confirmed")
  if (r.value.err) throw new Error("tx reverted: " + JSON.stringify(r.value.err))
  return sig
}

async function readRoot(treeAcct) {
  const a = await conn.getAccountInfo(treeAcct)
  const ri = a.data[ROOT_INDEX_OFF]
  return a.data.subarray(ROOT_HISTORY_OFF + ri * 32, ROOT_HISTORY_OFF + ri * 32 + 32)
}
async function readNext(treeAcct) {
  return (await conn.getAccountInfo(treeAcct)).data.readUInt32LE(NEXT_INDEX_OFF)
}

async function initSolTree() {
  const [treeAccount, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
  if (await conn.getAccountInfo(treeAccount)) return treeAccount
  const [treeToken, ttb] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
  const [globalCfg, gb] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  await sendIx(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: treeToken, isSigner: false, isWritable: true },
      { pubkey: globalCfg, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, tb, ttb, gb]),
  }), payer)
  return treeAccount
}

async function initSplTree(mint) {
  const [treeAccount, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
  if (await conn.getAccountInfo(treeAccount)) return treeAccount
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const max = 1_000_000_000_000n
  const data = Buffer.alloc(17); data[0] = 1; data.writeBigUInt64LE(max, 1); data[9] = tb
  await sendIx(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: globalCfg, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }), payer)
  return treeAccount
}

async function depositSol(kp, enc, utxoKp, treeAccount, amount, mirror) {
  const nextIdx = await readNext(treeAccount)
  const note = new Utxo({ wasm, amount: String(amount), keypair: utxoKp, index: nextIdx, mintAddress: WRAPPED_SOL_MINT })
  const dummyOut = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: nextIdx + 1, mintAddress: WRAPPED_SOL_MINT })
  const inputs = [new Utxo({ wasm, keypair: utxoKp }), new Utxo({ wasm, keypair: utxoKp })]
  const outputs = [note, dummyOut]
  const dummyPath = new Array(DEPTH).fill("0")
  const ct1 = await enc.encryptUtxo(outputs[0])
  const ct2 = await enc.encryptUtxo(outputs[1])
  const extAmount = new BN(amount)
  const fee = new BN(0)
  const extDataHash = getExtDataHash({
    recipient: kp.publicKey, extAmount, encryptedOutput1: ct1, encryptedOutput2: ct2,
    fee, feeRecipient: kp.publicKey, mintAddress: WRAPPED_SOL_MINT,
  })
  const rootBytes = await readRoot(treeAccount)
  const publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE)
  const proof = await proveLeg({
    root: be(rootBytes).toString(),
    inputNullifier: await Promise.all(inputs.map((x) => x.getNullifier())),
    outputCommitment: outputs.map((x) => x.getCommitment()),
    publicAmount: publicAmount.toString(),
    extDataHash,
    inAmount: inputs.map((x) => x.amount.toString(10)),
    inPrivateKey: inputs.map((x) => x.keypair.privkey),
    inBlinding: inputs.map((x) => x.blinding.toString(10)),
    inPathIndices: [0, 0],
    inPathElements: [dummyPath, dummyPath],
    outAmount: outputs.map((x) => x.amount.toString(10)),
    outBlinding: outputs.map((x) => x.blinding.toString(10)),
    outPubkey: outputs.map((x) => x.keypair.pubkey),
    mintAddress: WRAPPED_SOL_MINT,
  })
  const a = deriveAccounts(PROGRAM, Uint8Array.from(proof.inputNullifiers[0]), Uint8Array.from(proof.inputNullifiers[1]))
  const data = buildTransactIxData(false, proof, extAmount, fee, ct1, ct2, a.bump0, a.bump1)
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: a.nullifier0, isSigner: false, isWritable: true },
      { pubkey: a.nullifier1, isSigner: false, isWritable: true },
      { pubkey: a.nullifier2, isSigner: false, isWritable: false },
      { pubkey: a.nullifier3, isSigner: false, isWritable: false },
      { pubkey: a.treeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.globalConfig, isSigner: false, isWritable: false },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
  const sig = await sendIx(ix, kp)
  mirror.insert(note.getCommitment())
  mirror.insert(dummyOut.getCommitment())
  console.log("  deposit", sig)
  return note
}

async function syncSurfpoolClock() {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: Date.now() + 5_000 }],
    }),
  })
  const json = await res.json()
  if (json.error) {
    const msg = String(json.error.data ?? json.error.message ?? "")
    if (/past timestamp/i.test(msg)) return
    console.log("  surfpool timeTravel skipped:", JSON.stringify(json.error))
    return
  }
  console.log("  surfpool timeTravel slot", json.result?.absoluteSlot)
}

async function jupiterRoute(inputMint, outputMint, amount, userPublicKey) {
  const quoteUrl = new URL("https://lite-api.jup.ag/swap/v1/quote")
  quoteUrl.searchParams.set("inputMint", inputMint)
  quoteUrl.searchParams.set("outputMint", outputMint)
  quoteUrl.searchParams.set("amount", String(amount))
  quoteUrl.searchParams.set("slippageBps", "5000")
  quoteUrl.searchParams.set("maxAccounts", "32")
  quoteUrl.searchParams.set("onlyDirectRoutes", "true")
  quoteUrl.searchParams.set("dexes", "Raydium,Raydium CLMM,Orca,Whirlpool,Meteora,Meteora DLMM")
  const quote = await (await fetch(quoteUrl)).json()
  if (quote.error || !quote.outAmount) {
    throw new Error(`jupiter quote failed: ${JSON.stringify(quote)}`)
  }
  console.log("  jupiter routePlan", JSON.stringify(quote.routePlan ?? quote.route_plan ?? []).slice(0, 400))
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
  return {
    minOut: Number(quote.otherAmountThreshold ?? quote.outAmount),
    routeData: Buffer.from(ix.data, "base64"),
    routeAccounts: (ix.accounts ?? ix.keys ?? []).map((a) => ({
      pubkey: a.pubkey,
      isWritable: !!(a.isWritable ?? a.is_writable),
    })),
  }
}

async function inspectSwap(sig, label) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
    }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${label}: rpc ${JSON.stringify(json.error)}`)
  const tx = json.result
  if (!tx) throw new Error(`${label}: tx not found`)
  const logs = tx.meta?.logMessages ?? []
  if (tx.meta?.err) {
    for (const line of logs) console.log("   ", line)
    throw new Error(`${label}: ${JSON.stringify(tx.meta.err)}`)
  }
  const cu = Number(tx.meta?.computeUnitsConsumed ?? 0)
  console.log(`  ${label} cu=${cu} version=${tx.version}`)
  if (cu >= 1_400_000) throw new Error(`${label}: CU ${cu} >= 1.4M`)
  const inner = tx.meta?.innerInstructions ?? []
  const jup = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
  const blob = JSON.stringify(tx)
  const mentioned = blob.includes(jup) || inner.length > 0
  if (!mentioned) console.log("  warn: could not find Jupiter program in tx dump (inner ix may still have run)")
  console.log(`  ${label} inner=${inner.length} logs=${logs.length}`)
  return cu
}

async function runSwap({
  fromMint, outMint, amountIn, inNotes, inMirror, outMirror, enc, kp, dummyPath,
}) {
  const solToSpl = fromMint === WRAPPED_SOL_MINT
  const inTree = solToSpl
    ? PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)[0]
    : PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), USDC.toBytes()], PROGRAM)[0]
  const outTree = solToSpl
    ? PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), USDC.toBytes()], PROGRAM)[0]
    : PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)[0]

  const inNext = await readNext(inTree)
  const outNext = await readNext(outTree)
  const change = new Utxo({ wasm, amount: "0", keypair: kp, index: inNext, mintAddress: fromMint })
  const dummyChange = new Utxo({ wasm, amount: "0", keypair: kp, index: inNext + 1, mintAddress: fromMint })
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const jupIn = solToSpl ? NATIVE_MINT.toBase58() : USDC.toBase58()
  const jupOut = solToSpl ? USDC.toBase58() : NATIVE_MINT.toBase58()
  const route = await jupiterRoute(jupIn, jupOut, amountIn, globalCfg.toBase58())

  console.log("  jupiter minOut", route.minOut, "routeAccounts", route.routeAccounts.length, "data", route.routeData.length)
  const dest0 = new Utxo({ wasm, amount: String(route.minOut), keypair: kp, index: outNext, mintAddress: outMint })
  const dest1 = new Utxo({ wasm, amount: "0", keypair: kp, index: outNext + 1, mintAddress: outMint })

  const encIn1 = await enc.encryptUtxo(change)
  const encIn2 = await enc.encryptUtxo(dummyChange)
  const encOut1 = await enc.encryptUtxo(dest0)
  const encOut2 = await enc.encryptUtxo(dest1)

  const extIn = -amountIn
  const extOut = route.minOut
  const outComm = [
    Uint8Array.from(parseToBytesArray([dest0.getCommitment()])[0]),
    Uint8Array.from(parseToBytesArray([dest1.getCommitment()])[0]),
  ]
  const inHash = getSwapInExtDataHash({
    extAmountIn: extIn,
    encryptedOutput1: encIn1,
    encryptedOutput2: encIn2,
    inMint: fromMint,
    outMint,
    minAmountOut: extOut,
    outCommitments: outComm,
  })
  const outHash = getSwapOutExtDataHash({
    extAmountOut: extOut,
    encryptedOutput1: encOut1,
    encryptedOutput2: encOut2,
    outMint,
  })

  const inPaths = inNotes.map((n) => inMirror.pathForNote(n, dummyPath))

  const proofIn = await proveLeg({
    root: be(await readRoot(inTree)).toString(),
    inputNullifier: await Promise.all(inNotes.map((n) => n.getNullifier())),
    outputCommitment: [change.getCommitment(), dummyChange.getCommitment()],
    publicAmount: mod(BigInt(extIn)).toString(),
    extDataHash: inHash,
    inAmount: inNotes.map((n) => n.amount.toString(10)),
    inPrivateKey: inNotes.map((n) => n.keypair.privkey),
    inBlinding: inNotes.map((n) => n.blinding.toString(10)),
    inPathIndices: inNotes.map((n) => n.index),
    inPathElements: inPaths,
    outAmount: [change.amount.toString(10), dummyChange.amount.toString(10)],
    outBlinding: [change.blinding.toString(10), dummyChange.blinding.toString(10)],
    outPubkey: [change.keypair.pubkey, dummyChange.keypair.pubkey],
    mintAddress: fromMint,
  })
  const dummyIn = [new Utxo({ wasm, keypair: kp, mintAddress: outMint }), new Utxo({ wasm, keypair: kp, mintAddress: outMint })]
  const proofOut = await proveLeg({
    root: be(await readRoot(outTree)).toString(),
    inputNullifier: await Promise.all(dummyIn.map((n) => n.getNullifier())),
    outputCommitment: [dest0.getCommitment(), dest1.getCommitment()],
    publicAmount: mod(BigInt(extOut)).toString(),
    extDataHash: outHash,
    inAmount: ["0", "0"],
    inPrivateKey: dummyIn.map((n) => n.keypair.privkey),
    inBlinding: dummyIn.map((n) => n.blinding.toString(10)),
    inPathIndices: [0, 0],
    inPathElements: [dummyPath, dummyPath],
    outAmount: [dest0.amount.toString(10), dest1.amount.toString(10)],
    outBlinding: [dest0.blinding.toString(10), dest1.blinding.toString(10)],
    outPubkey: [dest0.keypair.pubkey, dest1.keypair.pubkey],
    mintAddress: outMint,
  })

  const sig = await relaySwap({
    proofIn, proofOut,
    extAmountIn: extIn,
    extAmountOut: extOut,
    encryptedOutputIn1: encIn1,
    encryptedOutputIn2: encIn2,
    encryptedOutputOut1: encOut1,
    encryptedOutputOut2: encOut2,
    fromMint,
    outMint,
    routeData: route.routeData,
    routeAccounts: route.routeAccounts,
  })
  console.log("  swap sig", sig)
  await inspectSwap(sig, solToSpl ? "SOL→USDC" : "USDC→SOL")
  inMirror.insert(change.getCommitment())
  inMirror.insert(dummyChange.getCommitment())
  outMirror.insert(dest0.getCommitment())
  outMirror.insert(dest1.getCommitment())
  return { dest0, dest1, sig }
}

async function main() {
  conn = new Connection(RPC, "confirmed")
  wasm = await WasmFactory.getInstance()
  await ensureCircuit()
  const idJson = process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json")
  payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(idJson, "utf8"))))
  console.log("payer", payer.publicKey.toBase58(), "program", PROGRAM.toBase58())
  await syncSurfpoolClock()

  const solTree = await initSolTree()
  const usdcTree = await initSplTree(USDC)
  const solNext = await readNext(solTree)
  const usdcNext = await readNext(usdcTree)
  if (solNext > 0 || usdcNext > 0) {
    throw new Error(
      `trees not empty (sol next_index=${solNext}, usdc next_index=${usdcNext}). ` +
        `Like e2e-surfpool, this script proves from a local mirror of leaves it inserted. ` +
        `Reset surfpool or redeploy so both trees start at next_index 0.`,
    )
  }

  const enc = new EncryptionService()
  enc.deriveFromSignature(nacl.sign.detached(new TextEncoder().encode(SIGN_MSG), payer.secretKey))
  const kp = new UtxoKeypair(enc.utxoPrivateKey, wasm)
  const dummyPath = new Array(DEPTH).fill("0")
  const solMirror = new Mirror(wasm)
  const usdcMirror = new Mirror(wasm)

  const amount = 10_000_000
  if ((await conn.getBalance(payer.publicKey)) < 0.2 * LAMPORTS_PER_SOL) {
    const a = await conn.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL)
    await conn.confirmTransaction(a)
  }

  console.log("=== deposit SOL ===")
  const note = await depositSol(payer, enc, kp, solTree, amount, solMirror)
  const dummyNote = new Utxo({ wasm, keypair: kp, amount: "0", mintAddress: WRAPPED_SOL_MINT })

  console.log("=== SOL → USDC (v1 swap, shim-signed) ===")
  await syncSurfpoolClock()
  const fwd = await runSwap({
    fromMint: WRAPPED_SOL_MINT,
    outMint: USDC.toBase58(),
    amountIn: amount,
    inNotes: [note, dummyNote],
    inMirror: solMirror,
    outMirror: usdcMirror,
    enc, kp, dummyPath,
  })

  console.log("=== USDC → SOL (v1 swap, shim-signed) ===")
  await syncSurfpoolClock()
  const dummyUsdc = new Utxo({ wasm, keypair: kp, amount: "0", mintAddress: USDC.toBase58() })
  await runSwap({
    fromMint: USDC.toBase58(),
    outMint: WRAPPED_SOL_MINT,
    amountIn: Number(fwd.dest0.amount.toString()),
    inNotes: [fwd.dest0, dummyUsdc],
    inMirror: usdcMirror,
    outMirror: solMirror,
    enc, kp, dummyPath,
  })

  console.log("\n✅ atomic v1 swap e2e passed (both directions, one shim signature each)")
}

main().catch((e) => { console.error("e2e-swap failed:", e); process.exit(1) })
