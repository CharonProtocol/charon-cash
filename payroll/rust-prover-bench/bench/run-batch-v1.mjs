// Batch3 payroll benchmark on Solana v1 transactions (SIMD-0385).
// Packs PER_TX independent batch3 transacts into one 4,096-byte v1 tx
// (vs one transact per 1,232-byte v0 tx in run-batch.mjs).
// Requires surfpool started with --feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4
// (surfpool >= 1.5.0 bundles the v1 SVM code) and a workers build whose
// wire::parse_tx knows the v1 layout (v1_tx_round_trip test).
//
// Layout: nBatchTx deposits per pool (independent notes), then payout rounds of
// PER_TX batch3 proofs each packed into one v1 tx signed with the raw wire
// builder in v1-tx.mjs (byte-identical to @solana/kit 8.2's encoder).
// Usage: bun run-batch-v1.mjs [pools] [totalEmployees] [payLamports]

import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import nacl from "tweetnacl"
import { utils } from "ffjavascript"
import BN from "bn.js"
import * as sdk from "privacy-cash-sdk"
import { buildV1Tx } from "./v1-tx.mjs"

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
const B5_CIRCUIT = process.env.B5_CIRCUIT ?? ARTIFACTS + "/transaction_batch5"
// BATCH5=1 switches the payout circuit to Transaction(26,2,5): 4 employees +
// change per proof (5 output commitments, disc 8). ~1.5KB ixData per transact,
// so only 2 fit a 4,096B v1 tx.
const MODE5 = process.env.BATCH5 === "1"
const CIRCUIT_PREFIX = MODE5 ? B5_CIRCUIT : B3_CIRCUIT
const EMP_PER_PROOF = MODE5 ? 4 : 2
const OUTS = EMP_PER_PROOF + 1
const ARK_BIN = process.env.ARK_BIN ?? REPO + "payroll/rust-prover-bench/target/release/prover-server"
// transacts packed per v1 tx — size-capped (4,096B tx: 3 batch3 ixs ~1.1KB
// each, 2 batch5 ixs ~1.5KB each); CU is set once per tx as
// PER_TX x CU_PER_TRANSACT + margin (groth16 verify grows with public inputs)
const PER_TX = Number(process.env.PER_TX ?? (MODE5 ? 2 : 3))
const CU_PER_TRANSACT = Number(process.env.CU_PER_TRANSACT ?? (MODE5 ? 220_000 : 165_000))
function defaultProvers() {
  const gb = os.totalmem() / 2 ** 30
  const cpus = Math.max(1, os.cpus().length)
  return Math.max(1, Math.min(16, Math.floor((gb - 3) / 1.25), Math.floor(cpus * 0.75)))
}
const ARK_PROVERS = Number(process.env.ARK_PROVERS ?? defaultProvers())
const WAIT_MS = Number(process.env.WAIT_MS ?? (os.cpus().length <= 4 ? 120_000 : 60_000))
const SLACK_PER_TX = 1_000_000n
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/pfast-v1"

if (typeof sdk.setBackendUrl !== "function") throw new Error("SDK exports missing")
sdk.setBackendUrl(PROXY)

const WATCHDOG_MIN = Number(process.env.WATCHDOG_MIN ?? 12)
setTimeout(async () => {
  console.error(`WATCHDOG: no exit after ${WATCHDOG_MIN}min — dumping state and exiting`)
  try {
    const status = await (await fetch(PROXY + "/local/status")).json()
    console.error(JSON.stringify({ txsProcessedByProxy: status.stats?.processed, failed: status.stats?.failed, pending: status.pending?.length }))
  } catch { /* proxy may be gone */ }
  process.exit(1)
}, WATCHDOG_MIN * 60_000).unref()
console.log(`machine: ${os.cpus().length} cores / ${(os.totalmem() / 2 ** 30).toFixed(1)}GB -> ${ARK_PROVERS} provers, ${PER_TX} transacts/v1-tx`)

// ---------------- ark prover pool (same as run-batch.mjs) ----------------
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
  return new BN(digest, 16, "le").toString()
}

const events = []
function logEvent(pool, seq, phase, fields) { events.push({ t: Date.now(), pool, seq, phase, ...fields }) }

// ---------------- setup ----------------
const base = Math.floor(TOTAL / POOLS)
const extra = TOTAL % POOLS
const poolSizes = Array.from({ length: POOLS }, (_, i) => base + (i < extra ? 1 : 0))
console.log(`run-batch-v1: ${POOLS} pools, ${TOTAL} employees, pay ${PAY}, ${PER_TX} transacts/v1-tx`)

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
const feePerTx = BigInt(Math.max(Math.ceil((Number(BigInt(EMP_PER_PROOF) * PAY) * feeBps) / 10000), feeFloor))
console.log(`fee per batch tx: ${feePerTx} (bps=${feeBps}, floor=${feeFloor})`)

// ---------------- phase 1: deposits (t2 prover), nBatchTx per pool ----------------
console.log("spawning", ARK_PROVERS, "t2 provers")
const t2Pool = new ArkPool(ARK_PROVERS, T2_CIRCUIT)
livePools.add(t2Pool)
await t2Pool.warmup()
sdk.setProver(async (input) => proveOn(t2Pool, input))

async function depositPool(poolIdx) {
  const empCount = poolSizes[poolIdx]
  const nBatchTx = Math.ceil(empCount / EMP_PER_PROOF)
  const signer = localSigner(employers[poolIdx])
  const client = new sdk.PrivacyCashClient(signer, PROGRAM_ID)
  const depAmount = BigInt(EMP_PER_PROOF) * PAY + feePerTx + SLACK_PER_TX
  const notes = []
  for (let d = 0; d < nBatchTx; d++) {
    const before = new Set(sdk.unspentNotes(client.publicKey).map(n => n.blinding))
    const t0 = Date.now()
    const dep = await client.depositSOL(Number(depAmount))
    const note = sdk.unspentNotes(client.publicKey).find(n => !before.has(n.blinding))
    if (!note) throw new Error(`pool ${poolIdx} deposit ${d}: fresh note not found`)
    const leafStart = await healLeafStart(dep.signature)
    notes.push({ amount: note.amount, blinding: note.blinding, index: leafStart })
    logEvent(poolIdx, d, "deposit", { ms: Date.now() - t0, leafIndex: leafStart })
  }
  return { client, notes }
}

const T_DEP = Date.now()
console.log("depositing to", POOLS, "pools")
const depResults = await Promise.all(employers.map((_, i) => depositPool(i)))
const nDeposits = depResults.reduce((s, r) => s + r.notes.length, 0)
console.log(`${nDeposits} deposits done in ${((Date.now() - T_DEP) / 1000).toFixed(1)}s`)
t2Pool.kill()
console.log("t2 provers stopped")

// ---------------- phase 2: batch3 payouts packed into v1 txs ----------------
console.log("spawning", ARK_PROVERS, MODE5 ? "batch5" : "batch3", "provers")
const b3Pool = new ArkPool(ARK_PROVERS, CIRCUIT_PREFIX)
livePools.add(b3Pool)
await b3Pool.warmup()

function buildBatchIxData(disc, proof, extAmount, fee, encs, bump0, bump1) {
  const parts = [
    Buffer.from([disc]),
    Buffer.from(proof.proofA),
    Buffer.from(proof.proofB),
    Buffer.from(proof.proofC),
    Buffer.from(proof.root),
    Buffer.from(proof.publicAmount),
    Buffer.from(proof.extDataHash),
    Buffer.from(proof.inputNullifiers[0]),
    Buffer.from(proof.inputNullifiers[1]),
    ...proof.outputCommitments.map((c) => Buffer.from(c)),
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

// one independent transact: consumes its own deposit note, pays nPay
// employees, keeps its own change. No chaining between transacts. Unused
// employee slots are zero-amount self-notes (structural padding).

// per-lane employee recipient keys, filled by payBatchV1 before any prove
const laneEmpKeys = new Map()
const empKeysAt = (poolIdx, i) => laneEmpKeys.get(poolIdx)[i]

async function buildTransact(poolIdx, note, firstEmp, nPay) {
  const { client } = depResults[poolIdx]
  const utxoKeypair = client.utxoKeypair
  const wasm = client.wasm
  const feeRecipient = new PublicKey(relayerInfo.feeRecipient)
  const feeRecipient58 = feeRecipient.toBase58()

  const realInput = new sdk.Utxo({
    wasm, amount: note.amount, blinding: note.blinding,
    keypair: utxoKeypair, index: note.index, mintAddress: sdk.WRAPPED_SOL_MINT,
  })
  const dummyInput = new sdk.Utxo({ wasm, keypair: utxoKeypair, amount: "0", mintAddress: sdk.WRAPPED_SOL_MINT })
  const inputs = [realInput, dummyInput]

  const proofInfo = await sdk.fetchMerkleProof(sdk.SOL_TREE_KEY, note.index)
  const nextLeafIndex = proofInfo.nextLeafIndex

  const net = BigInt(nPay) * PAY
  const totalInput = BigInt(note.amount)
  const changeAmt = totalInput - net - feePerTx

  const outputs = []
  for (let i = 0; i < EMP_PER_PROOF; i++) {
    if (i < nPay) {
      const emp = empKeysAt(poolIdx, firstEmp + i)
      outputs.push(new sdk.Utxo({
        wasm, amount: PAY.toString(), pubkey: emp.notePubkey,
        index: nextLeafIndex + i, mintAddress: sdk.WRAPPED_SOL_MINT,
      }))
    } else {
      outputs.push(new sdk.Utxo({ wasm, amount: "0", keypair: utxoKeypair, index: nextLeafIndex + i, mintAddress: sdk.WRAPPED_SOL_MINT }))
    }
  }
  outputs.push(new sdk.Utxo({ wasm, amount: changeAmt.toString(), keypair: utxoKeypair, index: nextLeafIndex + EMP_PER_PROOF, mintAddress: sdk.WRAPPED_SOL_MINT }))

  const encs = []
  for (let i = 0; i < EMP_PER_PROOF; i++) {
    encs.push(
      i < nPay
        ? await sdk.encryptUtxoTo(Buffer.from(empKeysAt(poolIdx, firstEmp + i).encPubkey, "hex"), outputs[i])
        : await client.enc.encryptUtxo(outputs[i])
    )
  }
  encs.push(await client.enc.encryptUtxo(outputs[EMP_PER_PROOF]))

  const extDataHash = getExtDataHashBatch3({
    recipient: feeRecipient, extAmount: 0, encs, fee: feePerTx, feeRecipient, mintAddress: sdk.WRAPPED_SOL_MINT,
  })

  const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()))
  const outputCommitments = outputs.map(x => x.getCommitment())
  const publicAmount = new BN(0).sub(new BN(feePerTx.toString())).add(new BN(sdk.FIELD_SIZE.toString())).mod(new BN(sdk.FIELD_SIZE.toString()))

  const circuitInput = {
    root: proofInfo.root,
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

  const { proof, publicSignals } = await proveOn(b3Pool, circuitInput)
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
    outputCommitments: pub.slice(5, 5 + OUTS).map((c) => Array.from(c)),
  }

  const accounts = sdk.deriveAccounts(PROGRAM_ID, Uint8Array.from(pub[3]), Uint8Array.from(pub[4]))
  const ixData = buildBatchIxData(MODE5 ? 8 : 7, proofSubmit, 0, feePerTx, encs, accounts.bump0, accounts.bump1)

  // roles for the v1 builder: writable = 1, signer = 2
  const sys = SystemProgram.programId.toBase58()
  const instruction = {
    programId: PROGRAM_ID.toBase58(),
    accounts: [
      { address: accounts.treeAccount.toBase58(), role: 1 },
      { address: accounts.nullifier0.toBase58(), role: 1 },
      { address: accounts.nullifier1.toBase58(), role: 1 },
      { address: sys, role: 0 },
      { address: sys, role: 0 },
      { address: accounts.treeTokenAccount.toBase58(), role: 1 },
      { address: accounts.globalConfig.toBase58(), role: 0 },
      { address: feeRecipient58, role: 1 },
      { address: feeRecipient58, role: 1 },
      { address: employers[poolIdx].publicKey.toBase58(), role: 3 },
      { address: sys, role: 0 },
    ],
    data: new Uint8Array(ixData),
  }
  return { instruction, employees: nPay, changeAmt: changeAmt.toString() }
}

// Root-history pipeline bound: the program accepts a proof root only while it is
// among the last 100 appended roots, and every landed tx appends
// PER_TX x OUTS leaves (9 for batch3, 10 for batch5). Unbounded lanes pushed
// 144-leaf bursts through a 100-leaf window -> UnknownRoot (custom error 5) at
// the ~5.9k-CU merkle check.
// Two layers:
//  1. PIPELINE_SLOTS caps groups inside the fetch->prove->submit lifecycle. Only
//     slot-holders land txs, so by Little's law the leaves that land between any
//     group's proof fetch and its exec are ~(PER_TX x OUTS) x slots: ~72 for
//     batch3 at 8 slots, ~80 for batch5, inside the window with margin.
//     (9 slots sat at ~81 and one burst tipped past 100 once, at
//     ARK_THREADS=2 cycling speed.)
//  2. A tripwire on the TRUE chain age: age = chainNextIndex(now) -
//     chainNextIndex(at fetch), read from the tree PDA (u32le @ 8). Proofs older
//     than GATE_AGE are rebuilt fresh (a rebuild converges: new proofs start at
//     age ~0; waiting never helps — age only grows). Replica-based estimates
//     were tried and rejected: the mirror lags the chain, so replicaAge
//     understates and pending-counting double-counts landed txs — both caused
//     constant false rebuilds that slowed the whole pipeline down.
// batch5 appends 10 leaves/tx (2x batch3's 6), so its in-flight share of the
// 100-root window doubles too: 8 slots x 10 = 80 in-flight + a gate pass at 90
// tipped past 100 once in the first 210-run (1 lane, UnknownRoot=5). batch5
// drops to 4 slots x 10 = 40 in-flight and gates at 40: worst case 40 + 40 +
// landing stragglers stays under 100. Pay is prover-bound (11.7s wall), so the
// tighter pipeline costs nothing measurable.
const PIPELINE_SLOTS = MODE5 ? 4 : 8
const GATE_AGE = MODE5 ? 40 : 90
const SEND_ANYWAY_AGE = MODE5 ? 60 : 97
let slotsHeld = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function acquireSlot() {
  while (slotsHeld >= PIPELINE_SLOTS) await sleep(15)
  slotsHeld++
}
async function chainNextIndex() {
  const [treePda] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM_ID)
  const acc = await rpc("getAccountInfo", [treePda.toBase58(), { encoding: "base64" }])
  return Buffer.from(acc.value.data[0], "base64").readUInt32LE(8)
}

async function payBatchV1(poolIdx) {
  const { notes } = depResults[poolIdx]
  const empCount = poolSizes[poolIdx]
  const employeeOff = poolSizes.slice(0, poolIdx).reduce((s, x) => s + x, 0)
  const nBatchTx = Math.ceil(empCount / EMP_PER_PROOF)

  const empKeys = []
  for (let seq = 0; seq < empCount; seq++) {
    const k = await sdk.fetchRecipientKeys(employees[employeeOff + seq].publicKey)
    if (!k) throw new Error(`employee ${employeeOff + seq} has no recipient keys`)
    empKeys.push(k)
  }
  laneEmpKeys.set(poolIdx, empKeys)

  const proveGroup = async (b) => {
    // build + prove PER_TX independent transacts in parallel
    const group = []
    for (let g = b; g < Math.min(b + PER_TX, nBatchTx); g++) {
      const firstEmp = g * EMP_PER_PROOF
      const nPay = Math.min(EMP_PER_PROOF, empCount - firstEmp)
      group.push(buildTransact(poolIdx, notes[g], firstEmp, nPay))
    }
    return Promise.all(group)
  }

  let paid = 0
  // batch5 transacts cost 239,715 CU. The surfpool v1 runtime ignores the tx's
  // cuLimit config and budgets each instruction at its DEFAULT cost, summed:
  // unknown BPF programs default to 200k, a SystemProgram transfer to 3k
  // (measured: [b5,b5,transfer] capped at 200k+200k+3k = 403k and died).
  // So the filler must be an ix whose default is 200k but whose real cost is
  // tiny — a no-accounts SPL Memo call. [b5,b5,memo] budgets 600k for ~480k
  // actually used: 2 proofs + memo land in one tx = 8 salaries/tx.
  const fillerIx = () => ({
    programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    accounts: [],
    data: new Uint8Array([0]),
  })
  for (let b = 0; b < nBatchTx; b += PER_TX) {
    const t0 = Date.now()
    await acquireSlot()
    try {
      let rebuilds = 0
      let fetchIdx = await chainNextIndex()
      let built = await proveGroup(b)
      const tProved = Date.now()
      for (;;) {
        const { blockhash } = await sdk.fetchBlockhash()
        const txIxs = MODE5 ? [...built.map(x => x.instruction), fillerIx()] : built.map(x => x.instruction)
        const { bytes, size, signature } = buildV1Tx(
          employers[poolIdx], blockhash,
          txIxs,
          { cuLimit: MODE5 ? 600_000 : PER_TX * CU_PER_TRANSACT + 100_000, loadedDataSize: 64 * 1024 * 1024 },
        )
        if (process.env.TX_DUMP) await writeFile(process.env.TX_DUMP, bytes)

        const age = (await chainNextIndex()) - fetchIdx
        if (age > GATE_AGE && rebuilds < 2) {
          rebuilds++
          console.log(`pool ${poolIdx} group ${b / PER_TX + 1}: root age=${age} > ${GATE_AGE} — rebuilding proofs`)
          fetchIdx = await chainNextIndex()
          built = await proveGroup(b)
          continue
        }
        if (age > SEND_ANYWAY_AGE) {
          throw new Error(`pool ${poolIdx} group ${b / PER_TX + 1}: root age=${age} exceeds history window`)
        }

        const tSend0 = Date.now()
        // DIRECT_SEND=1 bypasses the proxy/relayer (debug: isolates CU-config
        // mangling in the submit path; the proxy won't track these txs)
        const sig = process.env.DIRECT_SEND === "1"
          ? await rpc("sendTransaction", [Buffer.from(bytes).toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }])
          : await sdk.submitTransaction(Buffer.from(bytes))
        const sendMs = Date.now() - tSend0
        const employees = built.reduce((s, x) => s + x.employees, 0)
        paid += employees
        logEvent(poolIdx, b / PER_TX + 1, "v1pay", {
          ms: Date.now() - t0,
          proveMs: tProved - t0,
          sendMs,
          sig: signature,
          size,
          transacts: built.length,
          employees,
          fetchIdx,
          landedSig: sig,
        })
        break
      }
    } finally { slotsHeld-- }
  }
  return { poolIdx, paid }
}

const T_PAY = Date.now()
const laneResults = await Promise.allSettled(employers.map((_, i) => payBatchV1(i)))
const T_DONE = Date.now()
const failures = laneResults.filter(r => r.status === "rejected")
for (const f of failures) console.error("LANE FAILED:", f.reason)
b3Pool.kill()

// ---------------- verdict ----------------
const pays = events.filter(e => e.phase === "v1pay")
const deposits = events.filter(e => e.phase === "deposit")
// drain: the last tx can still be in the proxy's pending queue when lanes settle
const expectedTxs = deposits.length + pays.length
{
  const drainDeadline = Date.now() + 60_000
  let s
  while (Date.now() < drainDeadline) {
    s = await (await fetch(PROXY + "/local/status")).json()
    if (s.stats.failed > 0) break
    if (s.stats.processed >= expectedTxs && s.pending.length === 0) break
    await new Promise(r => setTimeout(r, 500))
  }
}
const status = await (await fetch(PROXY + "/local/status")).json()
const verify = await (await fetch(PROXY + "/local/verify")).json()
const proveTotalMs = proveTimes.reduce((s, p) => s + p.total, 0)
const proveMax = proveTimes.reduce((s, p) => Math.max(s, p.total), 0)
const proveP50 = proveTimes.slice().sort((a, b) => a.total - b.total)[Math.floor(proveTimes.length / 2)]?.total ?? 0

const summary = {
  pools: POOLS,
  employees: TOTAL,
  payLamports: PAY.toString(),
  employeesPerProof: EMP_PER_PROOF,
  transactsPerV1Tx: PER_TX,
  depositsLanded: deposits.length,
  v1TxsSent: pays.length,
  employeesPaidByEvents: pays.reduce((s, p) => s + p.employees, 0),
  txsProcessedByProxy: status.stats.processed,
  expectedTxs,
  laneFailures: failures.length,
  setupMs: T_PAY - T_START,
  payWallMs: T_DONE - T_PAY,
  totalWallMs: T_DONE - T_START,
  proves: proveTimes.length,
  proveTotalMs,
  proveP50Ms: proveP50,
  proveMaxMs: proveMax,
  maxV1TxSize: pays.reduce((s, p) => Math.max(s, p.size ?? 0), 0),
  proxyPending: status.pending.length,
  replicaNextIndex: status.nextIndex,
  chainVerify: verify,
}
console.log("\n===== SUMMARY =====")
console.log(JSON.stringify(summary, null, 2))

const stamp = new Date(T_START).toISOString().replace(/[:.]/g, "-")
await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, `run-batch-v1-${stamp}.json`), JSON.stringify({ summary, events, proveTimes }, null, 2))
console.log("wrote", join(OUT_DIR, `run-batch-v1-${stamp}.json`))
if (failures.length || verify.nextIndexMatch === false) process.exit(1)
