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
  proof: Proof
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
  proof: Proof
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

/** Parse a groth16 proof into the byte layout the Pinocchio Proof struct expects. */
export function parseProofToBytesArray(proof: Proof): {
  proofA: number[]
  proofB: number[]
  proofC: number[]
} {
  const d = JSON.parse(JSON.stringify(proof))
  for (const i in d) {
    if (i === "pi_a" || i === "pi_c") {
      for (const j in d[i]) {
        d[i][j] = Array.from(
          utils.leInt2Buff(utils.unstringifyBigInts(d[i][j]), 32),
        ).reverse()
      }
    } else if (i === "pi_b") {
      for (const j in d[i]) {
        for (const z in d[i][j]) {
          d[i][j][z] = Array.from(
            utils.leInt2Buff(utils.unstringifyBigInts(d[i][j][z]), 32),
          )
        }
      }
    }
  }
  return {
    proofA: [d.pi_a[0], d.pi_a[1]].flat(),
    proofB: [d.pi_b[0].flat().reverse(), d.pi_b[1].flat().reverse()].flat(),
    proofC: [d.pi_c[0], d.pi_c[1]].flat(),
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
