// Ground-truth lock for the snarkjs-decimals -> ark-compressed path in the
// SDK prover: parseProofToBytesArray must reproduce the exact compressed
// bytes arkworks serializes (vectors dumped by the Rust test
// programs/privacy-cash/tests/decompress_ark.rs::dump_compressed_vectors to
// /tmp/proof-vectors.json). The file only exists after that test runs, so
// the suite skips cleanly without it.
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { parseProofToBytesArray } from "privacy-cash-sdk"

const VECTORS_PATH = "/tmp/proof-vectors.json"

interface VectorFile {
  /** [uncompressed BE (x|y, 128 hex), ark compressed (64 hex)] */
  g1: [string, string][]
  /** [uncompressed BE (x1|x0|y1|y0, 256 hex), ark compressed (128 hex)] */
  g2: [string, string][]
}

function hexToBytes(hex: string): number[] {
  const out = new Array<number>(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const haveVectors = existsSync(VECTORS_PATH)
const vectors: VectorFile | null = haveVectors
  ? (JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorFile)
  : null

describe("snarkjs -> ark-compressed vectors", () => {
  it.skipIf(!vectors)("reproduces arkworks G1 compression", () => {
    for (const [uncompressed, compressed] of vectors!.g1) {
      const { proofA } = parseProofToBytesArray({
        pi_a: [`0x${uncompressed.slice(0, 64)}`, `0x${uncompressed.slice(64)}`],
        pi_b: [["0", "0"], ["0", "0"]],
        pi_c: ["0", "0"],
        protocol: "groth16",
        curve: "bn128",
      })
      expect(proofA).toEqual(hexToBytes(compressed))
    }
  })

  it.skipIf(!vectors)("reproduces arkworks G2 compression", () => {
    for (const [uncompressed, compressed] of vectors!.g2) {
      // uncompressed BE layout: x1 | x0 | y1 | y0 (each 64 hex)
      const pi_b = [
        [`0x${uncompressed.slice(64, 128)}`, `0x${uncompressed.slice(0, 64)}`],
        [`0x${uncompressed.slice(192)}`, `0x${uncompressed.slice(128, 192)}`],
      ]
      const { proofB } = parseProofToBytesArray({
        pi_a: ["0", "0"],
        pi_b: pi_b as [[string, string], [string, string]],
        pi_c: ["0", "0"],
        protocol: "groth16",
        curve: "bn128",
      })
      expect(proofB).toEqual(hexToBytes(compressed))
    }
  })

  it.skipIf(!vectors)("round-trips a full proof-shaped triple", () => {
    const [aUnc, aComp] = vectors!.g1[0]
    const [bUnc, bComp] = vectors!.g2[0]
    const [cUnc, cComp] = vectors!.g1[1]
    const parsed = parseProofToBytesArray({
      pi_a: [`0x${aUnc.slice(0, 64)}`, `0x${aUnc.slice(64)}`],
      pi_b: [
        [`0x${bUnc.slice(64, 128)}`, `0x${bUnc.slice(0, 64)}`],
        [`0x${bUnc.slice(192)}`, `0x${bUnc.slice(128, 192)}`],
      ],
      pi_c: [`0x${cUnc.slice(0, 64)}`, `0x${cUnc.slice(64)}`],
      protocol: "groth16",
      curve: "bn128",
    })
    expect(parsed.proofA).toEqual(hexToBytes(aComp))
    expect(parsed.proofB).toEqual(hexToBytes(bComp))
    expect(parsed.proofC).toEqual(hexToBytes(cComp))
  })
})
