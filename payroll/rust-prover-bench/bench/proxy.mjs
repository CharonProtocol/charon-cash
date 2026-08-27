// Local merkle replica + chain-truth proxy for the fast payroll worker.
// Serves the SDK's indexer endpoints from an in-memory tree built from the
// engine's own submitted transactions, confirmed on-chain in landing order.
// Everything else passes through to the real backend.

import http from "node:http"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import { AddressLookupTableAccount, PublicKey } from "@solana/web3.js"
import { ZERO_BYTES } from "./zeros.mjs"

const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:8787"
const RPC = process.env.RPC ?? "http://127.0.0.1:8899"
const PORT = Number(process.env.PORT ?? 8788)
const PROGRAM_ID = process.env.PROGRAM_ID ?? "721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr"
const HEIGHT = 26
const ROOT_HISTORY = 100

const wasm = await WasmFactory.getInstance()

function h2n(hex) {
  return BigInt("0x" + hex)
}
function n2h(dec) {
  let h = BigInt(dec).toString(16)
  if (h.length % 2) h = "0" + h
  return h.padStart(64, "0")
}
function nodeHash(leftHex, rightHex) {
  return n2h(wasm.poseidonHashString([h2n(leftHex).toString(), h2n(rightHex).toString()]))
}

// z1 must equal poseidon(z0, z0) — proves the table + hasher agree with Rust.
{
  const z0 = ZERO_BYTES[0], z1 = ZERO_BYTES[1]
  const check = nodeHash(z0, z0)
  if (check !== z1) {
    throw new Error(`zero table mismatch: poseidon(z0,z0)=${check} != z1=${z1}`)
  }
}

// ---------------- replica (port of workers/src/merkle.rs) ----------------
const replica = {
  levels: Array.from({ length: HEIGHT + 1 }, () => []),
  nextIndex: 0,
  rootIndex: 0,
  rootHistory: new Array(ROOT_HISTORY).fill("0".repeat(64)),
  leaves: [], // { index, commitment, encHex, sig, slot }
}
replica.rootHistory[0] = ZERO_BYTES[HEIGHT]

function appendLeaf(commitmentHex, encHex, sig, slot) {
  const zb = ZERO_BYTES
  let cur = commitmentHex
  let pos = replica.nextIndex
  for (let i = 0; i <= HEIGHT; i++) {
    replica.levels[i][pos] = cur
    if (i < HEIGHT) {
      const sibPos = pos ^ 1
      const sib = replica.levels[i][sibPos] ?? zb[i]
      cur = nodeHash(pos % 2 === 0 ? cur : sib, pos % 2 === 0 ? sib : cur)
      pos >>= 1
    }
  }
  replica.nextIndex += 1
  replica.rootIndex = (replica.rootIndex + 1) % ROOT_HISTORY
  replica.rootHistory[replica.rootIndex] = cur
  replica.leaves.push({ index: replica.nextIndex - 1, commitment: commitmentHex, encHex, sig, slot })
}

function merkleProof(leafIndex) {
  const zb = ZERO_BYTES
  const path = []
  const indices = []
  for (let i = 0; i < HEIGHT; i++) {
    const sib = (leafIndex >> i) ^ 1
    path.push(replica.levels[i][sib] ?? zb[i])
    indices.push((leafIndex >> i) & 1)
  }
  return {
    root: replica.rootHistory[replica.rootIndex],
    next_leaf_index: replica.nextIndex,
    path_elements: path.map(hexToByteArr),
    path_indices: indices,
  }
}
function hexToByteArr(hex) {
  const out = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

// ---------------- tx decode (port of workers/src/decode.rs) ----------------
// transact ix: disc | proofA 64 | proofB 128 | proofC 64 | root 32 | publicAmount 32
//            | extDataHash 32 | nullifier0 32 | nullifier1 32 | commitment0 32 | commitment1 32
//            | extAmount i64le | fee u64le | len u32le enc1 | len u32le enc2 | bump0 bump1
// batch3 (disc 7): same shape but THREE commitments + THREE length-prefixed encs.
function decodeTransactIx(data) {
  const disc = data[0]
  if (disc !== 2 && disc !== 3 && disc !== 7) return null
  const nOut = disc === 7 ? 3 : 2
  let o = 1
  const take32 = () => { const s = data.subarray(o, o + 32); o += 32; return s }
  o += 64 + 128 + 64 // proof
  const root = take32()
  take32() // publicAmount
  take32() // extDataHash
  const n0 = take32()
  const n1 = take32()
  const commitments = []
  for (let i = 0; i < nOut; i++) commitments.push(take32())
  o += 16 // extAmount + fee
  const readLenPrefixed = () => {
    const len = data.readUInt32LE(o); o += 4
    const s = data.subarray(o, o + len); o += len
    return s
  }
  const enc = []
  for (let i = 0; i < nOut; i++) enc.push(readLenPrefixed())
  return {
    root: bufHex(root),
    nullifiers: [bufHex(n0), bufHex(n1)],
    commitments: commitments.map(bufHex),
    enc: enc.map(bufHex),
  }
}
function bufHex(b) {
  return Buffer.from(b).toString("hex")
}

// Minimal signed-tx parser: legacy + versioned (v0, with ALT).
// Returns [{ programIdHex, data }]. Counts are shortvec compact-u16.
// ALT entries are resolved by fetching each referenced table over RPC (cached):
// full key list = static keys ++ writable loaded ++ readonly loaded.
const altCache = new Map() // tablePubkeyHex -> [addrHex]
async function loadAlt(tableHex) {
  if (altCache.has(tableHex)) return altCache.get(tableHex)
  const b58 = new PublicKey(Buffer.from(tableHex, "hex")).toBase58()
  const acc = await rpcCall("getAccountInfo", [b58, { encoding: "base64" }])
  const addrs = []
  if (acc?.value?.data) {
    const raw = Buffer.from(acc.value.data[0], "base64")
    const state = AddressLookupTableAccount.deserialize(raw)
    for (const a of state.addresses) addrs.push(bufHex(a.toBytes()))
  }
  altCache.set(tableHex, addrs)
  return addrs
}

async function parseTx(bytes) {
  const cur = {
    b: bytes,
    o: 0,
    u8() { return this.b[this.o++] },
    cu16() {
      const first = this.b[this.o++]
      if (first & 0x80) {
        const second = this.b[this.o++]
        return ((first & 0x7f) | (second << 7)) >>> 0
      }
      return first
    },
    bytes(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s },
  }
  const sigLen = cur.cu16()
  cur.bytes(sigLen * 64)
  const msg = cur
  let versionByte = 0
  if ((msg.b[msg.o] & 0x80) !== 0) {
    versionByte = msg.u8()
    msg.u8() // numRequiredSigs
    msg.u8() // numReadonlySigned
    msg.u8() // numReadonly
  } else {
    msg.u8() // numRequiredSigs
    msg.u8() // numReadonlySigned
    msg.u8() // numReadonly
  }
  const nKeys = msg.cu16()
  const allKeys = []
  for (let i = 0; i < nKeys; i++) {
    allKeys.push(bufHex(msg.bytes(32)))
  }
  if (versionByte & 0x04) {
    const nTables = msg.cu16()
    const loadedWritable = []
    const loadedReadonly = []
    for (let t = 0; t < nTables; t++) {
      const tableHex = bufHex(msg.bytes(32))
      const nW = msg.cu16()
      const writableIdx = []
      for (let i = 0; i < nW; i++) writableIdx.push(msg.u8())
      const nR = msg.cu16()
      const readonlyIdx = []
      for (let i = 0; i < nR; i++) readonlyIdx.push(msg.u8())
      const addrs = await loadAlt(tableHex)
      for (const idx of writableIdx) loadedWritable.push(addrs[idx])
      for (const idx of readonlyIdx) loadedReadonly.push(addrs[idx])
    }
    // runtime layout: static ++ writable ++ readonly
    allKeys.push(...loadedWritable, ...loadedReadonly)
  }
  msg.bytes(32) // blockhash
  const nIx = msg.cu16()
  const out = []
  for (let i = 0; i < nIx; i++) {
    const pidIdx = msg.u8()
    const nAcc = msg.cu16()
    msg.bytes(nAcc)
    const dataLen = msg.cu16()
    const data = msg.bytes(dataLen)
    out.push({ programIdHex: allKeys[pidIdx] ?? null, data: Buffer.from(data) })
  }
  return out
}

// ---------------- chain watcher ----------------
const pending = new Map() // sig -> { decode, submittedAt, confirmedAt, slot, processed }
const processedSigs = new Set()
const sigLeaf = new Map() // sig -> leaf index of the tx's first commitment
const spentNullifiers = new Set()
const encIndex = new Map() // encHex -> leafIndex
let watchTimer = null
let stats = { submitted: 0, confirmed: 0, processed: 0, failed: 0 }
const waiters = [] // resolve callbacks for replica updates

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(JSON.stringify(j.error))
  return j.result
}

function base58ToHex(pubkeyB58) {
  return Buffer.from(new PublicKey(pubkeyB58).toBytes()).toString("hex")
}

async function watchLoop() {
  try {
    const sigs = [...pending.keys()].filter(s => !pending.get(s).processed)
    if (sigs.length) {
      const st = await rpcCall("getSignatureStatuses", [sigs, { searchTransactionHistory: false }])
      for (let i = 0; i < sigs.length; i++) {
        const v = st.value[i]
        const p = pending.get(sigs[i])
        if (!v) continue
        if (v.err) {
          p.failed = true
          stats.failed++
          console.error("[watch] tx failed", sigs[i].slice(0, 16), JSON.stringify(v.err))
          pending.delete(sigs[i])
          continue
        }
        const status = v.confirmationStatus ?? (v.confirmations != null ? "processed" : null)
        if (status) {
          // "processed" counts: the landing-order pass below only picks up txs
          // that appear in getSignaturesForAddress (i.e. are in a slot), and
          // waiting for "confirmed" here added multi-second replica lag under
          // load — long enough for the SDK's 10s locateNoteLeaf to give up.
          if (!p.confirmedAt) {
            console.log(`[watch] ${new Date().toISOString()} status ${sigs[i].slice(0, 16)} ${status} slot=${v.slot} (+${Math.round((Date.now() - p.submittedAt) / 100) / 10}s)`)
          }
          p.confirmedAt = Date.now()
          p.slot = v.slot
        }
      }
    }
    const confirmedUnprocessed = [...pending.entries()].filter(([, p]) => p.confirmedAt && !p.processed)
    if (confirmedUnprocessed.length) {
      const limit = Math.min(1000, Math.max(32, sigs.length + 32))
      const list = await rpcCall("getSignaturesForAddress", [PROGRAM_ID, { limit }])
      // list is newest-first; walk until a processed sig (older ones already done)
      const batch = []
      for (const entry of list) {
        if (entry.err) continue
        const p = pending.get(entry.signature)
        if (p && p.confirmedAt && !p.processed) {
          batch.push({ sig: entry.signature, p, slot: entry.slot })
        } else if (processedSigs.has(entry.signature)) {
          break
        }
      }
      // list order = newest first; process oldest -> newest
      batch.reverse()
      for (const { sig, p, slot } of batch) {
        p.processed = true
        const d = p.decode
        sigLeaf.set(sig, replica.nextIndex)
        for (let i = 0; i < d.commitments.length; i++) {
          appendLeaf(d.commitments[i], d.enc[i], sig, slot)
          encIndex.set(d.enc[i], replica.nextIndex - 1)
        }
        for (const nf of d.nullifiers) spentNullifiers.add(nf)
        processedSigs.add(sig)
        pending.delete(sig)
        stats.processed++
        stats.confirmed++
      }
      if (batch.length) {
        console.log(`[watch] ${new Date().toISOString()} processed ${batch.length} txs -> nextIndex=${replica.nextIndex} (age ${batch.map(({ p }) => Math.round((Date.now() - p.submittedAt) / 100) / 10 + "s").join(",")})`)
        while (waiters.length) waiters.shift()()
      }
    }
  } catch (e) {
    console.error("[watch] error:", e.message)
  }
  watchTimer = setTimeout(watchLoop, 250)
}

// ---------------- http server ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { "content-type": "application/json" })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
  })
}
async function passThrough(req, res, url, bodyBuf) {
  const upstream = await fetch(BACKEND + url.pathname + (url.search ?? ""), {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "application/json" },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
  })
  const text = await upstream.text()
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
  res.end(text)
}
function waitForReplica(minLeafIndex, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    waiters.push(() => { clearTimeout(t); resolve() })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname
  try {
    // --- intercepted: submit ---
    if (req.method === "POST" && path === "/api/relayer/submit") {
      const body = JSON.parse((await readBody(req)).toString())
      const txBytes = Buffer.from(body.transaction.replace(/^0x/, ""), "hex")
      const upstream = await fetch(BACKEND + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const text = await upstream.text()
      let data
      try { data = JSON.parse(text) } catch { data = text }
      if (upstream.status === 200 && data?.signature) {
        try {
          const sig = data.signature
          let decoded = null
          for (const ix of await parseTx(txBytes)) {
            if (ix.programIdHex === base58ToHex(PROGRAM_ID)) {
              decoded = decodeTransactIx(ix.data)
              if (decoded) break
            }
          }
          if (!decoded) throw new Error("no transact ix found")
          // note: sig here is base58 of the first ed25519 signature over the tx;
          // submitTransaction returns exactly that, and it matches getSignaturesForAddress.
          pending.set(sig, { decode: decoded, submittedAt: Date.now() })
          stats.submitted++
          console.log(`[submit] ${new Date().toISOString()} tracked ${sig.slice(0, 16)} disc=${decoded.commitments.length === 3 ? 7 : 2}`)
        } catch (e) {
          console.error("[submit] decode failed:", e.message)
        }
      }
      res.writeHead(upstream.status, { "content-type": "application/json" })
      res.end(text)
      return
    }

    // --- intercepted: tree state ---
    const mState = path.match(/^\/api\/merkle\/([^/]+)$/)
    if (req.method === "GET" && mState) {
      const known = replica.rootHistory.filter(r => r !== "0".repeat(64))
      json(res, 200, {
        tree_key: decodeURIComponent(mState[1]),
        next_leaf_index: replica.nextIndex,
        current_root: replica.rootHistory[replica.rootIndex].toUpperCase(),
        known_roots: known.map(r => r.toUpperCase()),
        leaf_count: replica.nextIndex,
      })
      return
    }

    // --- intercepted: merkle proof (long-poll while the leaf is pending) ---
    const mProof = path.match(/^\/api\/merkle\/([^/]+)\/proof\/(\d+)$/)
    if (req.method === "GET" && mProof) {
      const leafIndex = Number(mProof[2])
      if (leafIndex >= replica.nextIndex) {
        await waitForReplica(leafIndex, 30_000)
      }
      if (leafIndex >= replica.nextIndex) {
        json(res, 404, { error: { message: "LEAF_NOT_FOUND" } })
        return
      }
      json(res, 200, merkleProof(leafIndex))
      return
    }

    // --- intercepted: utxo range ---
    if (req.method === "GET" && path === "/api/utxos/range") {
      const start = Number(url.searchParams.get("start") ?? 0)
      const end = Number(url.searchParams.get("end") ?? replica.nextIndex)
      const from = Math.max(0, start)
      const to = Math.min(replica.nextIndex, end)
      const slice = replica.leaves.slice(from, to)
      json(res, 200, {
        tree_key: url.searchParams.get("tree_key") ?? "sol",
        start: from,
        end: to,
        total: replica.nextIndex,
        next_index: replica.nextIndex,
        has_more: to < replica.nextIndex,
        utxos: slice.map(l => ({
          leaf_index: l.index,
          commitment: l.commitment,
          encrypted_output_hex: l.encHex,
          signature: l.sig,
          slot: l.slot ?? 0,
        })),
      })
      return
    }

    // --- intercepted: encrypted-output check ---
    const mCheck = path.match(/^\/api\/utxos\/check\/([0-9a-fA-F]+)$/)
    if (req.method === "GET" && mCheck) {
      const hex = mCheck[1].toLowerCase()
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !encIndex.has(hex)) {
        await waitForReplica(0, 1_000)
      }
      const idx = encIndex.get(hex)
      if (idx === undefined) { json(res, 200, { exists: false }); return }
      const leaf = replica.leaves[idx]
      json(res, 200, {
        exists: true,
        tree_key: "sol",
        leaf_index: idx,
        commitment: leaf.commitment,
        signature: leaf.sig,
        slot: leaf.slot ?? 0,
      })
      return
    }

    // --- intercepted: nullifier spent ---
    const mNf = path.match(/^\/api\/nullifier\/([0-9a-fA-F]+)$/)
    if (req.method === "GET" && mNf) {
      json(res, 200, { spent: spentNullifiers.has(mNf[1].toLowerCase()) })
      return
    }

    // --- local admin ---
    const mSig = path.match(/^\/local\/sig\/([A-Za-z0-9]+)$/)
    if (req.method === "GET" && mSig) {
      const leafStart = sigLeaf.get(mSig[1])
      json(res, 200, { processed: leafStart !== undefined, leafStart: leafStart ?? null })
      return
    }
    if (path === "/local/status") {
      json(res, 200, {
        stats,
        pending: [...pending.values()].map(p => ({ age: Date.now() - p.submittedAt, confirmed: !!p.confirmedAt })),
        nextIndex: replica.nextIndex,
        currentRoot: replica.rootHistory[replica.rootIndex],
      })
      return
    }
    if (path === "/local/verify") {
      // compare replica against the on-chain tree account
      const prog = new PublicKey(PROGRAM_ID)
      const [treePda] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], prog)
      const acc = await rpcCall("getAccountInfo", [treePda.toBase58(), { encoding: "base64" }])
      const info = { treePda: treePda.toBase58(), exists: !!(acc?.value?.data) }
      if (acc?.value?.data) {
        const raw = Buffer.from(acc.value.data[0], "base64")
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
        const nextIndex = dv.getUint32(8, true)
        const rootIndex = raw[12]
        const histOff = 16 + 26 * 32
        const history = []
        for (let i = 0; i < 100; i++) {
          history.push(raw.subarray(histOff + i * 32, histOff + i * 32 + 32).toString("hex"))
        }
        const chainCurrent = history[rootIndex]
        info.chainNextIndex = nextIndex
        info.chainRoot = chainCurrent
        info.replicaNextIndex = replica.nextIndex
        info.replicaRoot = replica.rootHistory[replica.rootIndex]
        info.nextIndexMatch = nextIndex === replica.nextIndex
        info.rootInHistory = history.includes(replica.rootHistory[replica.rootIndex])
      }
      json(res, 200, info)
      return
    }

    // --- everything else passes through ---
    const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req)
    await passThrough(req, res, url, body)
  } catch (e) {
    console.error("[http]", req.method, path, e.message)
    json(res, 500, { error: { message: e.message } })
  }
})

server.listen(PORT, () => {
  console.log(`proxy up on ${PORT} -> backend ${BACKEND}, rpc ${RPC}, program ${PROGRAM_ID}`)
  watchLoop()
})
