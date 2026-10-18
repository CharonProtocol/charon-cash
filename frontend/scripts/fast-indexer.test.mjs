import { describe, expect, it } from "bun:test"
import { Keypair } from "@solana/web3.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import { LocalMirror } from "privacy-cash-sdk"

import { FastIndexer, dec2hex, decodeTransact, eventsFromLogs, transactsOf } from "./fast-indexer.mjs"
import { toTxLike } from "./grpc-source.mjs"

const wasm = await WasmFactory.getInstance()
const PROGRAM = Keypair.generate().publicKey

const field = (n) => {
  const b = Buffer.alloc(32)
  b.writeUInt32BE(n, 28)
  return b
}

/** transact ix data: disc 2 (raw proof), proof/public inputs, ExtDataMinified, 2 len-prefixed outputs */
function transactData(c0, c1, n0, n1) {
  const args = Buffer.alloc(480 + 16)
  field(n0).copy(args, 352)
  field(n1).copy(args, 384)
  field(c0).copy(args, 416)
  field(c1).copy(args, 448)
  const enc = (n) => {
    const body = Buffer.from(`enc-${n}`)
    const len = Buffer.alloc(4)
    len.writeUInt32LE(body.length)
    return Buffer.concat([len, body])
  }
  return Buffer.concat([Buffer.from([2]), args, enc(c0), enc(c1)])
}

/**
 * A fake RPC. `add` lists txs in RPC order; `truth` is the order the chain
 * actually executed the successful ones (defaults to add order) and drives
 * the tree account's root ring, exactly like the program's root_history.
 */
function fakeChain() {
  const sigs = [] // oldest first: {signature, slot, err}
  const txs = new Map()
  const blocks = new Map()
  const hidden = new Set()
  const truth = []
  const conn = {
    async getSignaturesForAddress(_p, { until }) {
      const newest = [...sigs].reverse()
      const cut = until ? newest.findIndex((s) => s.signature === until) : -1
      return cut === -1 ? newest : newest.slice(0, cut)
    },
    async _rpcRequest(method, [slot]) {
      if (method !== "getBlock") throw new Error(method)
      return { result: { signatures: blocks.get(slot) ?? [] } }
    },
    async getTransaction(sig) {
      return hidden.has(sig) ? null : txs.get(sig) ?? null
    },
    async getAccountInfo() {
      const m = new LocalMirror(wasm)
      const data = Buffer.alloc(848 + 32 * 100)
      Buffer.from(dec2hex(m.root()), "hex").copy(data, 848)
      truth.forEach(([c0, c1], k) => {
        m.insert(String(c0))
        m.insert(String(c1))
        Buffer.from(dec2hex(m.root()), "hex").copy(data, 848 + ((k + 1) % 100) * 32)
      })
      data.writeUInt32LE(truth.length * 2, 8)
      data[12] = truth.length % 100
      return { data }
    },
    onLogs() {
      return 1
    },
    async removeOnLogsListener() {},
  }
  const add = (signature, slot, [c0, c1, n0, n1], err = null) => {
    sigs.push({ signature, slot, err })
    blocks.set(slot, [...(blocks.get(slot) ?? []), signature])
    if (!err) truth.push([c0, c1])
    txs.set(signature, {
      meta: { err },
      transaction: {
        message: {
          staticAccountKeys: [PROGRAM],
          compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [], data: transactData(c0, c1, n0, n1) }],
        },
      },
    })
  }
  return { conn, add, blocks, hidden, truth }
}

const fold = (leafDec, index, path) => {
  let h = leafDec
  for (let lv = 0; lv < path.length; lv++) {
    const sib = BigInt(path[lv]).toString()
    h = (index >> lv) & 1 ? wasm.poseidonHashString([sib, h]) : wasm.poseidonHashString([h, sib])
  }
  return dec2hex(h)
}

const leafValues = (ix) => (ix.pools.get("sol")?.leaves ?? []).map((l) => parseInt(l.commitment, 16))

describe("FastIndexer", () => {
  it("orders same-slot txs by execution order, not RPC list order", async () => {
    const c = fakeChain()
    c.add("A", 5, [1, 2, 101, 102])
    c.add("B", 5, [3, 4, 103, 104])
    c.blocks.set(5, ["B", "A"])
    c.truth.reverse() // B executed first
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(leafValues(ix)).toEqual([3, 4, 1, 2])
  })

  it("failed txs mint no leaves and spend no nullifiers", async () => {
    const c = fakeChain()
    c.add("ok1", 1, [1, 2, 11, 12])
    c.add("bad", 2, [9, 9, 13, 14], { InstructionError: [1, { Custom: 5 }] })
    c.add("ok2", 3, [3, 4, 15, 16])
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(ix.pools.get("sol").leaves.length).toBe(4)
    expect(ix.nullifiers.has(field(13).toString("hex"))).toBe(false)
    expect(ix.nullifiers.get(field(15).toString("hex"))).toBe("ok2")
    expect(ix.pools.get("sol").roots.length).toBe(3) // empty root + one per landed tx
  })

  it("serves paths that fold to the root it reports", async () => {
    const c = fakeChain()
    for (let i = 0; i < 5; i++) c.add(`s${i}`, 10 + i, [2 * i + 1, 2 * i + 2, 200 + 2 * i, 201 + 2 * i])
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    const pool = ix.pools.get("sol")
    const ref = LocalMirror.fromLeaves(wasm, Array.from({ length: 10 }, (_, i) => String(i + 1)))
    expect(pool.root()).toBe(dec2hex(ref.root()))
    for (const i of [0, 3, 9]) {
      const pr = pool.proof(i)
      expect(fold(String(i + 1), i, pr.path_elements)).toBe(pr.root.toLowerCase())
    }
    expect(pool.proof(10)).toBeNull()
  })

  it("waits for a landed-but-unfetchable tx and resumes without skipping it", async () => {
    const c = fakeChain()
    c.add("t1", 1, [1, 2, 31, 32])
    c.add("t2", 2, [3, 4, 33, 34])
    c.add("t3", 3, [5, 6, 35, 36])
    c.hidden.add("t2")
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(leafValues(ix)).toEqual([1, 2])
    c.hidden.delete("t2")
    await ix.sync()
    expect(leafValues(ix)).toEqual([1, 2, 3, 4, 5, 6])
    expect(ix.pools.get("sol").byCommitment.get(field(4).toString("hex"))).toBe(3)
  })

  it("follows the chain root ring when the RPC lists a slot out of order across passes", async () => {
    const c = fakeChain()
    c.add("w", 7, [1, 2, 51, 52])
    c.add("x", 7, [3, 4, 53, 54])
    c.add("y", 7, [5, 6, 55, 56])
    c.truth.splice(0, 3, [5, 6], [1, 2], [3, 4]) // the chain executed y, w, x
    c.hidden.add("y") // and y is not fetchable on the first pass
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(leafValues(ix)).toEqual([]) // w and x wait for y
    c.hidden.delete("y")
    await ix.sync()
    expect(leafValues(ix)).toEqual([5, 6, 1, 2, 3, 4])
    const ring = (await c.conn.getAccountInfo()).data
    expect(ix.pools.get("sol").root()).toBe(Buffer.from(ring.subarray(848 + 3 * 32, 880 + 3 * 32)).toString("hex"))
  })

  it("never applies a tx twice when the RPC lists it again after the cursor moved", async () => {
    const c = fakeChain()
    c.add("p", 1, [1, 2, 61, 62])
    c.add("q", 2, [3, 4, 63, 64])
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    const orig = c.conn.getSignaturesForAddress
    c.conn.getSignaturesForAddress = async () => [{ signature: "p", slot: 1, err: null }] // stale relist
    await ix.sync()
    c.conn.getSignaturesForAddress = orig
    expect(leafValues(ix)).toEqual([1, 2, 3, 4])
    expect(ix.applied).toBe(2)
  })

  it("applies streamed (gRPC) txs in root-ring order with no RPC calls", async () => {
    const c = fakeChain()
    c.add("g1", 9, [1, 2, 71, 72])
    c.add("g2", 9, [3, 4, 73, 74])
    c.truth.reverse() // chain executed g2 first
    const noRpc = () => {
      throw new Error("stream path must not touch RPC")
    }
    const ix = new FastIndexer({ conn: { ...c.conn, getSignaturesForAddress: noRpc, getTransaction: noRpc, getAccountInfo: noRpc }, program: PROGRAM, wasm })
    const proto = (c0, c1, n0, n1) => ({
      signature: new Uint8Array(64),
      transaction: { message: { accountKeys: [PROGRAM.toBytes()], instructions: [{ programIdIndex: 0, accounts: new Uint8Array(), data: transactData(c0, c1, n0, n1) }] } },
      meta: { err: undefined, loadedWritableAddresses: [], loadedReadonlyAddresses: [] },
    })
    ix.ingestStreamTx("g1", 9, toTxLike(proto(1, 2, 71, 72)))
    expect(leafValues(ix)).toEqual([]) // no ring yet: wait
    ix.ingestStreamTree("sol", (await c.conn.getAccountInfo()).data)
    expect(leafValues(ix)).toEqual([]) // ring wants g2 first
    ix.ingestStreamTx("g2", 9, toTxLike(proto(3, 4, 73, 74)))
    expect(leafValues(ix)).toEqual([3, 4, 1, 2])
    expect(ix.nullifiers.get(field(71).toString("hex"))).toBe("g1")
  })

  it("indexes logged events with no RPC, in leaf-index order, and fills a gap over RPC", async () => {
    const c = fakeChain()
    c.add("e1", 5, [1, 2, 61, 62])
    c.add("e2", 6, [3, 4, 63, 64])
    c.add("e3", 7, [5, 6, 65, 66])
    let rpc = 0
    const counted = (fn) => (...a) => (rpc++, fn(...a))
    const conn = {
      ...c.conn,
      getSignaturesForAddress: counted(c.conn.getSignaturesForAddress),
      getTransaction: counted(c.conn.getTransaction),
      getAccountInfo: counted(c.conn.getAccountInfo),
    }
    const ix = new FastIndexer({ conn, program: PROGRAM, wasm })
    const outcomes = []
    ix.onOutcome = (sig, o) => outcomes.push([sig, o])
    ix.subId = 1
    ix.ingestLogs({ signature: "e1", err: null, logs: eventLogs(0, [1, 2, 61, 62]) }, 5)
    ix.ingestLogs({ signature: "e3", err: null, logs: eventLogs(4, [5, 6, 65, 66]) }, 7)
    expect(leafValues(ix)).toEqual([1, 2]) // e3 waits for leaf 2
    expect(rpc).toBe(0)
    await new Promise((r) => setTimeout(r, 900)) // gap timer -> RPC catch-up fetches e2
    await ix.running
    expect(leafValues(ix)).toEqual([1, 2, 3, 4, 5, 6])
    expect(ix.stats.gapSyncs).toBe(1)
    expect(ix.nullifiers.get(field(65).toString("hex"))).toBe("e3")
    ix.ingestLogs({ signature: "bad", err: { InstructionError: [0, "Custom"] }, logs: [] }, 8)
    expect(outcomes).toEqual([["e1", "confirmed"], ["e3", "confirmed"], ["bad", "failed"]])
    ix.stop()
  })

  it("resumes from a snapshot: same tree, no replay, and spots a reset chain", async () => {
    const c = fakeChain()
    c.add("s1", 3, [1, 2, 41, 42])
    c.add("s2", 4, [3, 4, 43, 44])
    const a = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await a.sync()
    const snap = JSON.parse(JSON.stringify(a.snapshot()))

    c.add("s3", 5, [5, 6, 45, 46]) // lands while the backend is down
    let fetched = []
    const conn = { ...c.conn, getTransaction: async (sig) => (fetched.push(sig), c.conn.getTransaction(sig)) }
    const b = new FastIndexer({ conn, program: PROGRAM, wasm })
    expect(b.restore(snap)).toBe(true)
    expect(leafValues(b)).toEqual([1, 2, 3, 4])
    expect(b.pools.get("sol").proof(1)).toEqual(a.pools.get("sol").proof(1))
    await b.sync()
    expect(fetched).toEqual(["s3"]) // only what is new since the snapshot
    expect(leafValues(b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await b.matchesChain()).toBe(true)
    expect(b.nullifiers.get(field(41).toString("hex"))).toBe("s1")

    // a different chain under the same program id (reset validator)
    const other = fakeChain()
    other.add("x1", 3, [9, 9, 91, 92])
    other.add("x2", 4, [8, 8, 93, 94])
    const d = new FastIndexer({ conn: other.conn, program: PROGRAM, wasm })
    expect(d.restore(snap)).toBe(true)
    expect(await d.matchesChain()).toBe(false)

    expect(new FastIndexer({ conn: c.conn, program: Keypair.generate().publicKey, wasm }).restore(snap)).toBe(false)
  })

  it("decodes a raw transact and leaves swap (compressed) to its events", () => {
    const raw = transactData(1, 2, 31, 32)
    const a = decodeTransact(raw)
    expect(a.commitments.map((x) => parseInt(x.toString("hex"), 16))).toEqual([1, 2])
    expect(a.nullifiers.map((x) => parseInt(x.toString("hex"), 16))).toEqual([31, 32])
    expect(a.encrypted.map(String)).toEqual(["enc-1", "enc-2"])
    expect(decodeTransact(Buffer.concat([Buffer.from([7]), raw.subarray(1)]))).toBeNull()
  })

  it("catch-up prefers the logged event (swap included) over instruction bytes", () => {
    const tx = {
      meta: { err: null, logMessages: eventLogs(4, [5, 6, 55, 56]) },
      transaction: { message: { staticAccountKeys: [PROGRAM], compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [], data: Buffer.from([7, 1, 2, 3]) }] } },
    }
    const [t] = transactsOf(tx, PROGRAM)
    expect(t.index).toBe(4)
    expect(t.treeKey).toBe("sol")
    expect(parseInt(t.decoded.commitments[0].toString("hex"), 16)).toBe(5)
  })

  it("only trusts events logged inside the program's own frame", () => {
    const other = Keypair.generate().publicKey.toBase58()
    const forged = [`Program ${other} invoke [1]`, ...eventLogs(0, [9, 9, 9, 9]).slice(1, -1), `Program ${other} success`]
    expect(eventsFromLogs(forged, PROGRAM)).toEqual([])
    // our program CPI'd by another: still ours
    const nested = [`Program ${other} invoke [1]`, ...eventLogs(0, [1, 2, 3, 4]).map((l) => l.replace("[1]", "[2]")), `Program ${other} success`]
    expect(eventsFromLogs(nested, PROGRAM).map((e) => e.index)).toEqual([0])
    // malformed fields are skipped, not thrown
    const id = PROGRAM.toBase58()
    expect(eventsFromLogs([`Program ${id} invoke [1]`, "Program data: WfVX+t4eh44AAA==", `Program ${id} success`], PROGRAM)).toEqual([])
    // trailing bytes past the body: not ours
    const extra = eventLogs(0, [1, 2, 3, 4])
    extra[2] = `Program data: ${Buffer.concat([Buffer.from(extra[2].slice(14), "base64"), Buffer.from([0])]).toString("base64")}`
    expect(eventsFromLogs(extra, PROGRAM)).toEqual([])
  })

  it("applies both legs of a swap (one tx, events for two pools)", () => {
    const c = fakeChain()
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    ix.subId = 1
    const mint = Keypair.generate().publicKey
    const sol = eventLogs(0, [1, 2, 61, 62])
    const spl = eventLogs(0, [3, 4, 63, 64], mint)
    // one instruction, two `Program data:` events (swap.rs emits in-pool then out-pool)
    const logs = [...sol.slice(0, 3), spl[2], ...sol.slice(3)]
    ix.ingestLogs({ signature: "swap1", err: null, logs }, 5)
    expect(ix.pool("sol").leaves.map((l) => l.signature)).toEqual(["swap1", "swap1"])
    expect(ix.pool(mint.toBase58()).leaves.map((l) => l.signature)).toEqual(["swap1", "swap1"])
    // a re-delivery adds nothing to either pool
    ix.ingestLogs({ signature: "swap1", err: null, logs }, 5)
    expect(ix.pool("sol").leaves.length).toBe(2)
    expect(ix.pool(mint.toBase58()).leaves.length).toBe(2)
    ix.stop()
  })

  it("decodes SPL events with their mint as the tree key", () => {
    const mint = Keypair.generate().publicKey
    const [e] = eventsFromLogs(eventLogs(6, [1, 2, 3, 4], mint), PROGRAM)
    expect(e.treeKey).toBe(mint.toBase58())
    expect(e.index).toBe(6)
    expect(e.decoded.encrypted.map((b) => b.toString())).toEqual(["enc-1", "enc-2"])
  })
})

/** Logs of one transact as the program writes them (helper.rs emit_transact_event). */
function eventLogs(index, [c0, c1, n0, n1], mint = null) {
  const id = PROGRAM.toBase58()
  const head = Buffer.alloc(12)
  Buffer.from(mint ? "b894aefac583f888" : "59f557fade1e878e", "hex").copy(head)
  head.writeUInt32LE(index, 8)
  const vec = (b) => {
    const len = Buffer.alloc(4)
    len.writeUInt32LE(b.length)
    return Buffer.concat([len, b])
  }
  const body = Buffer.concat([head, ...(mint ? [mint.toBuffer()] : []), field(c0), field(c1), field(n0), field(n1), vec(Buffer.from(`enc-${c0}`)), vec(Buffer.from(`enc-${c1}`))])
  return [`Program ${id} invoke [1]`, "Program log: Instruction: Transact", `Program data: ${body.toString("base64")}`, `Program ${id} consumed 135000 of 200000 compute units`, `Program ${id} success`]
}
