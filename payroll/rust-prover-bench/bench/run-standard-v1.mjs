// Standard-circuit payroll on Solana v1 transactions — the batch5 pipeline
// with ZERO custom circuits. Same prover pool, v1 wire packing, memo-pad CU
// trick, root-history gates and ARK_THREADS as run-batch-v1.mjs; every payout
// is a stock `transact` (disc 2) on the protocol's own transaction2 circuit:
// 1 recipient + change per proof, so the only batching available is packing
// PER_TX independent transacts per 4,096-byte tx.
//
// Requires surfpool >= 1.5 started with --feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4
// Usage: bun run-standard-v1.mjs [pools] [totalEmployees] [payLamports]

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
const VARIED = process.env.VARIED === "1"
const payAmtAt = (g) => (VARIED ? BigInt(1_000_000 + ((g * 7919) % 8_000_000)) : PAY)
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8788"
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr")
const REPO = fileURLToPath(new URL("../../../", import.meta.url))
const T2_CIRCUIT = process.env.CIRCUIT ?? REPO + "programs/privacy-cash/artifacts/circuits/transaction2"
const ARK_BIN = process.env.ARK_BIN ?? REPO + "payroll/rust-prover-bench/target/release/prover-server"
// standard transact ixData ~750B + first-occurrence accounts: 3/tx fits
// 4,096B with margin at any encrypted-note length; 4/tx only when encs are
// short, so PER_TX is env-tunable and every tx re-checks its own size.
const PER_TX = Number(process.env.PER_TX ?? 3)
const CU_BUDGET_PER_TRANSACT = 200_000 // the chain's default-cost budget for an unknown program
function defaultProvers() {
  const gb = os.totalmem() / 2 ** 30
  const cpus = Math.max(1, os.cpus().length)
  return Math.max(1, Math.min(16, Math.floor((gb - 3) / 1.25), Math.floor(cpus * 0.75)))
}
const ARK_PROVERS = Number(process.env.ARK_PROVERS ?? defaultProvers())
const WAIT_MS = Number(process.env.WAIT_MS ?? (os.cpus().length <= 4 ? 120_000 : 60_000))
const SLACK_PER_TX = 1_000_000n
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/pfast-std-v1"

if (typeof sdk.setBackendUrl !== "function" || typeof sdk.setProver !== "function") throw new Error("SDK exports missing")
sdk.setBackendUrl(PROXY)

const WATCHDOG_MIN = Number(process.env.WATCHDOG_MIN ?? 15)
setTimeout(async () => {
  console.error(`WATCHDOG: no exit after ${WATCHDOG_MIN}min — dumping state and exiting`)
  try {
    const status = await (await fetch(PROXY + "/local/status")).json()
    console.error(JSON.stringify({ txsProcessedByProxy: status.stats?.processed, failed: status.stats?.failed, pending: status.pending?.length }))
  } catch { /* proxy may be gone */ }
  process.exit(1)
}, WATCHDOG_MIN * 60_000).unref()
console.log(`machine: ${os.cpus().length} cores / ${(os.totalmem() / 2 ** 30).toFixed(1)}GB -> ${ARK_PROVERS} provers, ${PER_TX} transacts/v1-tx, ARK_THREADS=${process.env.ARK_THREADS ?? "1"}`)

// ---------------- ark prover pool (same as run-batch-v1.mjs) ----------------
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

const events = []
function logEvent(pool, seq, phase, fields) { events.push({ t: Date.now(), pool, seq, phase, ...fields }) }

// ---------------- setup ----------------
const base = Math.floor(TOTAL / POOLS)
const extra = TOTAL % POOLS
const poolSizes = Array.from({ length: POOLS }, (_, i) => base + (i < extra ? 1 : 0))
console.log(`run-standard-v1: ${POOLS} pools, ${TOTAL} employees, pay ${PAY}, ${PER_TX} transacts/v1-tx`)

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
const feePerTx = BigInt(Math.max(Math.ceil((Number(PAY) * feeBps) / 10000), feeFloor))
console.log(`fee per transact: ${feePerTx} (bps=${feeBps}, floor=${feeFloor})`)

// the prover pool IS the standard circuit here — it serves deposits AND every
// payout. No batch circuit is ever loaded.
console.log("spawning", ARK_PROVERS, "transaction2 provers")
const t2Pool = new ArkPool(ARK_PROVERS, T2_CIRCUIT)
livePools.add(t2Pool)
await t2Pool.warmup()
sdk.setProver(async (input) => proveOn(t2Pool, input))

// ---------------- phase 1: deposits, one note per transact ----------------
async function depositPool(poolIdx) {
  const empCount = poolSizes[poolIdx]
  const signer = localSigner(employers[poolIdx])
  const client = new sdk.PrivacyCashClient(signer, PROGRAM_ID)
  const employeeOff = poolSizes.slice(0, poolIdx).reduce((s, x) => s + x, 0)
  const notes = []
  for (let g = 0; g < empCount; g++) {
    const depAmount = payAmtAt(employeeOff + g) + feePerTx + SLACK_PER_TX
    const before = new Set(sdk.unspentNotes(client.publicKey).map(n => n.blinding))
    const t0 = Date.now()
    const dep = await client.depositSOL(Number(depAmount))
    const note = sdk.unspentNotes(client.publicKey).find(n => !before.has(n.blinding))
    if (!note) throw new Error(`pool ${poolIdx} deposit ${g}: fresh note not found`)
    const leafStart = await healLeafStart(dep.signature)
    notes.push({ amount: note.amount, blinding: note.blinding, index: leafStart })
    logEvent(poolIdx, g, "deposit", { ms: Date.now() - t0, leafIndex: leafStart })
  }
  return { client, notes }
}

const T_DEP = Date.now()
console.log("depositing to", POOLS, "pools (", poolSizes.join(","), ")")
const depResults = await Promise.all(employers.map((_, i) => depositPool(i)))
const nDeposits = depResults.reduce((s, r) => s + r.notes.length, 0)
console.log(`${nDeposits} deposits done in ${((Date.now() - T_DEP) / 1000).toFixed(1)}s`)

// ---------------- phase 2: standard transacts packed into v1 txs ----------------

// one standard transact = one employee: inputs [deposit note, dummy],
// outputs [employee note, change self-note]. Independent per transact —
// no chaining, exactly like the batch bench's design.
const laneEmpKeys = new Map()
const empKeysAt = (poolIdx, i) => laneEmpKeys.get(poolIdx)[i]

async function buildTransactStd(poolIdx, note, localG, globalG) {
  const { client } = depResults[poolIdx]
  const utxoKeypair = client.utxoKeypair
  const wasm = client.wasm
  const feeRecipient = new PublicKey(relayerInfo.feeRecipient)
  const feeRecipient58 = feeRecipient.toBase58()
  const emp = empKeysAt(poolIdx, localG)

  const realInput = new sdk.Utxo({
    wasm, amount: note.amount, blinding: note.blinding,
    keypair: utxoKeypair, index: note.index, mintAddress: sdk.WRAPPED_SOL_MINT,
  })
  const dummyInput = new sdk.Utxo({ wasm, keypair: utxoKeypair, amount: "0", mintAddress: sdk.WRAPPED_SOL_MINT })
  const inputs = [realInput, dummyInput]

  const proofInfo = await sdk.fetchMerkleProof(sdk.SOL_TREE_KEY, note.index)
  const nextLeafIndex = proofInfo.nextLeafIndex

  const net = payAmtAt(globalG)
  const changeAmt = BigInt(note.amount) - net - feePerTx

  const empOut = new sdk.Utxo({
    wasm, amount: net.toString(), pubkey: emp.notePubkey,
    index: nextLeafIndex, mintAddress: sdk.WRAPPED_SOL_MINT,
  })
  const changeOut = new sdk.Utxo({ wasm, amount: changeAmt.toString(), keypair: utxoKeypair, index: nextLeafIndex + 1, mintAddress: sdk.WRAPPED_SOL_MINT })
  const outputs = [empOut, changeOut]

  const enc1 = await sdk.encryptUtxoTo(Buffer.from(emp.encPubkey, "hex"), empOut)
  const enc2 = await client.enc.encryptUtxo(changeOut)

  const extDataHashBytes = sdk.getExtDataHash({
    recipient: feeRecipient, extAmount: 0,
    encryptedOutput1: enc1, encryptedOutput2: enc2,
    fee: feePerTx, feeRecipient, mintAddress: sdk.WRAPPED_SOL_MINT,
  })
  const extDataHash = new BN(Buffer.from(extDataHashBytes).toString("hex"), 16, "le").toString()

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

  const { proof, publicSignals } = await proveOn(t2Pool, circuitInput)
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
    outputCommitments: [pub[5], pub[6]],
  }

  const accounts = sdk.deriveAccounts(PROGRAM_ID, Uint8Array.from(pub[3]), Uint8Array.from(pub[4]))
  const ixData = sdk.buildTransactIxData(false, proofSubmit, 0, feePerTx, enc1, enc2, accounts.bump0, accounts.bump1)

  const sys = SystemProgram.programId.toBase58()
  const instruction = {
    programId: PROGRAM_ID.toBase58(),
    accounts: [
      { address: accounts.treeAccount.toBase58(), role: 1 },
      { address: accounts.nullifier0.toBase58(), role: 1 },
      { address: accounts.nullifier1.toBase58(), role: 1 },
      { address: accounts.nullifier2.toBase58(), role: 0 },
      { address: accounts.nullifier3.toBase58(), role: 0 },
      { address: accounts.treeTokenAccount.toBase58(), role: 1 },
      { address: accounts.globalConfig.toBase58(), role: 0 },
      { address: feeRecipient58, role: 1 },
      { address: feeRecipient58, role: 1 },
      { address: employers[poolIdx].publicKey.toBase58(), role: 3 },
      { address: sys, role: 0 },
    ],
    data: new Uint8Array(ixData),
  }
  return { instruction, employees: 1, size: ixData.length }
}

// root-history pipeline bound, batch3-style: 2 leaves per standard transact x
// PER_TX per tx = 6 leaves/tx; 8 slots x 6 = 48 in-flight, gate at 90.
const PIPELINE_SLOTS = 8
const GATE_AGE = 90
const SEND_ANYWAY_AGE = 97
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

const fillerIx = () => ({
  programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  accounts: [],
  data: new Uint8Array([0]),
})

async function payStdV1(poolIdx) {
  const { notes } = depResults[poolIdx]
  const empCount = poolSizes[poolIdx]
  const employeeOff = poolSizes.slice(0, poolIdx).reduce((s, x) => s + x, 0)

  const empKeys = []
  for (let seq = 0; seq < empCount; seq++) {
    const k = await sdk.fetchRecipientKeys(employees[employeeOff + seq].publicKey)
    if (!k) throw new Error(`employee ${employeeOff + seq} has no recipient keys`)
    empKeys.push(k)
  }
  laneEmpKeys.set(poolIdx, empKeys)

  const proveGroup = async (b) => {
    const group = []
    for (let g = b; g < Math.min(b + PER_TX, empCount); g++) {
      group.push(buildTransactStd(poolIdx, notes[g], g, employeeOff + g))
    }
    return Promise.all(group)
  }

  let paid = 0
  // budget = sum of per-instruction defaults: PER_TX transacts (200k each) +
  // the memo pad (200k). Real cost ~158k per transact — the pad is headroom.
  const cuLimit = (PER_TX + 1) * CU_BUDGET_PER_TRANSACT
  for (let b = 0; b < empCount; b += PER_TX) {
    const t0 = Date.now()
    await acquireSlot()
    try {
      let rebuilds = 0
      let fetchIdx = await chainNextIndex()
      let built = await proveGroup(b)
      const tProved = Date.now()
      for (;;) {
        const { blockhash } = await sdk.fetchBlockhash()
        const txIxs = [...built.map(x => x.instruction), fillerIx()]
        const { bytes, size, signature } = buildV1Tx(
          employers[poolIdx], blockhash, txIxs,
          { cuLimit, loadedDataSize: 64 * 1024 * 1024 },
        )
        if (size > 4_096) {
          throw new Error(
            `pool ${poolIdx} group ${b / PER_TX + 1}: packed tx ${size}B > 4096 — ` +
            `rerun with PER_TX=${PER_TX - 1}`,
          )
        }
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
        const sig = await sdk.submitTransaction(Buffer.from(bytes))
        const sendMs = Date.now() - tSend0
        paid += built.length
        logEvent(poolIdx, b / PER_TX + 1, "v1pay", {
          ms: Date.now() - t0,
          proveMs: tProved - t0,
          sendMs,
          sig: signature,
          size,
          transacts: built.length,
          employees: built.length,
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
const laneResults = await Promise.allSettled(employers.map((_, i) => payStdV1(i)))
const T_DONE = Date.now()
const failures = laneResults.filter(r => r.status === "rejected")
for (const f of failures) console.error("LANE FAILED:", f.reason)
t2Pool.kill()

// ---------------- verdict ----------------
const pays = events.filter(e => e.phase === "v1pay")
const deposits = events.filter(e => e.phase === "deposit")
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
const proveP50 = proveTimes.slice().sort((a, b) => a.total - b.total)[Math.floor(proveTimes.length / 2)]?.total ?? 0

let amountCheck = null
if (VARIED) {
  const mismatches = []
  const T_VER = Date.now()
  for (let i = 0; i < employees.length; i += 25) {
    await Promise.all(employees.slice(i, i + 25).map(async (empKp, j) => {
      const g = i + j
      const client = new sdk.PrivacyCashClient(localSigner(empKp), PROGRAM_ID)
      await client.syncNotes(sdk.SOL_TREE_KEY)
      const amounts = sdk.unspentNotes(client.publicKey).map((n) => BigInt(n.amount))
      if (!amounts.includes(payAmtAt(g))) {
        mismatches.push({ employee: g, expected: payAmtAt(g).toString(), found: amounts.map(String) })
      }
    }))
  }
  amountCheck = { employees: employees.length, mismatches: mismatches.length, ms: Date.now() - T_VER }
  console.log(`amount check: ${employees.length - mismatches.length}/${employees.length} employees hold exactly their own amount`)
  if (mismatches.length) console.error("first mismatches:", mismatches.slice(0, 5))
}

const summary = {
  pools: POOLS,
  employees: TOTAL,
  payLamports: PAY.toString(),
  varied: VARIED,
  amountCheck,
  circuit: "transaction2 (standard, no batch circuits)",
  transactsPerV1Tx: PER_TX,
  arkThreads: Number(process.env.ARK_THREADS ?? 1),
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
  proxyPending: status.pending.length,
  replicaNextIndex: verify.nextIndex,
  chainVerify: verify.chainVerify ?? verify,
}
console.log(JSON.stringify(summary, null, 2))
await mkdir(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
await writeFile(outFile, JSON.stringify({ summary, events, proveTimes }, null, 2))
console.log("wrote", outFile)
if (failures.length > 0 || status.stats.failed > 0) process.exitCode = 1
