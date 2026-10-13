import { describe, expect, it } from "bun:test"
import { Keypair } from "@solana/web3.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import { LocalMirror } from "privacy-cash-sdk"

import { FastIndexer, dec2hex } from "./fast-indexer.mjs"
import { toTxLike } from "./grpc-source.mjs"

const wasm = await WasmFactory.getInstance()
const PROGRAM = Keypair.generate().publicKey

const field = (n) => {
  const b = Buffer.alloc(32)
  b.writeUInt32BE(n, 28)
  return b
}

/** transact ix data: disc 2, proof/public inputs, ExtDataMinified, 2 len-prefixed outputs */
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
})
