import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import { FIELD_SIZE, MERKLE_TREE_DEPTH, WRAPPED_SOL_MINT } from "../src/constants"
import {
  EncryptionService,
  Keypair,
  Utxo,
  getExtDataHash,
} from "../src/crypto"
import { prove, parseProofToBytesArray, parseToBytesArray, setCircuitBuffers } from "../src/prover"
import { LocalMirror } from "../src/local-provider"

const FIELD = BigInt(FIELD_SIZE.toString())

function be(b: ArrayLike<number>): bigint {
  let r = 0n
  for (let i = 0; i < b.length; i++) r = (r << 8n) + BigInt((b as number[])[i])
  return r
}
function le(b: ArrayLike<number>): bigint {
  let r = 0n
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) + BigInt((b as number[])[i])
  return r
}
const mod = (x: bigint) => ((x % FIELD) + FIELD) % FIELD

function circuitDir(): string {
  if (process.env.CIRCUIT_DIR) return process.env.CIRCUIT_DIR
  const here = fileURLToPath(new URL(".", import.meta.url))
  const candidates = [
    path.join(here, "..", "..", "privacy-cash-sdk", "circuit2"),
    path.join(here, "..", "..", "frontend", "public", "circuit"),
    path.join(process.cwd(), "privacy-cash-sdk", "circuit2"),
    path.join(process.cwd(), "..", "privacy-cash-sdk", "circuit2"),
    path.join(process.cwd(), "frontend", "public", "circuit"),
  ]
  for (const c of candidates) {
    if (existsSync(path.join(c, "transaction2.wasm"))) return c
  }
  return candidates[0]
}

describe("client-sdk crypto + proof", () => {
  beforeAll(() => {
    const dir = circuitDir()
    const wasm = new Uint8Array(readFileSync(path.join(dir, "transaction2.wasm")))
    const zkey = new Uint8Array(readFileSync(path.join(dir, "transaction2.zkey")))
    setCircuitBuffers(wasm, zkey)
  })

  it("encrypts and decrypts a UTXO round-trip (Web Crypto AES-GCM)", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = new EncryptionService()
    // fake signature -> deterministic keys
    enc.deriveFromSignature(new Uint8Array(64).fill(7))
    const kp = new Keypair(enc.utxoPrivateKey, wasm)
    const u = new Utxo({ wasm, amount: "123456789", keypair: kp, index: 3, mintAddress: WRAPPED_SOL_MINT })
    const ct = await enc.encryptUtxo(u)
    const back = await enc.decryptUtxo(ct as unknown as Uint8Array, wasm)
    expect(back.amount.toString()).toBe("123456789")
    expect(back.index).toBe(3)
    expect(back.getCommitment()).toBe(u.getCommitment())
  })

  it("generates a valid deposit proof whose public signals satisfy the on-chain checks", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = new EncryptionService()
    enc.deriveFromSignature(new Uint8Array(64).fill(9))
    const kp = new Keypair(enc.utxoPrivateKey, wasm)

    const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")
    const inputs = [
      new Utxo({ wasm, keypair: kp }),
      new Utxo({ wasm, keypair: kp }),
    ]
    const depositAmount = 10_000_000
    const outputs = [
      new Utxo({ wasm, amount: String(depositAmount), keypair: kp, index: 0, mintAddress: WRAPPED_SOL_MINT }),
      new Utxo({ wasm, amount: "0", keypair: kp, index: 1, mintAddress: WRAPPED_SOL_MINT }),
    ]

    const extAmount = BigInt(depositAmount)
    const fee = 0n
    const ct1 = await enc.encryptUtxo(outputs[0])
    const ct2 = await enc.encryptUtxo(outputs[1])

    const extDataHash = getExtDataHash({
      recipient: "11111111111111111111111111111111",
      extAmount: depositAmount,
      encryptedOutput1: ct1 as unknown as Uint8Array,
      encryptedOutput2: ct2 as unknown as Uint8Array,
      fee: Number(fee),
      feeRecipient: "11111111111111111111111111111111",
      mintAddress: WRAPPED_SOL_MINT,
    })

    const publicAmount = mod(extAmount - fee)
    const circuitInput = {
      root: "0",
      inputNullifier: await Promise.all(inputs.map((x) => x.getNullifier())),
      outputCommitment: outputs.map((x) => x.getCommitment()),
      publicAmount: publicAmount.toString(),
      extDataHash,
      inAmount: inputs.map((x) => x.amount.toString(10)),
      inPrivateKey: inputs.map((x) => x.keypair.privkey),
      inBlinding: inputs.map((x) => x.blinding.toString(10)),
      inPathIndices: [0, 0],
      inPathElements: [dummyPath, dummyPath],
      outAmount: outputs.map((x) => x.amount.toString(10)),
      outBlinding: outputs.map((x) => x.blinding.toString(10)),
      outPubkey: outputs.map((x) => x.keypair.pubkey),
      mintAddress: WRAPPED_SOL_MINT,
    }

    const { proof, publicSignals } = await prove(circuitInput as unknown as Record<string, unknown>)
    expect(publicSignals.length).toBe(7)

    const parsed = parseProofToBytesArray(proof)
    expect(parsed.proofA.length).toBe(64)
    expect(parsed.proofB.length).toBe(128)
    expect(parsed.proofC.length).toBe(64)

    const pub = parseToBytesArray(publicSignals)
    // root, publicAmount, extDataHash, nullifier0, nullifier1, commitment0, commitment1
    expect(pub[0].length).toBe(32)
    expect(pub[2].length).toBe(32)

    // Program check: Fr::from_le_bytes_mod_order(sha256) == Fr::from_be_bytes_mod_order(ext_data_hash)
    const left = mod(le(extDataHash))
    const right = mod(be(pub[2]))
    expect(left).toBe(right)

    // public_amount (deposit, fee=0): ext_amount - fee == public_amount (mod field)
    expect(mod(be(pub[1]))).toBe(mod(extAmount - fee))
  }, 120_000)

  it("generates a valid WITHDRAW proof (negative ext_amount, real Merkle path)", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = new EncryptionService()
    enc.deriveFromSignature(new Uint8Array(64).fill(13))
    const kp = new Keypair(enc.utxoPrivateKey, wasm)

    const gross = 10_000_000n
    const fee = 2500n
    const recipientGets = gross - fee
    const extAmount = -recipientGets // negative => withdrawal

    // a previously-deposited note (being spent) + a dummy second input
    const note = new Utxo({ wasm, amount: gross.toString(), keypair: kp, index: 0, mintAddress: WRAPPED_SOL_MINT })
    const dummyIn = new Utxo({ wasm, keypair: kp })
    const mirror = LocalMirror.fromLeaves(wasm, [note.getCommitment(), dummyIn.getCommitment()])
    const root = mirror.root()
    const notePath = mirror.path(mirror.indexOf(note.getCommitment()))

    const outputs = [
      new Utxo({ wasm, amount: "0", keypair: kp, index: 2, mintAddress: WRAPPED_SOL_MINT }),
      new Utxo({ wasm, amount: "0", keypair: kp, index: 3, mintAddress: WRAPPED_SOL_MINT }),
    ]
    const ct1 = await enc.encryptUtxo(outputs[0])
    const ct2 = await enc.encryptUtxo(outputs[1])
    const extDataHash = getExtDataHash({
      recipient: "11111111111111111111111111111111",
      extAmount: Number(extAmount),
      encryptedOutput1: ct1 as unknown as Uint8Array,
      encryptedOutput2: ct2 as unknown as Uint8Array,
      fee: Number(fee),
      feeRecipient: "11111111111111111111111111111111",
      mintAddress: WRAPPED_SOL_MINT,
    })

    const { proof, publicSignals } = await prove({
      root,
      inputNullifier: await Promise.all([note.getNullifier(), dummyIn.getNullifier()]),
      outputCommitment: outputs.map((x) => x.getCommitment()),
      publicAmount: mod(extAmount - fee).toString(),
      extDataHash,
      inAmount: [note.amount.toString(10), dummyIn.amount.toString(10)],
      inPrivateKey: [note.keypair.privkey, dummyIn.keypair.privkey],
      inBlinding: [note.blinding.toString(10), dummyIn.blinding.toString(10)],
      inPathIndices: [note.index, dummyIn.index],
      inPathElements: [notePath, new Array(MERKLE_TREE_DEPTH).fill("0")],
      outAmount: outputs.map((x) => x.amount.toString(10)),
      outBlinding: outputs.map((x) => x.blinding.toString(10)),
      outPubkey: outputs.map((x) => x.keypair.pubkey),
      mintAddress: WRAPPED_SOL_MINT,
    } as unknown as Record<string, unknown>)

    const pub = parseToBytesArray(publicSignals)
    parseProofToBytesArray(proof) // shape sanity

    // ext_data_hash consistency: Fr_le(sha256) == Fr_be(proof.ext_data_hash)
    expect(mod(le(extDataHash))).toBe(mod(be(pub[2])))
    // withdraw public_amount: -(abs(ext_amount) + fee) == -gross (mod field)
    expect(mod(be(pub[1]))).toBe(mod(-gross))
    // the circuit's root public output must equal the mirror root we fed in
    expect(mod(be(pub[0]))).toBe(mod(BigInt(root)))
  }, 120_000)
})
