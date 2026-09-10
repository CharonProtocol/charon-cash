import { describe, it, expect } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"
import BN from "bn.js"

import {
  TOKEN_PROGRAM_ID,
  buildSwapInstruction,
  buildSwapTransaction,
  type ProofBytes,
} from "../src/program"
import { signWireTransaction, v1SignedSize, V1_MAX_SIZE } from "../src/tx-v1"

function dummyProof(seed: number): ProofBytes {
  const fill = (len: number, v: number) => Array.from({ length: len }, () => v)
  return {
    proofA: fill(32, seed),
    proofB: fill(64, seed + 1),
    proofC: fill(32, seed + 2),
    root: fill(32, seed + 3),
    publicAmount: fill(32, seed + 4),
    extDataHash: fill(32, seed + 5),
    inputNullifiers: [fill(32, seed + 6), fill(32, seed + 7)],
    outputCommitments: [fill(32, seed + 8), fill(32, seed + 9)],
  }
}

function dummyEnc(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i & 0xff)
}

describe("atomic v1 swap packet", () => {
  const programId = Keypair.generate().publicKey
  const signer = Keypair.generate()
  const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  const blockhash = Keypair.generate().publicKey.toBase58()

  it("typical SOL→USDC swap is >1232 and ≤4096 after signing", () => {
    const routeAccounts = Array.from({ length: 12 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isWritable: true,
    }))
    const { bytes } = buildSwapTransaction({
      programId,
      signer: signer.publicKey,
      proofIn: dummyProof(1),
      proofOut: dummyProof(2),
      extAmountIn: new BN(-1_000_000),
      extAmountOut: new BN(200_000),
      encryptedOutputIn1: dummyEnc(180),
      encryptedOutputIn2: dummyEnc(180),
      encryptedOutputOut1: dummyEnc(180),
      encryptedOutputOut2: dummyEnc(180),
      outMint: usdc,
      routeData: dummyEnc(200),
      routeAccounts,
      blockhash,
    })
    const signed = signWireTransaction(bytes, [signer.secretKey])
    expect(signed[0]).toBe(0x81)
    expect(signed.length).toBeGreaterThan(1232)
    expect(signed.length).toBeLessThanOrEqual(V1_MAX_SIZE)
    expect(v1SignedSize(bytes)).toBe(signed.length)
  })

  it("dedupes overlapping Jupiter remaining accounts", () => {
    const overlap = Keypair.generate().publicKey
    const { ix } = buildSwapInstruction({
      programId,
      signer: signer.publicKey,
      proofIn: dummyProof(5),
      proofOut: dummyProof(6),
      extAmountIn: new BN(-1_000_000),
      extAmountOut: new BN(200_000),
      encryptedOutputIn1: dummyEnc(40),
      encryptedOutputIn2: dummyEnc(40),
      encryptedOutputOut1: dummyEnc(40),
      encryptedOutputOut2: dummyEnc(40),
      outMint: usdc,
      routeData: dummyEnc(80),
      routeAccounts: [
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false },
        { pubkey: overlap, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false },
        { pubkey: overlap, isWritable: true },
      ],
    })
    const ids = ix.keys.map((k) => k.pubkey.toBase58())
    expect(ids.filter((id) => id === TOKEN_PROGRAM_ID.toBase58())).toHaveLength(1)
    expect(ids.filter((id) => id === overlap.toBase58())).toHaveLength(1)
    expect(ids.length).toBeLessThanOrEqual(64)
  })

  it("worst-case unique keys stay ≤64 and signed size ≤4096", () => {
    const routeAccounts = Array.from({ length: 28 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isWritable: false,
    }))
    const { ix, bytes } = buildSwapTransaction({
      programId,
      signer: signer.publicKey,
      proofIn: dummyProof(3),
      proofOut: dummyProof(4),
      extAmountIn: new BN(-5_000_000),
      extAmountOut: new BN(900_000),
      encryptedOutputIn1: dummyEnc(80),
      encryptedOutputIn2: dummyEnc(80),
      encryptedOutputOut1: dummyEnc(80),
      encryptedOutputOut2: dummyEnc(80),
      outMint: usdc,
      routeData: dummyEnc(120),
      routeAccounts,
      blockhash,
    })
    expect(ix.keys.length).toBeLessThanOrEqual(64)
    const signed = signWireTransaction(bytes, [signer.secretKey])
    expect(signed.length).toBeGreaterThan(1232)
    expect(signed.length).toBeLessThanOrEqual(V1_MAX_SIZE)
  })
})
