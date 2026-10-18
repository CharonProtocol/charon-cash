// Groth16 point compression in the program's format (swap, instruction 7,
// takes compressed proofs; transact 2/3 take raw ones). Matches the prover
// crate's encode.rs: arkworks compressed serialization, big-endian, so the
// sign flag sits in the top bit of byte 0. The program expands it with the
// alt_bn128 decompression syscall.

/** BN254 base field modulus. */
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n

const NEGATIVE = 0x80

function toBig(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

/** y is "negative" when it is the larger of y and -y (arkworks SWFlags). */
function isLarger(y: bigint): boolean {
  return y > (P - y) % P
}

/** Raw G1 (x‖y, 64 bytes BE) → compressed (32 bytes). */
export function compressG1(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error("G1 must be 64 bytes")
  const out = raw.slice(0, 32)
  if (isLarger(toBig(raw.subarray(32, 64)))) out[0] |= NEGATIVE
  return out
}

/** Raw G2 (x1‖x0‖y1‖y0, 128 bytes BE) → compressed (64 bytes). Fp2 order is c1 first, then c0. */
export function compressG2(raw: Uint8Array): Uint8Array {
  if (raw.length !== 128) throw new Error("G2 must be 128 bytes")
  const out = raw.slice(0, 64)
  const y1 = toBig(raw.subarray(64, 96))
  const y0 = toBig(raw.subarray(96, 128))
  const ny1 = (P - y1) % P
  const ny0 = (P - y0) % P
  if (y1 > ny1 || (y1 === ny1 && y0 > ny0)) out[0] |= NEGATIVE
  return out
}
