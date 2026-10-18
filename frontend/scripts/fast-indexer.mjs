// In-memory chain mirror for the fast local backend. One incremental merkle
// tree per pool, rebuilt from nothing but the chain:
//   - order: getSignaturesForAddress gives slots; getBlock("signatures")
//     gives the execution order inside a slot, so same-slot lanes land in
//     the exact on-chain leaf order (the old shim guessed and drifted).
//   - only successful transact txs append leaves (failed txs mint nothing).
//   - push first: the program emits each transact's leaves as an
//     Anchor-style event (with its first leaf index), so the websocket logs
//     subscription alone indexes a tx: no RPC read. RPC catch-up runs only
//     at start, on websocket reconnect, on a leaf-index gap, and for txs
//     that carry no event (pre-upgrade program).
// Reads (paths, roots, commitments, nullifiers) are served from memory.
import { PublicKey } from "@solana/web3.js"
import { LocalMirror, MERKLE_TREE_DEPTH } from "privacy-cash-sdk"

export const ROOT_HISTORY = 100
// transact / transact_spl carry a raw proof (64+128+64 bytes of points), then
// the public inputs. Swap (7, compressed proofs) is indexed from its events.
const DISC_TRANSACT_SOL = 2
const DISC_TRANSACT_SPL = 3
const PROOF_POINTS = { [DISC_TRANSACT_SOL]: 256, [DISC_TRANSACT_SPL]: 256 }

const be = (b) => {
  let r = 0n
  for (const x of b) r = (r << 8n) + BigInt(x)
  return r
}
export const dec2hex = (dec) => BigInt(dec).toString(16).padStart(64, "0")

/** Decode one transact instruction's data (disc + args). Null if not a transact. */
export function decodeTransact(raw) {
  const points = PROOF_POINTS[raw[0]]
  if (points === undefined || raw.length < 1 + points + 224 + 16) return null
  const disc = raw[0]
  const args = raw.subarray(1)
  // public inputs after the points: root, publicAmount, extDataHash, 2 nullifiers, 2 commitments
  const nul = points + 96
  const com = nul + 64
  let offset = com + 64 + 16 // + ExtDataMinified
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
    commitments: [Buffer.from(args.subarray(com, com + 32)), Buffer.from(args.subarray(com + 32, com + 64))],
    nullifiers: [Buffer.from(args.subarray(nul, nul + 32)), Buffer.from(args.subarray(nul + 32, nul + 64))],
    encrypted: [Buffer.from(enc1), Buffer.from(enc2)],
  }
}

const EVENT_SOL = "59f557fade1e878e"
const EVENT_SPL = "b894aefac583f888"

/**
 * Transact events our program emitted, from a logs notification. Only
 * `Program data:` lines inside the program's own invoke frame count, so a
 * different program can't forge one.
 * @returns {{ decoded, treeKey: string, index: number }[]}
 */
export function eventsFromLogs(logs, program) {
  const id = program.toBase58()
  const frames = []
  const out = []
  for (const line of logs ?? []) {
    const inv = /^Program (\S+) invoke \[\d+\]$/.exec(line)
    if (inv) {
      frames.push(inv[1])
      continue
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      frames.pop()
      continue
    }
    if (frames[frames.length - 1] !== id || !line.startsWith("Program data: ")) continue
    const e = decodeEvent(Buffer.from(line.slice(14), "base64"))
    if (e) out.push(e)
  }
  return out
}

/** Borsh body after the discriminator; null if it isn't a well-formed transact event. */
function decodeEvent(d) {
  if (d.length < 8) return null
  const disc = d.subarray(0, 8).toString("hex")
  const spl = disc === EVENT_SPL
  if (!spl && disc !== EVENT_SOL) return null
  let o = 8
  const take = (n) => {
    if (o + n > d.length) throw new Error("short event")
    const b = d.subarray(o, o + n)
    o += n
    return b
  }
  try {
    const index = take(4).readUInt32LE(0)
    const mint = spl ? take(32) : null
    const comm = take(64)
    const nulls = take(64)
    const enc1 = take(take(4).readUInt32LE(0))
    const enc2 = take(take(4).readUInt32LE(0))
    if (o !== d.length) return null
    return {
      index,
      treeKey: spl ? new PublicKey(mint).toBase58() : "sol",
      decoded: {
        spl,
        commitments: [comm.subarray(0, 32), comm.subarray(32, 64)],
        nullifiers: [nulls.subarray(0, 32), nulls.subarray(32, 64)],
        encrypted: [enc1, enc2],
      },
    }
  } catch {
    return null
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

/**
 * Pool appends of a fetched tx as [{decoded, treeKey, index?}]: the program's
 * events when it logged them (every instruction, swap included, with the
 * exact leaf index), else decoded transact instruction data (older txs).
 */
export function transactsOf(tx, program) {
  const events = eventsFromLogs(tx.meta?.logMessages, program)
  if (events.length > 0) return events
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
      // transact_spl accounts: tree, nullifier0, nullifier1, global_config, signer, mint, ...
      const idx = (ix.accountKeyIndexes ?? ix.accounts)?.[5]
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
  constructor({ conn, program, wasm, pollMs = 0, log = () => {}, onOutcome = () => {} }) {
    this.conn = conn
    this.program = program
    this.wasm = wasm
    /** 0 = no timer: push + reconnect/gap catch-up only */
    this.pollMs = pollMs
    this.log = log
    /** (sig, "confirmed" | "failed") for every program tx the indexer sees land */
    this.onOutcome = onOutcome
    /** @type {Map<string, Pool>} */
    this.pools = new Map()
    /** nullifier hex -> spending signature */
    this.nullifiers = new Map()
    this.lastSig = null
    this.lastSlot = 0
    this.passes = 0
    this.applied = 0
    /** counters for /indexer/status (grpc source fills grpcTxs/grpcAccounts) */
    this.stats = { pushTxs: 0, pushEvents: 0, rpcFallbacks: 0, gapSyncs: 0, reconnectSyncs: 0 }
    this.running = null
    this.again = false
    this.waiters = []
    /** signatures newer than lastSig already applied (or failed) */
    this.seen = new Set()
    /** every signature ever applied: RPC list order is not monotonic, so a
     *  landed tx can be listed again after the cursor passed it */
    this.appliedSigs = new Set()
    // `${treeKey}:${sig}`: a swap appends to two pools in one tx, so "applied"
    // is per pool; appliedSigs only says the tx was indexed somewhere
    this.appliedLegs = new Set()
    /** treeKey -> Map(sig -> candidate) of landed transacts not yet applied */
    this.pending = new Map()
    /** treeKey -> latest streamed tree account ({txCount, ring}) */
    this.streamTree = new Map()
    this.lastPassAt = 0
  }

  /** Everything needed to resume without replaying history (JSON-safe). */
  snapshot() {
    const pools = {}
    for (const [k, p] of this.pools) {
      pools[k] = { leaves: p.leaves.map((l) => [l.commitment, l.encryptedHex, l.signature, l.slot]), roots: p.roots }
    }
    return {
      v: 1,
      program: this.program.toBase58(),
      lastSig: this.lastSig,
      lastSlot: this.lastSlot,
      applied: this.applied,
      pools,
      nullifiers: [...this.nullifiers],
    }
  }

  /** Load a snapshot taken by snapshot(); false if it belongs to another program. */
  restore(snap) {
    if (snap?.v !== 1 || snap.program !== this.program.toBase58()) return false
    this.reset()
    for (const [k, { leaves, roots }] of Object.entries(snap.pools)) {
      const p = this.pool(k)
      for (const [commitment, encryptedHex, signature, slot] of leaves) {
        p.append(Buffer.from(commitment, "hex"), Buffer.from(encryptedHex, "hex"), signature, slot)
        this.appliedSigs.add(signature)
        this.appliedLegs.add(`${k}:${signature}`)
      }
      p.roots = roots
    }
    this.nullifiers = new Map(snap.nullifiers)
    this.lastSig = snap.lastSig
    this.lastSlot = snap.lastSlot
    this.applied = snap.applied
    return true
  }

  reset() {
    this.pools = new Map()
    this.nullifiers = new Map()
    this.lastSig = null
    this.lastSlot = 0
    this.applied = 0
    this.seen = new Set()
    this.appliedSigs = new Set()
    // `${treeKey}:${sig}`: a swap appends to two pools in one tx, so "applied"
    // is per pool; appliedSigs only says the tx was indexed somewhere
    this.appliedLegs = new Set()
    this.pending = new Map()
    this.streamTree = new Map()
  }

  /**
   * Does every pool end on the chain's current root? A restored snapshot
   * from another chain (a reset local validator) fails this. Re-syncs and
   * retries while txs are still landing.
   */
  async matchesChain(tries = 3) {
    for (let i = 0; i < tries; i++) {
      let ok = true
      let behind = false
      for (const [k, p] of this.pools) {
        const chain = await this.chainTree(k)
        const count = p.leaves.length / 2
        if (!chain || chain.txCount < count) return false
        if (chain.txCount > count) {
          behind = true
          continue
        }
        if (chain.ring[chain.txCount % ROOT_HISTORY] !== p.root()) ok = false
      }
      if (!ok) return false
      if (!behind) return true
      await this.sync()
    }
    return false
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
    this.subId = this.conn.onLogs(this.program, (l, ctx) => this.ingestLogs(l, ctx.slot), "confirmed")
    // Notifications sent while the socket was down are lost: catch up over
    // RPC on every reopen (web3.js reconnects on its own).
    let opened = false
    this.conn._rpcWebSocket?.on?.("open", () => {
      if (!opened) return void (opened = true)
      this.stats.reconnectSyncs++
      this.sync().catch(() => {})
    })
    if (this.pollMs > 0) this.timer = setInterval(() => this.sync().catch(() => {}), this.pollMs)
  }

  stop() {
    clearInterval(this.timer)
    clearTimeout(this.gapTimer)
    if (this.subId != null) this.conn.removeOnLogsListener(this.subId).catch(() => {})
  }

  /** Push path (websocket logs): index straight from the program's events. */
  ingestLogs({ signature, err, logs }, slot) {
    this.stats.pushTxs++
    this.onOutcome(signature, err ? "failed" : "confirmed")
    if (err) return
    const events = eventsFromLogs(logs, this.program).filter((e) => !this.appliedLegs.has(`${e.treeKey}:${signature}`))
    if (events.length === 0 && this.appliedSigs.has(signature)) return
    if (events.length === 0) {
      // no event: a pre-upgrade transact or a non-transact ix; RPC decides
      this.stats.rpcFallbacks++
      this.sync().catch(() => {})
      return
    }
    for (const e of events) {
      this.stats.pushEvents++
      this.addPending(e.treeKey, { sig: signature, slot, t: { decoded: e.decoded, treeKey: e.treeKey }, index: e.index })
      this.drain(e.treeKey, this.streamTree.get(e.treeKey) ?? null, false)
    }
    this.flushWaiters()
  }

  /** A pending event sits past the next leaf: give the stream a moment, then fill the gap over RPC. */
  scheduleGapSync() {
    if (this.gapTimer) return
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null
      const behind = [...this.pending.entries()].some(([k, m]) => {
        const next = this.pool(k).leaves.length
        return [...m.values()].some((c) => c.index !== undefined && c.index > next)
      })
      if (!behind) return
      this.stats.gapSyncs++
      this.sync().catch(() => {})
    }, 750)
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
    const start = Date.now()
    const deadline = start + timeoutMs
    // Pushed events land on their own; RPC only if they don't within the grace.
    const graceMs = this.subId != null ? Math.min(1500, timeoutMs / 2) : 0
    while (Date.now() < deadline) {
      if (Date.now() - start >= graceMs && !this.running) this.sync().catch(() => {})
      await new Promise((r) => {
        this.waiters.push(r)
        setTimeout(r, 250)
      })
      if (pred()) return true
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
    if (tx.meta?.err) return
    for (const t of transactsOf(tx, this.program)) {
      if (this.appliedLegs.has(`${t.treeKey}:${signature}`)) continue
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
    if (!this.appliedLegs.has(`${treeKey}:${cand.sig}`)) m.set(cand.sig, cand)
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
          this.onOutcome(s.signature, "failed")
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
          this.addPending(t.treeKey, { sig: s.signature, slot: s.slot, t: { decoded: t.decoded, treeKey: t.treeKey }, index: t.index })
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
      // an event names its own first leaf: no ordering guesswork
      const at = pool.leaves.length
      let pick = [...pending.values()].find((c) => c.index === at)
      if (pick) {
        pending.delete(pick.sig)
        this.applyTransact(pick.sig, pick.slot, pick.t)
        this.seen.add(pick.sig)
        this.appliedSigs.add(pick.sig)
        this.appliedLegs.add(`${treeKey}:${pick.sig}`)
        continue
      }
      for (const [sig, c] of pending) if (c.index !== undefined && c.index < at) pending.delete(sig) // already indexed via RPC
      if ([...pending.values()].some((c) => c.index !== undefined)) this.scheduleGapSync()
      const next = pool.leaves.length / 2 + 1
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
      this.appliedLegs.add(`${treeKey}:${pick.sig}`)
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
