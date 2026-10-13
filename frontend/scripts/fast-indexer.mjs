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
    this.wasm = wasm
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
  /** Root the tree would have after appending (c0, c1) — nothing mutated. */
  rootAfter(c0Buf, c1Buf) {
    const i = this.leaves.length
    const path = this.mirror.path(i)
    let node = this.wasm.poseidonHashString([be(c0Buf).toString(), be(c1Buf).toString()])
    let idx = i >> 1
    for (let lv = 1; lv < MERKLE_TREE_DEPTH; lv++) {
      node = idx & 1 ? this.wasm.poseidonHashString([path[lv], node]) : this.wasm.poseidonHashString([node, path[lv]])
      idx >>= 1
    }
    return dec2hex(node)
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
    /** counters for /indexer/status (grpc source fills grpcTxs/grpcAccounts) */
    this.stats = {}
    this.running = null
    this.again = false
    this.waiters = []
    /** signatures newer than lastSig already applied (or failed) */
    this.seen = new Set()
    /** every signature ever applied: RPC list order is not monotonic, so a
     *  landed tx can be listed again after the cursor passed it */
    this.appliedSigs = new Set()
    /** treeKey -> Map(sig -> candidate) of landed transacts not yet applied */
    this.pending = new Map()
    /** treeKey -> latest streamed tree account ({txCount, ring}) */
    this.streamTree = new Map()
    this.lastPassAt = 0
  }

  pool(treeKey) {
    let p = this.pools.get(treeKey)
    if (!p) {
      p = new Pool(this.wasm, treeKey)
      this.pools.set(treeKey, p)
    }
    return p
  }

  /** Apply one transact to its pool. */
  applyTransact(signature, slot, { decoded, treeKey }) {
    const p = this.pool(treeKey)
    p.append(decoded.commitments[0], decoded.encrypted[0], signature, slot)
    p.append(decoded.commitments[1], decoded.encrypted[1], signature, slot)
    p.pushRoot()
    for (const n of decoded.nullifiers) this.nullifiers.set(n.toString("hex"), signature)
    this.applied++
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

  /** Single-flight sync; calls during a pass coalesce into one more pass. */
  sync() {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          const gap = 40 - (Date.now() - this.lastPassAt)
          if (gap > 0) await new Promise((r) => setTimeout(r, gap))
          this.lastPassAt = Date.now()
          await this.pass()
          this.flushWaiters()
        } while (this.again)
      } finally {
        this.running = null
        this.flushWaiters()
      }
    })()
    return this.running
  }

  /** Resolve once `pred()` holds: one sync request, then wait on passes. */
  async waitFor(pred, timeoutMs = 10_000) {
    if (pred()) return true
    const deadline = Date.now() + timeoutMs
    this.sync().catch(() => {})
    while (Date.now() < deadline) {
      await new Promise((r) => {
        this.waiters.push(r)
        setTimeout(r, 250)
      })
      if (pred()) return true
      if (!this.running) this.sync().catch(() => {})
    }
    return pred()
  }

  flushWaiters() {
    const w = this.waiters
    this.waiters = []
    for (const r of w) r()
  }

  /** On-chain tree account: tx count + the 100-root ring, or null. */
  async chainTree(treeKey) {
    const seeds = [Buffer.from("merkle_tree")]
    if (treeKey !== "sol") seeds.push(new PublicKey(treeKey).toBuffer())
    const [pda] = PublicKey.findProgramAddressSync(seeds, this.program)
    const acct = await this.conn.getAccountInfo(pda, "confirmed").catch(() => null)
    return acct ? parseTreeAccount(acct.data) : null
  }

  treePda(treeKey) {
    const seeds = [Buffer.from("merkle_tree")]
    if (treeKey !== "sol") seeds.push(new PublicKey(treeKey).toBuffer())
    return PublicKey.findProgramAddressSync(seeds, this.program)[0]
  }

  /** Push path (gRPC): a confirmed tx with its full message — no RPC needed. */
  ingestStreamTx(signature, slot, tx) {
    if (this.appliedSigs.has(signature) || tx.meta?.err) return
    for (const t of transactsOf(tx, this.program)) {
      this.addPending(t.treeKey, { sig: signature, slot, t })
      this.drain(t.treeKey, this.streamTree.get(t.treeKey) ?? null, false)
    }
    this.flushWaiters()
  }

  /** Push path (gRPC): the tree account changed — its root ring orders the pending txs. */
  ingestStreamTree(treeKey, data) {
    const chain = parseTreeAccount(data)
    if (!chain) return
    this.streamTree.set(treeKey, chain)
    this.drain(treeKey, chain, false)
    this.flushWaiters()
  }

  addPending(treeKey, cand) {
    let m = this.pending.get(treeKey)
    if (!m) this.pending.set(treeKey, (m = new Map()))
    if (!this.appliedSigs.has(cand.sig)) m.set(cand.sig, cand)
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
    for (const s of sigs) if (this.appliedSigs.has(s.signature)) this.seen.add(s.signature)
    const fresh = sigs.filter((s) => !this.seen.has(s.signature))
    if (fresh.length > 0) {
      const ordered = await this.chainOrder(fresh)
      const txs = await mapLimit(ordered, 16, (s) =>
        s.err
          ? Promise.resolve(null)
          : this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
      )
      const touched = new Set()
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i]
        if (s.err || (txs[i] && txs[i].meta?.err)) {
          this.seen.add(s.signature)
          continue
        }
        if (!txs[i]) continue // landed but not fetchable yet: next pass
        const ts = transactsOf(txs[i], this.program)
        if (ts.length === 0) {
          this.seen.add(s.signature)
          continue
        }
        for (const t of ts) {
          this.addPending(t.treeKey, { sig: s.signature, slot: s.slot, t })
          touched.add(t.treeKey)
        }
      }
      for (const treeKey of touched) this.drain(treeKey, await this.chainTree(treeKey), true)
    }
    // the cursor moves only once everything it covers has been applied
    if (sigs.length > 0 && sigs.every((s) => this.seen.has(s.signature))) {
      this.lastSig = sigs[0].signature
      this.seen.clear()
    }
  }

  /**
   * Apply a pool's pending transacts in true execution order: the chain's
   * root ring says which root comes next, so the tx that produces it goes
   * next — whatever order the RPC or stream delivered them in. A tx whose
   * predecessor isn't here yet waits. `blind` (RPC catch-up only) allows
   * list order when the ring can't decide (no account, or >100 txs behind).
   */
  drain(treeKey, chain, blind) {
    const pending = this.pending.get(treeKey)
    if (!pending || pending.size === 0) return
    const pool = this.pool(treeKey)
    for (;;) {
      if (pending.size === 0) return
      const next = pool.leaves.length / 2 + 1
      let pick
      if (chain && chain.txCount < next) return // the chain hasn't caught up to us: wait
      if (chain && chain.txCount - next < ROOT_HISTORY) {
        const want = chain.ring[next % ROOT_HISTORY]
        pick = [...pending.values()].find(
          (c) => pool.rootAfter(c.t.decoded.commitments[0], c.t.decoded.commitments[1]) === want,
        )
        if (!pick) {
          if (this.stuckAt !== next) this.log(`indexer: no pending tx yields chain root #${next} (${pending.size} pending), waiting`)
          this.stuckAt = next
          return
        }
      } else if (blind) {
        pick = pending.values().next().value
      } else {
        return
      }
      pending.delete(pick.sig)
      this.applyTransact(pick.sig, pick.slot, pick.t)
      this.seen.add(pick.sig)
      this.appliedSigs.add(pick.sig)
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

/** Tree account -> { txCount, ring }: next_index u32 @8, root ring @848. */
export function parseTreeAccount(data) {
  const d = Buffer.from(data)
  if (d.length < 848 + 32 * ROOT_HISTORY) return null
  const ring = []
  for (let i = 0; i < ROOT_HISTORY; i++) ring.push(d.subarray(848 + i * 32, 880 + i * 32).toString("hex"))
  return { txCount: d.readUInt32LE(8) / 2, ring }
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
