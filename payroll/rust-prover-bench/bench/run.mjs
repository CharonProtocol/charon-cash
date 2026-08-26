// Fast payroll worker benchmark: chain-truth proxy + client-signed txs.
// Usage: bun run.mjs [pools] [totalEmployees] [payLamports]
// Phases: airdrop -> register recipients -> deposits -> chained payouts -> verdict.

import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { existsSync } from "node:fs"
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"
import { wtns } from "snarkjs"
import { utils } from "ffjavascript"
import * as sdk from "privacy-cash-sdk"

const execFileAsync = promisify(execFile)

const POOLS = Number(process.argv[2] ?? process.env.POOLS ?? 16)
const TOTAL = Number(process.argv[3] ?? process.env.EMPLOYEES ?? 210)
const PAY = BigInt(process.argv[4] ?? process.env.PAY ?? "50000000") // 0.05 SOL
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8788"
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr")
const PROVER_BIN = process.env.RAPIDSNARK_BIN ?? "/tmp/rapidsnark-src/build_osx/src/prover"
const CIRCUIT = process.env.CIRCUIT ?? "/Users/singupallikartik/Developer/chat/privacy-cash/programs/privacy-cash/artifacts/circuits/transaction2"
const FEE_SLACK_PER_HOP = 1_000_000n // 0.001 SOL per hop for relayer fee
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/pfast"

if (typeof sdk.setBackendUrl !== "function" || typeof sdk.setProver !== "function") {
  throw new Error("SDK exports missing setBackendUrl/setProver: " + Object.keys(sdk).join(","))
}
sdk.setBackendUrl(PROXY)

// rapidsnark prover (identical to payroll/src/lib/native-prover.ts)
const proveTimes = []
// cap concurrent proves: 16 simultaneous rapidsnark processes thrash the
// 4P+4E cores (measured 0.57s solo -> 7.8s at 16-way contention)
const ARK_BIN = process.env.ARK_BIN ?? "/Users/singupallikartik/Developer/chat/privacy-cash/payroll/rust-prover-bench/target/release/prover-server"
const ARK_PROVERS = Number(process.env.ARK_PROVERS ?? 4)
const PROVE_CONCURRENCY = Number(process.env.PROVE_CONCURRENCY ?? (existsSync(ARK_BIN) ? ARK_PROVERS : 4))
let proveActive = 0
const proveWaiters = []
async function withProveSlot(fn) {
  if (proveActive >= PROVE_CONCURRENCY) await new Promise(r => proveWaiters.push(r))
  proveActive++
  try {
    return await fn()
  } finally {
    proveActive--
    proveWaiters.shift()?.()
  }
}
const haveRapidsnark = existsSync(PROVER_BIN)
const haveArk = existsSync(ARK_BIN)

class ArkPool {
  constructor(n) {
    this.nextId = 1
    this.children = []
    this.waiters = []
    for (let i = 0; i < n; i++) this.children.push(this.#spawn())
  }
  #spawn() {
    const child = spawn(ARK_BIN, [], {
      env: { ...process.env, ARK_THREADS: process.env.ARK_THREADS ?? "1", ARK_G2: "c0c1" },
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
    while (this.waiters.length) {
      const ch = this.children.find(c => c.ready && c.queue === 0)
      if (!ch) break
      ch.queue++
      this.waiters.shift()(ch)
    }
  }
  async #acquire() {
    const free = this.children.find(c => c.ready && c.queue === 0)
    if (free) {
      free.queue++
      return free
    }
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
      const t = setTimeout(() => r(), 60_000)
      const check = setInterval(() => { if (c.ready) { clearTimeout(t); clearInterval(check); r() } }, 50)
    })))
  }
}

let arkPool = null
if (haveArk) {
  arkPool = new ArkPool(ARK_PROVERS)
  await arkPool.warmup()
  console.log(`ark prover pool: ${ARK_PROVERS} servers ready`)
  sdk.setProver(async (input) => {
    return withProveSlot(async () => {
      const normalized = JSON.parse(JSON.stringify(utils.stringifyBigInts(input)))
      const t0 = Date.now()
      const resp = await arkPool.request(normalized)
      proveTimes.push({ wtns: resp.witnessMs, prove: 0, total: Date.now() - t0, at: Date.now() })
      return { proof: resp.proof, publicSignals: resp.publicSignals }
    })
  })
} else if (!haveRapidsnark) {
  console.log("NOTE: rapidsnark binary missing — falling back to SDK default snarkjs prover")
  if (typeof sdk.setCircuitBuffers === "function") {
    sdk.setCircuitBuffers(new Uint8Array(await readFile(CIRCUIT + ".wasm")), new Uint8Array(await readFile(CIRCUIT + ".zkey")))
  }
}
if (!haveArk && haveRapidsnark) sdk.setProver(async (input) => {
  return withProveSlot(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-proof-"))
  try {
    const t0 = Date.now()
    const witnessPath = join(dir, "input.wtns")
    await wtns.calculate(
      utils.stringifyBigInts(input),
      CIRCUIT + ".wasm",
      witnessPath,
    )
    const tWtns = Date.now()
    await execFileAsync(PROVER_BIN, [CIRCUIT + ".zkey", witnessPath, join(dir, "p.json"), join(dir, "pub.json")])
    const tProve = Date.now()
    const [proof, pub] = await Promise.all([
      readFile(join(dir, "p.json"), "utf8"),
      readFile(join(dir, "pub.json"), "utf8"),
    ])
    proveTimes.push({ wtns: tWtns - t0, prove: tProve - tWtns, total: Date.now() - t0, at: Date.now() })
    const parsed = JSON.parse(proof)
    return { proof: { ...parsed, curve: parsed.curve ?? "bn128" }, publicSignals: JSON.parse(pub) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

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

// After a hop lands, the SDK saves the change note at locateNoteLeaf's best
// guess. Under 16-lane concurrency the real leaf can be 20-30 past the guess,
// and if the replica was >10s behind the SDK keeps the WRONG index — the next
// hop then proves against a merkle path for someone else's leaf and dies with
// InvalidProof. Chain transfers never call syncNotes, so nothing corrects it.
// Here we ask the proxy where the tx ACTUALLY landed (it decodes every
// submitted tx and appends leaves in landing order) and rewrite the note.
async function healNoteIndex(client, sig, outputOffset, blinding) {
  const deadline = Date.now() + 30_000
  let leafStart = null
  while (Date.now() < deadline) {
    const r = await (await fetch(`${PROXY}/local/sig/${sig}`)).json()
    if (r.processed) { leafStart = r.leafStart; break }
    await new Promise(res => setTimeout(res, 250))
  }
  if (leafStart === null) throw new Error("proxy never recorded landing for " + sig)
  const trueIndex = leafStart + outputOffset
  const notes = sdk.loadNotes(client.publicKey)
  const note = notes.find(n => !n.spent && n.blinding === blinding)
  if (!note) throw new Error("note with blinding " + blinding + " not in store to heal")
  if (note.index === trueIndex) return false
  // the lane wallet holds exactly one unspent note (the chained change), so a
  // full clear + re-save cannot lose anything
  sdk.clearNotes(client.publicKey)
  sdk.saveNote(client.publicKey, { ...note, index: trueIndex, spent: false, depositTx: sig })
  return true
}

function localSigner(kp) {
  return {
    publicKey: kp.publicKey,
    signMessage: async (msg) => nacl.sign.detached(new Uint8Array(msg), kp.secretKey),
    signTransaction: async (tx) => {
      // both legacy Transaction and VersionedTransaction expose sign([kp]);
      // instanceof fails across the SDK's bundled web3.js copy, so duck-type
      tx.sign([kp])
      return tx
    },
  }
}

const events = []
function logEvent(pool, seq, phase, fields) {
  events.push({ t: Date.now(), pool, seq, phase, ...fields })
}

// ---------------- setup ----------------
const base = Math.floor(TOTAL / POOLS)
const extra = TOTAL % POOLS
const poolSizes = Array.from({ length: POOLS }, (_, i) => base + (i < extra ? 1 : 0))
console.log(`run: ${POOLS} pools, ${TOTAL} employees (sizes ${base}-${base + (extra ? 1 : 0)}), pay ${PAY} lamports`)

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
logEvent(-1, -1, "airdrop", { pools: POOLS })

console.log("registering", TOTAL, "recipients")
const T_REG = Date.now()
// register sequentially in batches to keep KV writes cheap
const BATCH = 25
for (let i = 0; i < employees.length; i += BATCH) {
  await Promise.all(employees.slice(i, i + BATCH).map(emp =>
    sdk.publishRecipientKeys(localSigner(emp)).catch(e => { throw new Error("register " + i + ": " + e.message) })
  ))
}
console.log(`registered in ${((Date.now() - T_REG) / 1000).toFixed(1)}s`)
logEvent(-1, -1, "register", { employees: TOTAL, ms: Date.now() - T_REG })

// ---------------- lanes ----------------
async function runPool(poolIdx) {
  const empCount = poolSizes[poolIdx]
  const signer = localSigner(employers[poolIdx])
  const client = new sdk.PrivacyCashClient(signer, PROGRAM_ID)

  const poolAmount = BigInt(empCount) * PAY + BigInt(empCount) * FEE_SLACK_PER_HOP + 2_000_000n
  const d0 = Date.now()
  const dep = await client.depositSOL(Number(poolAmount))
  logEvent(poolIdx, 0, "deposit", { ms: Date.now() - d0, amount: poolAmount.toString() })
  // deposit note = the tx's first commitment (the paired second is a zero note)
  const depNote = sdk.unspentNotes(client.publicKey)[0]
  if (await healNoteIndex(client, dep.signature, 0, depNote.blinding)) {
    logEvent(poolIdx, 0, "heal-deposit", {})
  }

  let employeeOff = poolSizes.slice(0, poolIdx).reduce((s, x) => s + x, 0)
  let nextPin = null
  for (let seq = 0; seq < empCount; seq++) {
    const emp = employees[employeeOff + seq]
    const t0 = Date.now()
    let submittedInfo = null
    const r = await client.transferNoteSOL(emp.publicKey, Number(PAY), {
      relay: false,
      inputNote: nextPin ?? undefined,
      onSubmitted: (info) => { submittedInfo = info },
    })
    logEvent(poolIdx, seq + 1, "pay", {
      ms: Date.now() - t0,
      sig: r.signature,
      employee: employeeOff + seq,
      changeAmt: submittedInfo?.changeAmount ?? null,
    })
    if (seq + 1 < empCount) {
      if (!submittedInfo?.changeBlinding) {
        throw new Error(`pool ${poolIdx} seq ${seq}: no change blinding for next hop`)
      }
      if (await healNoteIndex(client, r.signature, 1, submittedInfo.changeBlinding)) {
        logEvent(poolIdx, seq + 1, "heal-change", {})
      }
      nextPin = { blinding: submittedInfo.changeBlinding }
    }
  }
}

const T_PAY = Date.now()
const laneResults = await Promise.allSettled(employers.map((_, i) => runPool(i)))
const T_DONE = Date.now()
const failures = laneResults.filter(r => r.status === "rejected")
for (const f of failures) console.error("LANE FAILED:", f.reason)

// ---------------- verdict ----------------
await new Promise(r => setTimeout(r, 1500))
const status = await (await fetch(PROXY + "/local/status")).json()
const verify = await (await fetch(PROXY + "/local/verify")).json()

const pays = events.filter(e => e.phase === "pay")
const deposits = events.filter(e => e.phase === "deposit")
const proveTotalMs = proveTimes.reduce((s, p) => s + p.total, 0)
const proveMax = proveTimes.reduce((s, p) => Math.max(s, p.total), 0)
const proveP50 = proveTimes.slice().sort((a, b) => a.total - b.total)[Math.floor(proveTimes.length / 2)]?.total ?? 0

const summary = {
  pools: POOLS,
  employees: TOTAL,
  payLamports: PAY.toString(),
  depositsLanded: deposits.length,
  paysAttempted: pays.length,
  paysLanded: status.stats.processed - deposits.length >= 0 ? status.stats.processed : -1,
  txsProcessedByProxy: status.stats.processed,
  expectedTxs: POOLS + TOTAL,
  laneFailures: failures.length,
  setupMs: T_PAY - T_START,
  payWallMs: T_DONE - T_PAY,
  totalWallMs: T_DONE - T_START,
  proves: proveTimes.length,
  proveTotalMs,
  proveP50Ms: proveP50,
  proveMaxMs: proveMax,
  proxyPending: status.pending.length,
  replicaNextIndex: status.nextIndex,
  chainVerify: verify,
}
console.log("\n===== SUMMARY =====")
console.log(JSON.stringify(summary, null, 2))

const stamp = new Date(T_START).toISOString().replace(/[:.]/g, "-")
await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, `run-${stamp}.json`), JSON.stringify({ summary, events, proveTimes }, null, 2))
console.log("wrote", join(OUT_DIR, `run-${stamp}.json`))
if (failures.length || verify.nextIndexMatch === false) process.exit(1)
