import { describe, expect, it } from "bun:test"
import { Keypair } from "@solana/web3.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import { LocalMirror } from "privacy-cash-sdk"

import { FastIndexer, dec2hex } from "./fast-indexer.mjs"

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

function fakeChain() {
  const sigs = [] // oldest first: {signature, slot, err}
  const txs = new Map()
  const blocks = new Map()
  const hidden = new Set()
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
    onLogs() {
      return 1
    },
    async removeOnLogsListener() {},
  }
  const add = (signature, slot, data, err = null) => {
    sigs.push({ signature, slot, err })
    blocks.set(slot, [...(blocks.get(slot) ?? []), signature])
    txs.set(signature, {
      meta: { err },
      transaction: {
        message: {
          staticAccountKeys: [PROGRAM],
          compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [], data }],
        },
      },
    })
  }
  return { conn, add, sigs, blocks, hidden }
}

const fold = (leafDec, index, path) => {
  let h = leafDec
  for (let lv = 0; lv < path.length; lv++) {
    const sib = BigInt(path[lv]).toString()
    h = (index >> lv) & 1 ? wasm.poseidonHashString([sib, h]) : wasm.poseidonHashString([h, sib])
  }
  return dec2hex(h)
}

describe("FastIndexer", () => {
  it("orders same-slot txs by block execution order, not signature list order", async () => {
    const c = fakeChain()
    c.add("A", 5, transactData(1, 2, 101, 102))
    c.add("B", 5, transactData(3, 4, 103, 104))
    c.blocks.set(5, ["B", "A"]) // B executed first in the block
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    const leaves = ix.pools.get("sol").leaves.map((l) => parseInt(l.commitment, 16))
    expect(leaves).toEqual([3, 4, 1, 2])
  })

  it("failed txs mint no leaves and spend no nullifiers", async () => {
    const c = fakeChain()
    c.add("ok1", 1, transactData(1, 2, 11, 12))
    c.add("bad", 2, transactData(9, 9, 13, 14), { InstructionError: [1, { Custom: 5 }] })
    c.add("ok2", 3, transactData(3, 4, 15, 16))
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(ix.pools.get("sol").leaves.length).toBe(4)
    expect(ix.nullifiers.has(field(13).toString("hex"))).toBe(false)
    expect(ix.nullifiers.get(field(15).toString("hex"))).toBe("ok2")
    expect(ix.pools.get("sol").roots.length).toBe(3) // empty root + one per landed tx
  })

  it("serves paths that fold to the root it reports", async () => {
    const c = fakeChain()
    for (let i = 0; i < 5; i++) c.add(`s${i}`, 10 + i, transactData(2 * i + 1, 2 * i + 2, 200 + 2 * i, 201 + 2 * i))
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

  it("stops at a landed-but-unfetchable tx and resumes without skipping it", async () => {
    const c = fakeChain()
    c.add("t1", 1, transactData(1, 2, 31, 32))
    c.add("t2", 2, transactData(3, 4, 33, 34))
    c.add("t3", 3, transactData(5, 6, 35, 36))
    c.hidden.add("t2")
    const ix = new FastIndexer({ conn: c.conn, program: PROGRAM, wasm })
    await ix.sync()
    expect(ix.pools.get("sol").leaves.length).toBe(2)
    c.hidden.delete("t2")
    await ix.sync()
    const leaves = ix.pools.get("sol").leaves.map((l) => parseInt(l.commitment, 16))
    expect(leaves).toEqual([1, 2, 3, 4, 5, 6])
    expect(ix.pools.get("sol").byCommitment.get(field(4).toString("hex"))).toBe(3)
  })
})
