// Solana v1 (SIMD-0385) transaction builder + parser.
// Layout pinned from solana-message 4.6.0 src/versions/v1/message.rs and verified
// two ways: byte-identical to @solana/kit 8.2's encoder (v1-smoke-kit.mjs) and
// landed+finalized on surfpool 1.5.0 with feature enable_tx_v1
// (txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4).
//
// Wire: [0x81][header 3][configMask u32le][blockhash 32][numInstructions u8]
//       [numAddresses u8][addresses N x 32][config values in mask order]
//       [per ix: programIdIndex u8, numAccounts u8, dataLen u16le, indices, data]
//       [signatures: header.numRequiredSigs x 64, appended AFTER the message]
// Signing payload = the full 0x81-prefixed message (message.serialize()).
// Address order: writable-signers, readonly-signers, writable, readonly.
// Config mask: bits 0-1 priority fee u64le (both bits required), bit 2 CU limit
// u32le, bit 3 loaded-accounts-data-size u32le, bit 4 heap size u32le.
// Limits: 64 addresses, 64 ixs, 4096 bytes total. No ALTs, no ComputeBudget ixs
// (CU config replaces them; leftover ComputeBudget ixs would burn 150 CU each).

import nacl from "tweetnacl"
import { PublicKey } from "@solana/web3.js"

const MASK_PRIORITY_FEE = 0b11
const MASK_CU_LIMIT = 0b100
const MASK_LOADED_DATA_SIZE = 0b1000
const MASK_HEAP_SIZE = 0b10000
const V1_SIZE_LIMIT = 4096

function b58(b) {
  return new PublicKey(b).toBase58()
}

// plain base58 (for signatures — not a pubkey, PublicKey would reject 64 bytes)
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function base58Encode(bytes) {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let s = ""
  for (const d of digits) s = B58_ALPHABET[d] + s
  for (const byte of bytes) {
    if (byte === 0) s = "1" + s
    else break
  }
  return s
}

// role bits (kit convention): writable = 1, signer = 2
export const RO = 0
export const W = 1
const RS = 2
const WS = 3

/**
 * Build a signed v1 transaction.
 * instructions: [{ programId, accounts: [{ address, role }], data: Uint8Array }]
 *   (base58 addresses; duplicate addresses across ixs are deduped with
 *   max-privilege merge, like the runtime does)
 * opts: { cuLimit, loadedDataSize, priorityFeeLamports, heapSize }
 * Returns { bytes, messageBytes, size, signature (base58) }.
 */
export function buildV1Tx(feePayer, blockhash, instructions, opts = {}) {
  // max privileges per address across all instructions
  const roles = new Map()
  const bump = (addr, role) => roles.set(addr, Math.max(roles.get(addr) ?? RO, role))
  for (const ix of instructions) {
    bump(b58(ix.programId), RO)
    for (const a of ix.accounts) bump(b58(a.address), a.role)
  }
  const payerB58 = b58(feePayer.publicKey)
  roles.set(payerB58, WS) // fee payer is always a writable signer

  // address order = class order; stable sort keeps first-use order within a class
  const entries = [...roles.entries()].sort((a, b) => b[1] - a[1])
  const addrList = entries.map(([a]) => a)
  const idx = new Map(addrList.map((a, i) => [a, i]))
  if (addrList.length > 64) throw new Error(`v1: too many addresses (${addrList.length} > 64)`)
  const numRequiredSigs = entries.filter(([, r]) => r >= RS).length
  const numReadonlySigned = entries.filter(([, r]) => r === RS).length
  const numReadonlyUnsigned = entries.filter(([, r]) => r === RO).length

  const mask =
    (opts.priorityFeeLamports !== undefined ? MASK_PRIORITY_FEE : 0) |
    (opts.cuLimit !== undefined ? MASK_CU_LIMIT : 0) |
    (opts.loadedDataSize !== undefined ? MASK_LOADED_DATA_SIZE : 0) |
    (opts.heapSize !== undefined ? MASK_HEAP_SIZE : 0)

  const parts = []
  parts.push(new Uint8Array([0x81]))
  parts.push(new Uint8Array([numRequiredSigs, numReadonlySigned, numReadonlyUnsigned]))
  parts.push(new Uint8Array(new Uint32Array([mask]).buffer))
  parts.push(new PublicKey(blockhash).toBytes())
  if (instructions.length > 64) throw new Error(`v1: too many ixs (${instructions.length} > 64)`)
  parts.push(new Uint8Array([instructions.length]))
  parts.push(new Uint8Array([addrList.length]))
  for (const a of addrList) parts.push(new PublicKey(a).toBytes())
  if (opts.priorityFeeLamports !== undefined)
    parts.push(new Uint8Array(new BigUint64Array([BigInt(opts.priorityFeeLamports)]).buffer))
  if (opts.cuLimit !== undefined) parts.push(new Uint8Array(new Uint32Array([opts.cuLimit]).buffer))
  if (opts.loadedDataSize !== undefined)
    parts.push(new Uint8Array(new Uint32Array([opts.loadedDataSize]).buffer))
  if (opts.heapSize !== undefined) parts.push(new Uint8Array(new Uint32Array([opts.heapSize]).buffer))

  // wire order: ALL instruction headers in one block, then payloads per ix
  for (const ix of instructions) {
    const accounts = ix.accounts ?? []
    const data = ix.data ?? new Uint8Array(0)
    parts.push(new Uint8Array([idx.get(b58(ix.programId)), accounts.length]))
    parts.push(new Uint8Array(new Uint16Array([data.length]).buffer))
  }
  for (const ix of instructions) {
    const accounts = ix.accounts ?? []
    const data = ix.data ?? new Uint8Array(0)
    parts.push(new Uint8Array(accounts.map(a => idx.get(b58(a.address)))))
    parts.push(data)
  }

  const message = concat(parts)
  const sig = nacl.sign.detached(message, feePayer.secretKey)
  const bytes = concat([message, sig])
  if (bytes.length > V1_SIZE_LIMIT) throw new Error(`v1: tx too large (${bytes.length} > ${V1_SIZE_LIMIT})`)
  return { bytes, messageBytes: message, size: bytes.length, signature: base58Encode(sig) }
}

/** Parse a v1 wire tx into instructions (addresses base58, data Uint8Array). */
export function parseV1Tx(bytes) {
  if (bytes[0] !== 0x81) throw new Error("not a v1 transaction")
  let o = 1
  const header = [bytes[o++], bytes[o++], bytes[o++]]
  const mask = bytes.readUInt32LE(o); o += 4
  o += 32 // blockhash
  const nIx = bytes[o++]
  const nAddr = bytes[o++]
  const addrs = []
  for (let i = 0; i < nAddr; i++) { addrs.push(b58(bytes.subarray(o, o + 32))); o += 32 }
  const config = {}
  if ((mask & MASK_PRIORITY_FEE) === MASK_PRIORITY_FEE) {
    config.priorityFeeLamports = bytes.readBigUInt64LE(o); o += 8
  }
  if (mask & MASK_CU_LIMIT) { config.cuLimit = bytes.readUInt32LE(o); o += 4 }
  if (mask & MASK_LOADED_DATA_SIZE) { config.loadedDataSize = bytes.readUInt32LE(o); o += 4 }
  if (mask & MASK_HEAP_SIZE) { config.heapSize = bytes.readUInt32LE(o); o += 4 }
  // all headers first, then payloads per ix
  const headers = []
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = bytes[o++]
    const nAcc = bytes[o++]
    const dataLen = bytes.readUInt16LE(o); o += 2
    headers.push({ programIdIndex, nAcc, dataLen })
  }
  const ixs = []
  for (const h of headers) {
    const accounts = []
    for (let j = 0; j < h.nAcc; j++) {
      const address = addrs[bytes[o++]]
      const cls = entriesClass(header, nAddr, addrs.indexOf(address))
      accounts.push({ address, role: cls })
    }
    const data = bytes.slice(o, o + h.dataLen); o += h.dataLen
    ixs.push({ programId: addrs[h.programIdIndex], accounts, data })
  }
  return { header, config, instructions: ixs }
}

function entriesClass(header, nAddr, addrIndex) {
  const ws = header[0] - header[1] // writable signers come first
  const rs = header[0]
  const w = nAddr - header[2]
  if (addrIndex < ws) return WS
  if (addrIndex < rs) return RS
  if (addrIndex < w) return W
  return RO
}

function concat(arrs) {
  let n = 0
  for (const a of arrs) n += a.length
  const out = new Uint8Array(n)
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}
