import { groth16 } from "snarkjs"
import { utils } from "ffjavascript"

import { CIRCUIT } from "./constants"

export interface Proof {
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
  protocol: string
  curve: string
}

/** Compressed wire proof (arkworks BE hex, 32/64/32 bytes) as the wasm prover emits. */
export interface CompressedProofWire {
  proof_a: string
  proof_b: string
  proof_c: string
}

export type ProverProof = Proof | CompressedProofWire

let wasmBuf: Uint8Array | null = null
let zkeyBuf: Uint8Array | null = null

/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void {
  wasmBuf = wasm
  zkeyBuf = zkey
}

/**
 * Replacement prover for engine runners (server-side batch payroll): receives
 * the stringified circuit input and returns a proof in the same shape as
 * groth16.fullProve. The browser keeps the default snarkjs wasm prover; a
 * native prover (e.g. rapidsnark) is injected by the payroll engine only.
 */
export type ProverOverride = (input: Record<string, unknown>) => Promise<{
  proof: ProverProof
  publicSignals: string[]
}>

let proverOverride: ProverOverride | null = null

export function setProver(fn: ProverOverride | null): void {
  proverOverride = fn
}

async function loadCircuit(): Promise<{ wasm: Uint8Array; zkey: Uint8Array }> {
  if (!wasmBuf) wasmBuf = new Uint8Array(await (await fetch(CIRCUIT.WASM_URL)).arrayBuffer())
  if (!zkeyBuf) zkeyBuf = new Uint8Array(await (await fetch(CIRCUIT.ZKEY_URL)).arrayBuffer())
  return { wasm: wasmBuf, zkey: zkeyBuf }
}

/**
 * Generate a groth16 proof in-browser. wasm/zkey are fetched once as
 * ArrayBuffers and reused. Mirrors privacy-cash-sdk prove() (single-thread).
 */
export async function prove(input: Record<string, unknown>): Promise<{
  proof: ProverProof
  publicSignals: string[]
}> {
  const stringified = utils.stringifyBigInts(input) as Record<string, unknown>
  if (proverOverride) return proverOverride(stringified)
  const { wasm, zkey } = await loadCircuit()
  return groth16.fullProve(
    stringified,
    wasm,
    zkey,
    undefined,
    { singleThread: true },
    { singleThread: true },
  )
}

/** BN254 base field p — the sign flag compares y against p − y. */
const FQ = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n

function be32(v: bigint): number[] {
  const out = new Array<number>(32).fill(0)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** arkworks compressed G1: x BE, byte 0 sets 0x80 when y is the lex-larger root. */
function compressG1(x: bigint, y: bigint): number[] {
  const out = be32(x)
  if (y * 2n > FQ) out[0] |= 0x80
  return out
}

/**
 * arkworks compressed G2: [x.c1, x.c0] BE, flag in byte 0. Fq2 lex order
 * compares c1 first, c0 on tie — ark's YIsNegative rule.
 */
function compressG2(x0: bigint, x1: bigint, y0: bigint, y1: bigint): number[] {
  const out = [...be32(x1), ...be32(x0)]
  const n1 = (FQ - y1) % FQ
  const largest = y1 !== n1 ? y1 > n1 : y0 * 2n > FQ
  if (largest) out[0] |= 0x80
  return out
}

function hexToBytes(hex: string): number[] {
  const h = hex.replace(/^0x/i, "")
  if (h.length % 2 !== 0) throw new Error("odd hex length")
  const out = new Array<number>(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Parse a groth16 proof into the byte layout the Pinocchio Proof struct
 * expects — 32/64/32 compressed bytes on the wire. Accepts the snarkjs
 * decimal shape (compressed here with arkworks' SWFlags convention) or the
 * wasm prover's already-compressed hex, which passes through untouched.
 */
export function parseProofToBytesArray(proof: ProverProof): {
  proofA: number[]
  proofB: number[]
  proofC: number[]
} {
  if ("proof_a" in proof) {
    return {
      proofA: hexToBytes(proof.proof_a),
      proofB: hexToBytes(proof.proof_b),
      proofC: hexToBytes(proof.proof_c),
    }
  }
  const toBig = (v: unknown): bigint => BigInt(String(v))
  return {
    proofA: compressG1(toBig(proof.pi_a[0]), toBig(proof.pi_a[1])),
    proofB: compressG2(
      toBig(proof.pi_b[0][0]),
      toBig(proof.pi_b[0][1]),
      toBig(proof.pi_b[1][0]),
      toBig(proof.pi_b[1][1]),
    ),
    proofC: compressG1(toBig(proof.pi_c[0]), toBig(proof.pi_c[1])),
  }
}

/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals: string[]): number[][] {
  return JSON.parse(JSON.stringify(publicSignals)).map((s: string) =>
    Array.from(
      utils.leInt2Buff(utils.unstringifyBigInts(s), 32),
    ).reverse(),
  )
}
