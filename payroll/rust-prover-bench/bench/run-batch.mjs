// Batch3 payroll benchmark: real on-chain batch payouts (disc 7, Transaction(26,2,3)).
// One proof pays 2 employees + change; 3 commitments + 3 encrypted outputs per tx.
// Phases: airdrop -> register -> deposits (t2 prover) -> ALT -> batch3 payouts.
// Usage: bun run-batch.mjs [pools] [totalEmployees] [payLamports]

import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import nacl from "tweetnacl"
import { utils } from "ffjavascript"
import BN from "bn.js"
import * as sdk from "privacy-cash-sdk"

const POOLS = Number(process.argv[2] ?? process.env.POOLS ?? 16)
const TOTAL = Number(process.argv[3] ?? process.env.EMPLOYEES ?? 210)
const PAY = BigInt(process.argv[4] ?? process.env.PAY ?? "5000000")
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8788"
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr")
// repo root derived from this file's location (bench/ -> rust-prover-bench -> payroll -> repo)
const REPO = fileURLToPath(new URL("../../../", import.meta.url))
const ARTIFACTS = REPO + "programs/privacy-cash/artifacts/circuits"
const T2_CIRCUIT = process.env.CIRCUIT ?? ARTIFACTS + "/transaction2"
const B3_CIRCUIT = process.env.B3_CIRCUIT ?? ARTIFACTS + "/transaction_batch3"
const ARK_BIN = process.env.ARK_BIN ?? REPO + "payroll/rust-prover-bench/target/release/prover-server"
// prover count scales with the machine: each arkworks server is ~200MB RSS but
// ~1.2GB of safe headroom under prove load (measured: 6 provers swap-storm an
// 8GB laptop, 4 run clean); reserve 3GB for system + chain + worker + proxy.
// 8GB/8-core laptop -> 4 (matches measurement); 16GB -> 9; 32GB -> capped at 16 lanes.
function defaultProvers() {
  const gb = os.totalmem() / 2 ** 30
  const cpus = Math.max(1, os.cpus().length)
  return Math.max(1, Math.min(16, Math.floor((gb - 3) / 1.25), Math.floor(cpus * 0.75)))
}
const ARK_PROVERS = Number(process.env.ARK_PROVERS ?? defaultProvers())
// waits scale too: a slow or loaded box confirms slower (surfpool lag >10s seen
// under burst); double the base on weak machines, env override wins
const WAIT_MS = Number(process.env.WAIT_MS ?? (os.cpus().length <= 4 ? 120_000 : 60_000))
const SLACK_PER_TX = 1_000_000n
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/pfast-batch"

if (typeof sdk.setBackendUrl !== "function") throw new Error("SDK exports missing")
sdk.setBackendUrl(PROXY)

// Watchdog: an SDK fetch that never resolves would hang the run at 0% CPU
// with the chain work already done (observed once). Dump state and exit.
const WATCHDOG_MIN = Number(process.env.WATCHDOG_MIN ?? 12)
setTimeout(async () => {
  console.error(`WATCHDOG: no exit after ${WATCHDOG_MIN}min — dumping state and exiting`)
  try {
    const status = await (await fetch(PROXY + "/local/status")).json()
    console.error(JSON.stringify({ txsProcessedByProxy: status.stats?.processed, failed: status.stats?.failed, pending: status.pending?.length }))
  } catch { /* proxy may be gone */ }
  process.exit(1)
}, WATCHDOG_MIN * 60_000).unref()
console.log(`machine: ${os.cpus().length} cores / ${(os.totalmem() / 2 ** 30).toFixed(1)}GB -> ${ARK_PROVERS} provers, waits ${WAIT_MS / 1000}s (override: ARK_PROVERS, ARK_THREADS, WAIT_MS)`)

// ---------------- ark prover pool (one per circuit phase) ----------------
class ArkPool {
  constructor(n, circuitPrefix) {
    this.circuitPrefix = circuitPrefix
    this.nextId = 1
    this.children = []
    for (let i = 0; i < n; i++) this.children.push(this.#spawn())
  }
  #spawn() {
    const child = spawn(ARK_BIN, [], {
      env: {
        ...process.env,
        ARK_CIRCUIT: this.circuitPrefix,
        ARK_THREADS: process.env.ARK_THREADS ?? "1",
        ARK_G2: process.env.ARK_G2 ?? "c0c1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    })
    const ch = { child, buf: "", ready: false, queue: 0, pending: new Map() }
    child.stdout.on("data", (chunk) => {
      ch.buf += chunk
      let i
      while ((i = ch.buf.indexOf("\n")) >= 0) {
        const line = ch.buf.slice(0, i)
        ch.buf = ch.buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.ready) { ch.ready = true; this.#drain(); continue }
        const resolve = ch.pending.get(msg.id)
        if (resolve) { ch.pending.delete(msg.id); ch.queue--; resolve(msg); this.#drain() }
      }
    })
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) console.error(`[ark] child exited ${code}`)
    })
    return ch
  }
  #drain() {
    while (this.waiters?.length) {
      const ch = this.children.find(c => c.ready && c.queue === 0)
      if (!ch) break
      ch.queue++
      this.waiters.shift()(ch)
    }
  }
  get waiters() { return this._waiters ?? (this._waiters = []) }
  async #acquire() {
    const free = this.children.find(c => c.ready && c.queue === 0)
    if (free) { free.queue++; return free }
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  async request(input) {
    const ch = await this.#acquire()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      ch.pending.set(id, (msg) => {
        if (msg.ok) resolve(msg)
        else reject(new Error("ark prover: " + msg.error))
      })
      ch.child.stdin.write(JSON.stringify({ id, input }) + "\n")
    })
  }
  async warmup() {
    await Promise.all(this.children.map(c => new Promise(r => {
      if (c.ready) return r()
      const t = setTimeout(() => r(), 120_000)
      const check = setInterval(() => { if (c.ready) { clearTimeout(t); clearInterval(check); r() } }, 50)
    })))
  }
  kill() {
    for (const c of this.children) c.child.kill("SIGKILL")
    this.children = []
  }
}

// never leave prover-server orphans behind: they outlive a killed bench and
// pile up into a RAM storm that takes surfpool down with it
const livePools = new Set()
const cleanup = () => { for (const p of livePools) p.kill() }
process.on("exit", cleanup)
for (const sig of ["SIGTERM", "SIGINT", "SIGBREAK"]) process.on(sig, () => { cleanup(); process.exit(1) })

const proveTimes = []
async function proveOn(pool, input) {
  const normalized = JSON.parse(JSON.stringify(utils.stringifyBigInts(input)))
  const t0 = Date.now()
  const resp = await pool.request(normalized)
  proveTimes.push({ wtns: resp.witnessMs, total: Date.now() - t0, at: Date.now() })
  return { proof: resp.proof, publicSignals: resp.publicSignals }
}

// ---------------- helpers ----------------
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error))
  return j.result
}

function localSigner(kp) {
  return {
    publicKey: kp.publicKey,
    signMessage: async (msg) => nacl.sign.detached(new Uint8Array(msg), kp.secretKey),
    signTransaction: async (tx) => { tx.sign([kp]); return tx },
  }
}

async function sendSimple(signerKp, ixs) {
  const { blockhash } = await sdk.fetchBlockhash()
  const msg = new TransactionMessage({
    payerKey: signerKp.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([signerKp])
  return sdk.submitTransaction(tx.serialize())
}

async function waitFor(fn, timeoutMs = WAIT_MS, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== null && v !== undefined) return v
    await new Promise(r => setTimeout(r, everyMs))
  }
  throw new Error("waitFor timeout")
}

async function healLeafStart(sig) {
  let last = null
  const r = await waitFor(async () => {
    const res = await (await fetch(`${PROXY}/local/sig/${sig}`)).json()
    last = res
    return res.processed ? { leafStart: res.leafStart } : null
  }, 30_000).catch((e) => {
    throw new Error(`healLeafStart timeout sig=${sig} last=${JSON.stringify(last)}`)
  })
  return r.leafStart
}

// ext_data_hash over 3 encrypted outputs (mirror of on-chain
// calculate_complete_ext_data_hash_batch3 and crypto.ts getExtDataHash).
import { createHash } from "node:crypto"
function getExtDataHashBatch3({ recipient, extAmount, encs, fee, feeRecipient, mintAddress }) {
  const parts = [
    Buffer.from(new PublicKey(recipient).toBytes()),
    new BN(extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
  ]
  for (const e of encs) {
    const len = Buffer.alloc(4)
    len.writeUInt32LE(e.length, 0)
    parts.push(len, Buffer.from(e))
  }
  parts.push(
    new BN(fee).toArrayLike(Buffer, "le", 8),
    Buffer.from(new PublicKey(feeRecipient).toBytes()),
    Buffer.from(new PublicKey(mintAddress).toBytes()),
  )
  const digest = createHash("sha256").update(Buffer.concat(parts)).digest()
  // witness calculator reads the 32-byte hash little-endian into the field
  return new BN(digest, 16, "le").toString()
}

const events = []
function logEvent(pool, seq, phase, fields) { events.push({ t: Date.now(), pool, seq, phase, ...fields }) }

// ---------------- setup ----------------
const base = Math.floor(TOTAL / POOLS)
const extra = TOTAL % POOLS
const poolSizes = Array.from({ length: POOLS }, (_, i) => base + (i < extra ? 1 : 0))
console.log(`run-batch: ${POOLS} pools, ${TOTAL} employees, pay ${PAY}, batch=2 employees/proof`)

const T_START = Date.now()
const employers = Array.from({ length: POOLS }, () => Keypair.generate())
const employees = Array.from({ length: TOTAL }, () => Keypair.generate())

console.log("airdropping", POOLS, "employers")
await Promise.all(employers.map(async (kp) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const sig = await rpc("requestAirdrop", [kp.publicKey.toBase58(), 10_000_000_000])
      await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }])
      return
    } catch (e) {
      if (attempt === 4) throw e
      await new Promise(r => setTimeout(r, 500))
    }
  }
}))

console.log("registering", TOTAL, "recipients")
const T_REG = Date.now()
const BATCH = 25
for (let i = 0; i < employees.length; i += BATCH) {
  await Promise.all(employees.slice(i, i + BATCH).map(emp =>
    sdk.publishRecipientKeys(localSigner(emp)).catch(e => { throw new Error("register " + i + ": " + e.message) })
  ))
}
console.log(`registered in ${((Date.now() - T_REG) / 1000).toFixed(1)}s`)
logEvent(-1, -1, "register", { employees: TOTAL, ms: Date.now() - T_REG })

const relayerInfo = await sdk.fetchRelayerInfo()
const feeBps = relayerInfo.withdrawalFeeRateBps
const feeFloor = relayerInfo.minTransferFee ?? 0
const feePerTx = BigInt(Math.max(Math.ceil((Number(2n * PAY) * feeBps) / 10000), feeFloor))
console.log(`fee per batch tx: ${feePerTx} (bps=${feeBps}, floor=${feeFloor})`)

// ---------------- phase 1: deposits (t2 prover) ----------------
console.log("spawning", ARK_PROVERS, "t2 provers")
const t2Pool = new ArkPool(ARK_PROVERS, T2_CIRCUIT)
livePools.add(t2Pool)
await t2Pool.warmup()
sdk.setProver(async (input) => {
  const r = await proveOn(t2Pool, input)
  return r
})

async function depositPool(poolIdx) {
  const empCount = poolSizes[poolIdx]
  const nBatchTx = Math.ceil(empCount / 2)
  const signer = localSigner(employers[poolIdx])
  const client = new sdk.PrivacyCashClient(signer, PROGRAM_ID)
  const poolAmount = BigInt(empCount) * PAY + BigInt(nBatchTx) * (feePerTx + SLACK_PER_TX) + 2_000_000n
  const d0 = Date.now()
  const dep = await client.depositSOL(Number(poolAmount))
  const depNote = sdk.unspentNotes(client.publicKey)[0]
  const leafStart = await healLeafStart(dep.signature)
  logEvent(poolIdx, 0, "deposit", { ms: Date.now() - d0, amount: poolAmount.toString(), leafIndex: leafStart })
  return { client, signer, note: { amount: depNote.amount, blinding: depNote.blinding, index: leafStart } }
}

const T_DEP = Date.now()
console.log("depositing to", POOLS, "pools")
const depResults = await Promise.all(employers.map((_, i) => depositPool(i)))
console.log(`deposits done in ${((Date.now() - T_DEP) / 1000).toFixed(1)}s`)
t2Pool.kill()
console.log("t2 provers stopped")

// ---------------- phase 2: shared ALT ----------------
console.log("building shared ALT")
const T_ALT = Date.now()
const accounts0 = await sdk.deriveAccounts(PROGRAM_ID, new Uint8Array(32), new Uint8Array(32))
const altAddresses = [
  PROGRAM_ID,
  SystemProgram.programId,
  ComputeBudgetProgram.programId,
  accounts0.treeAccount,
  accounts0.treeTokenAccount,
  accounts0.globalConfig,
  new PublicKey(relayerInfo.feeRecipient),
  ...employers.map(kp => kp.publicKey),
]
const altOwner = employers[0]
{
  const { slot } = await sdk.fetchBlockhash()
  const [createIx, altKey] = AddressLookupTableProgram.createLookupTable({
    authority: altOwner.publicKey,
    payer: altOwner.publicKey,
    recentSlot: slot - 1,
  })
  var altAddressKey = altKey
  await sendSimple(altOwner, [createIx])
  await waitFor(async () => {
    const acc = await rpc("getAccountInfo", [altKey.toBase58(), { encoding: "base64" }])
    const data = acc?.value?.data?.[0]
    return data && data.length > 8 ? true : null
  })
  for (let i = 0; i < altAddresses.length; i += 20) {
    const chunk = altAddresses.slice(i, i + 20)
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: altOwner.publicKey,
      authority: altOwner.publicKey,
      lookupTable: altKey,
      addresses: chunk,
    })
    await sendSimple(altOwner, [ix])
  }
}
const altAccount = await waitFor(async () => {
  const acc = await rpc("getAccountInfo", [altAddressKey.toBase58(), { encoding: "base64" }])
  if (!acc?.value?.data?.[0]) return null
  const state = AddressLookupTableAccount.deserialize(Buffer.from(acc.value.data[0], "base64"))
  return state.addresses.length >= altAddresses.length
    ? new AddressLookupTableAccount({ key: altAddressKey, state })
    : null
}, 30_000)
await new Promise(r => setTimeout(r, 1000)) // one-slot activation grace
console.log(`ALT ${altAddressKey.toBase58()} with ${altAccount.state.addresses.length} addresses in ${((Date.now() - T_ALT) / 1000).toFixed(1)}s`)
logEvent(-1, -1, "alt", { ms: Date.now() - T_ALT, addresses: altAccount.state.addresses.length })

// ---------------- phase 3: batch3 payouts ----------------
console.log("spawning", ARK_PROVERS, "batch3 provers")
const b3Pool = new ArkPool(ARK_PROVERS, B3_CIRCUIT)
livePools.add(b3Pool)
await b3Pool.warmup()

function buildBatch3IxData(proof, extAmount, fee, encs, bump0, bump1) {
  const parts = [
    Buffer.from([7]),
    Buffer.from(proof.proofA),
    Buffer.from(proof.proofB),
    Buffer.from(proof.proofC),
    Buffer.from(proof.root),
    Buffer.from(proof.publicAmount),
    Buffer.from(proof.extDataHash),
    Buffer.from(proof.inputNullifiers[0]),
    Buffer.from(proof.inputNullifiers[1]),
    Buffer.from(proof.outputCommitments[0]),
    Buffer.from(proof.outputCommitments[1]),
    Buffer.from(proof.outputCommitments[2]),
    new BN(extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
    new BN(fee).toArrayLike(Buffer, "le", 8),
  ]
  for (const e of encs) {
    const len = Buffer.alloc(4)
    len.writeUInt32LE(e.length, 0)
    parts.push(len, Buffer.from(e))
  }
  parts.push(Buffer.from([bump0, bump1]))
  return Buffer.concat(parts)
}

async function payBatch(poolIdx) {
  const { client, note: startNote } = depResults[poolIdx]
  const signer = localSigner(employers[poolIdx])
  const empCount = poolSizes[poolIdx]
  const employeeOff = poolSizes.slice(0, poolIdx).reduce((s, x) => s + x, 0)
  const nBatchTx = Math.ceil(empCount / 2)
  const utxoKeypair = client.utxoKeypair
  const wasm = client.wasm
  const feeRecipient = new PublicKey(relayerInfo.feeRecipient)

  // pre-fetch recipient keys for this pool's employees
  const empKeys = []
  for (let seq = 0; seq < empCount; seq++) {
    const k = await sdk.fetchRecipientKeys(employees[employeeOff + seq].publicKey)
    if (!k) throw new Error(`employee ${employeeOff + seq} has no recipient keys`)
    empKeys.push(k)
  }

  let current = startNote
  for (let b = 0; b < nBatchTx; b++) {
    const firstEmp = b * 2
    const isTailSingle = empCount - firstEmp === 1
    const t0 = Date.now()

    // real input = current change/deposit note; second input = zero dummy
    const realInput = new sdk.Utxo({
      wasm, amount: current.amount, blinding: current.blinding,
      keypair: utxoKeypair, index: current.index, mintAddress: sdk.WRAPPED_SOL_MINT,
    })
    const dummyInput = new sdk.Utxo({ wasm, keypair: utxoKeypair, amount: "0", mintAddress: sdk.WRAPPED_SOL_MINT })
    const inputs = [realInput, dummyInput]

    const proofInfo = await sdk.fetchMerkleProof(sdk.SOL_TREE_KEY, current.index)
    const root = proofInfo.root
    const nextLeafIndex = proofInfo.nextLeafIndex

    const nPay = isTailSingle ? 1 : 2
    const net = BigInt(nPay) * PAY
    const totalInput = BigInt(realInput.amount.toString())
    const changeAmt = totalInput - net - feePerTx

    const outputs = []
    outputs.push(new sdk.Utxo({
      wasm, amount: PAY.toString(), pubkey: empKeys[firstEmp].notePubkey,
      index: nextLeafIndex, mintAddress: sdk.WRAPPED_SOL_MINT,
    }))
    if (isTailSingle) {
      outputs.push(new sdk.Utxo({ wasm, amount: "0", keypair: utxoKeypair, index: nextLeafIndex + 1, mintAddress: sdk.WRAPPED_SOL_MINT }))
    } else {
      outputs.push(new sdk.Utxo({
        wasm, amount: PAY.toString(), pubkey: empKeys[firstEmp + 1].notePubkey,
        index: nextLeafIndex + 1, mintAddress: sdk.WRAPPED_SOL_MINT,
      }))
    }
    outputs.push(new sdk.Utxo({
      wasm, amount: changeAmt.toString(), keypair: utxoKeypair,
      index: nextLeafIndex + 2, mintAddress: sdk.WRAPPED_SOL_MINT,
    }))

    const encs = [
      await sdk.encryptUtxoTo(Buffer.from(empKeys[firstEmp].encPubkey, "hex"), outputs[0]),
      isTailSingle
        ? await client.enc.encryptUtxo(outputs[1])
        : await sdk.encryptUtxoTo(Buffer.from(empKeys[firstEmp + 1].encPubkey, "hex"), outputs[1]),
      await client.enc.encryptUtxo(outputs[2]),
    ]

    const extDataHash = getExtDataHashBatch3({
      recipient: feeRecipient,
      extAmount: 0,
      encs,
      fee: feePerTx,
      feeRecipient,
      mintAddress: sdk.WRAPPED_SOL_MINT,
    })

    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()))
    const outputCommitments = outputs.map(x => x.getCommitment())
    const publicAmount = new BN(0).sub(new BN(feePerTx.toString())).add(new BN(sdk.FIELD_SIZE.toString())).mod(new BN(sdk.FIELD_SIZE.toString()))

    const circuitInput = {
      root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: publicAmount.toString(),
      extDataHash,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey.toString()),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputs.map(x => x.index),
      inPathElements: [
        proofInfo.pathElements,
        new Array(sdk.MERKLE_TREE_DEPTH).fill("0"),
      ],
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.pubkey.toString()),
      mintAddress: sdk.getMintAddressField(sdk.WRAPPED_SOL_MINT),
    }

    const tProve0 = Date.now()
    const { proof, publicSignals } = await proveOn(b3Pool, circuitInput)
    const tProve1 = Date.now()

    const proofBytes = sdk.parseProofToBytesArray(proof)
    const pub = sdk.parseToBytesArray(publicSignals)
    const proofSubmit = {
      proofA: proofBytes.proofA,
      proofB: proofBytes.proofB,
      proofC: proofBytes.proofC,
      root: pub[0],
      publicAmount: pub[1],
      extDataHash: pub[2],
      inputNullifiers: [pub[3], pub[4]],
      outputCommitments: [pub[5], pub[6], pub[7]],
    }

    const accounts = sdk.deriveAccounts(PROGRAM_ID, Uint8Array.from(pub[3]), Uint8Array.from(pub[4]))
    const ixData = buildBatch3IxData(
      proofSubmit, 0, feePerTx, encs, accounts.bump0, accounts.bump1,
    )
    const transactIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: accounts.treeAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.nullifier0, isSigner: false, isWritable: true },
        { pubkey: accounts.nullifier1, isSigner: false, isWritable: true },
        // cross-nullifier accounts only need to be non-program-owned+empty per
        // verify_cross_nullifier; reuse the system program (already ALT-loaded)
        // instead of deriving two more PDAs -> 64 fewer static-key bytes
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: accounts.treeTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: employers[poolIdx].publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    })

    const { blockhash } = await sdk.fetchBlockhash()
    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })
    const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 })
    const tryCompile = (ixs) => new VersionedTransaction(new TransactionMessage({
      payerKey: employers[poolIdx].publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([altAccount]))

    let tx = tryCompile([limitIx, priceIx, transactIx])
    let txSize = tx.serialize().length
    if (txSize > 1232) {
      tx = tryCompile([limitIx, transactIx])
      txSize = tx.serialize().length
    }
    if (txSize > 1232) {
      const msg = tx.message.serialize()
      console.error(`SIZE pool ${poolIdx} batch ${b}: total=${txSize} sig=64 msg=${msg.length} ixData=${ixData.length} encs=[${encs.map(e => e.length).join(",")}] staticKeys=${tx.message.staticAccountKeys.map(k => k.toBase58().slice(0, 6)).join(",")} altWritable=${tx.message.addressTableLookups[0]?.writableIndexes.length} altReadonly=${tx.message.addressTableLookups[0]?.readonlyIndexes.length}`)
      throw new Error(`pool ${poolIdx} batch ${b}: tx too large (${txSize} > 1232)`)
    }
    tx.sign([employers[poolIdx]])

    const tSend0 = Date.now()
    const sig = await sdk.submitTransaction(tx.serialize())
    const leafStart = await healLeafStart(sig)
    current = { amount: changeAmt.toString(), blinding: outputs[2].blinding.toString(), index: leafStart + 2 }
    logEvent(poolIdx, b + 1, "batchpay", {
      ms: Date.now() - t0,
      proveMs: tProve1 - tProve0,
      sendMs: Date.now() - tSend0,
      sig,
      txSize,
      employees: isTailSingle ? 1 : 2,
      changeAmt: changeAmt.toString(),
      leafStart,
    })
  }
  return { poolIdx, paid: empCount }
}

const T_PAY = Date.now()
const laneResults = await Promise.allSettled(employers.map((_, i) => payBatch(i)))
const T_DONE = Date.now()
const failures = laneResults.filter(r => r.status === "rejected")
for (const f of failures) console.error("LANE FAILED:", f.reason)
b3Pool.kill()

// ---------------- verdict ----------------
await new Promise(r => setTimeout(r, 1500))
const status = await (await fetch(PROXY + "/local/status")).json()
const verify = await (await fetch(PROXY + "/local/verify")).json()

const pays = events.filter(e => e.phase === "batchpay")
const deposits = events.filter(e => e.phase === "deposit")
const proveTotalMs = proveTimes.reduce((s, p) => s + p.total, 0)
const proveMax = proveTimes.reduce((s, p) => Math.max(s, p.total), 0)
const proveP50 = proveTimes.slice().sort((a, b) => a.total - b.total)[Math.floor(proveTimes.length / 2)]?.total ?? 0

const summary = {
  pools: POOLS,
  employees: TOTAL,
  payLamports: PAY.toString(),
  employeesPerProof: 2,
  depositsLanded: deposits.length,
  batchTxsAttempted: pays.length,
  employeesPaidByEvents: pays.reduce((s, p) => s + p.employees, 0),
  txsProcessedByProxy: status.stats.processed,
  expectedTxs: POOLS + pays.length,
  laneFailures: failures.length,
  setupMs: T_PAY - T_START,
  payWallMs: T_DONE - T_PAY,
  totalWallMs: T_DONE - T_START,
  proves: proveTimes.length,
  proveTotalMs,
  proveP50Ms: proveP50,
  proveMaxMs: proveMax,
  maxTxSize: pays.reduce((s, p) => Math.max(s, p.txSize ?? 0), 0),
  proxyPending: status.pending.length,
  replicaNextIndex: status.nextIndex,
  chainVerify: verify,
}
console.log("\n===== SUMMARY =====")
console.log(JSON.stringify(summary, null, 2))

const stamp = new Date(T_START).toISOString().replace(/[:.]/g, "-")
await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, `run-batch-${stamp}.json`), JSON.stringify({ summary, events, proveTimes }, null, 2))
console.log("wrote", join(OUT_DIR, `run-batch-${stamp}.json`))
if (failures.length || verify.nextIndexMatch === false) process.exit(1)
