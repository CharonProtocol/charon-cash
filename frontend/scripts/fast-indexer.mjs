// In-memory chain mirror for the fast local backend. One incremental merkle
// tree per pool, rebuilt from nothing but the chain:
//   - order: getSignaturesForAddress gives slots; getBlock("signatures")
//     gives the execution order inside a slot, so same-slot lanes land in
//     the exact on-chain leaf order (the old shim guessed and drifted).
//   - only successful transact txs append leaves (failed txs mint nothing).
//   - push first: a websocket logs subscription (or the relayer's own send)
//     triggers a sync pass immediately; a short poll is only the safety net.
// Reads (paths, roots, commitments, nullifiers) are served from memory.
import { PublicKey } from "@solana/web3.js"
import { LocalMirror, MERKLE_TREE_DEPTH } from "privacy-cash-sdk"

export const ROOT_HISTORY = 100
const DISC_TRANSACT_SOL = 2
const DISC_TRANSACT_SPL = 3

const be = (b) => {
  let r = 0n
  for (const x of b) r = (r << 8n) + BigInt(x)
  return r
}
export const dec2hex = (dec) => BigInt(dec).toString(16).padStart(64, "0")

/** Decode one transact instruction's data (disc + args). Null if not a transact. */
export function decodeTransact(raw) {
  if (raw.length < 497) return null
  const disc = raw[0]
  if (disc !== DISC_TRANSACT_SOL && disc !== DISC_TRANSACT_SPL) return null
  const args = raw.subarray(1)
  let offset = 480 + 16 // proof + ExtDataMinified
  const readLenPref = () => {
    const len = args.readUInt32LE(offset)
    offset += 4
    const slice = args.subarray(offset, offset + len)
    offset += len
    if (slice.length !== len) throw new Error("short encrypted output")
    return slice
  }
  let enc1, enc2
  try {
    enc1 = readLenPref()
    enc2 = readLenPref()
  } catch {
    return null
  }
  return {
    spl: disc === DISC_TRANSACT_SPL,
    commitments: [Buffer.from(args.subarray(416, 448)), Buffer.from(args.subarray(448, 480))],
    nullifiers: [Buffer.from(args.subarray(352, 384)), Buffer.from(args.subarray(384, 416))],
    encrypted: [Buffer.from(enc1), Buffer.from(enc2)],
  }
}

function accountKeys(tx) {
  const msg = tx.transaction.message
  const statics = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) =>
    k.pubkey ? new PublicKey(k.pubkey) : new PublicKey(k),
  )
  const w = (tx.meta?.loadedAddresses?.writable ?? []).map((k) => new PublicKey(k))
  const r = (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => new PublicKey(k))
  return [...statics, ...w, ...r]
}

/** Transact instructions of a fetched tx as [{decoded, treeKey}], program-checked. */
export function transactsOf(tx, program) {
  const keys = accountKeys(tx)
  const msg = tx.transaction.message
  const out = []
  for (const ix of msg.compiledInstructions ?? msg.instructions ?? []) {
    const prog = keys[ix.programIdIndex]
    if (!prog?.equals(program)) continue
    const raw = typeof ix.data === "string" ? Buffer.from(ix.data, "base64") : Buffer.from(ix.data)
    const d = decodeTransact(raw)
    if (!d) continue
    let treeKey = "sol"
    if (d.spl) {
      const idx = (ix.accountKeyIndexes ?? ix.accounts)?.[7]
      treeKey = idx != null && keys[idx] ? keys[idx].toBase58() : "spl-unknown"
    }
    out.push({ decoded: d, treeKey })
  }
  return out
}

class Pool {
  constructor(wasm, treeKey) {
    this.treeKey = treeKey
    this.mirror = new LocalMirror(wasm)
    /** @type {{commitment: string, encryptedHex: string, signature: string, slot: number}[]} */
    this.leaves = []
    /** commitment hex (lowercase, no 0x) -> leaf index */
    this.byCommitment = new Map()
    /** encrypted output hex -> leaf index */
    this.byEncrypted = new Map()
    this.roots = [dec2hex(this.mirror.root())]
  }
  append(commitmentBuf, encBuf, signature, slot) {
    const index = this.leaves.length
    const commitment = commitmentBuf.toString("hex")
    const encryptedHex = encBuf.toString("hex")
    this.mirror.insert(be(commitmentBuf).toString())
    this.leaves.push({ commitment, encryptedHex, signature, slot })
    this.byCommitment.set(commitment, index)
    this.byEncrypted.set(encryptedHex, index)
    return index
  }
  /** Called once per tx (2 leaves = one on-chain root update). */
  pushRoot() {
    this.roots.push(dec2hex(this.mirror.root()))
    if (this.roots.length > ROOT_HISTORY) this.roots.shift()
  }
  root() {
    return dec2hex(this.mirror.root())
  }
  proof(index) {
    if (index < 0 || index >= this.leaves.length) return null
    return {
      root: this.root().toUpperCase(),
      next_leaf_index: this.leaves.length,
      path_elements: this.mirror.path(index).map((d) => "0x" + dec2hex(d)),
      path_indices: Array.from({ length: MERKLE_TREE_DEPTH }, (_, i) => (index >> i) & 1),
    }
  }
}

export class FastIndexer {
  /**
   * @param {{ conn: import("@solana/web3.js").Connection, program: PublicKey, wasm: unknown,
   *           pollMs?: number, log?: (s: string) => void }} opts
   */
  constructor({ conn, program, wasm, pollMs = 1000, log = () => {} }) {
    this.conn = conn
    this.program = program
    this.wasm = wasm
    this.pollMs = pollMs
    this.log = log
    /** @type {Map<string, Pool>} */
    this.pools = new Map()
    /** nullifier hex -> spending signature */
    this.nullifiers = new Map()
    this.lastSig = null
    this.lastSlot = 0
    this.passes = 0
    this.applied = 0
    this.running = null
    this.again = false
    this.waiters = []
  }

  pool(treeKey) {
    let p = this.pools.get(treeKey)
    if (!p) {
      p = new Pool(this.wasm, treeKey)
      this.pools.set(treeKey, p)
    }
    return p
  }

  /** Apply one landed tx (in chain order). Failed txs mint nothing. */
  applyTx(signature, slot, tx) {
    if (!tx || tx.meta?.err) return
    for (const { decoded, treeKey } of transactsOf(tx, this.program)) {
      const p = this.pool(treeKey)
      p.append(decoded.commitments[0], decoded.encrypted[0], signature, slot)
      p.append(decoded.commitments[1], decoded.encrypted[1], signature, slot)
      p.pushRoot()
      for (const n of decoded.nullifiers) this.nullifiers.set(n.toString("hex"), signature)
      this.applied++
    }
    this.lastSlot = Math.max(this.lastSlot, slot)
  }

  async start() {
    await this.sync()
    this.subId = this.conn.onLogs(this.program, () => this.sync().catch(() => {}), "confirmed")
    this.timer = setInterval(() => this.sync().catch(() => {}), this.pollMs)
  }

  stop() {
    clearInterval(this.timer)
    if (this.subId != null) this.conn.removeOnLogsListener(this.subId).catch(() => {})
  }

  /** Single-flight sync; a call during a pass schedules exactly one more. */
  sync() {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again)
      } finally {
        this.running = null
        this.flushWaiters()
      }
    })()
    return this.running
  }

  /** Resolve once `pred()` holds, syncing until `timeoutMs`. */
  async waitFor(pred, timeoutMs = 10_000) {
    if (pred()) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await this.sync()
      if (pred()) return true
      await new Promise((r) => {
        this.waiters.push(r)
        setTimeout(r, 150)
      })
    }
    return pred()
  }

  flushWaiters() {
    const w = this.waiters
    this.waiters = []
    for (const r of w) r()
  }

  async pass() {
    this.passes++
    const sigs = []
    let before
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(
        this.program,
        { until: this.lastSig ?? undefined, before, limit: 1000 },
        "confirmed",
      )
      sigs.push(...page)
      if (page.length < 1000) break
      before = page[page.length - 1].signature
    }
    if (sigs.length === 0) return
    const ordered = await this.chainOrder(sigs)
    const txs = await mapLimit(ordered, 16, (s) =>
      s.err
        ? Promise.resolve(null)
        : this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
    )
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i]
      // a landed-but-not-yet-fetchable tx: stop here, never skip a leaf
      if (!s.err && !txs[i]) break
      if (!s.err) this.applyTx(s.signature, s.slot, txs[i])
      this.lastSig = s.signature
    }
  }

  /** Oldest-first, with same-slot txs in block execution order. */
  async chainOrder(sigs) {
    const bySlot = new Map()
    for (const s of sigs) {
      const list = bySlot.get(s.slot) ?? []
      list.push(s)
      bySlot.set(s.slot, list)
    }
    const slots = [...bySlot.keys()].sort((a, b) => a - b)
    const out = []
    for (const slot of slots) {
      const list = bySlot.get(slot)
      if (list.length > 1) {
        // raw RPC: web3.js's getBlock schema rejects transactionDetails "signatures"
        const res = await this.conn._rpcRequest("getBlock", [
          slot,
          { transactionDetails: "signatures", maxSupportedTransactionVersion: 0, rewards: false, commitment: "confirmed" },
        ])
        if (res.error) throw new Error(`getBlock ${slot}: ${res.error.message}`)
        const block = res.result
        const pos = new Map((block?.signatures ?? []).map((sig, i) => [sig, i]))
        list.sort((a, b) => (pos.get(a.signature) ?? 0) - (pos.get(b.signature) ?? 0))
      }
      out.push(...list)
    }
    return out
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}
