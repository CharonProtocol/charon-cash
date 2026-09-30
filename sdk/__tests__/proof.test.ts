import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import { FIELD_SIZE, MERKLE_TREE_DEPTH, WRAPPED_SOL_MINT } from "../src/constants"
import {
  EncryptionService,
  Keypair,
  Utxo,
  encodePrivacyAddress,
  parsePrivacyAddress,
  getExtDataHash,
} from "../src/crypto"
import { verifyArtifact } from "../src/circuit-artifacts"
import { configureProver, preloadProver, prove, parseToBytesArray } from "../src/prover"
import { LocalMirror } from "../src/local-provider"

const CIRCUITS = new URL("../../programs/privacy-cash/artifacts/circuits/", import.meta.url)
const PROVER_WASM = new URL("../prover-wasm/privacy_cash_prover_bg.wasm", import.meta.url)

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

describe("client-sdk crypto + proof", () => {
  beforeAll(async () => {
    // Same wasm prover the browser Worker runs, on this thread, fed from the repo artifacts.
    configureProver({
      inThread: true,
      wasm: readFileSync(PROVER_WASM),
      loadArtifacts: async () => {
        const zkey = new Uint8Array(readFileSync(new URL("transaction2.zkey", CIRCUITS)))
        const graph = new Uint8Array(readFileSync(new URL("transaction2.graph", CIRCUITS)))
        await verifyArtifact("zkey", zkey)
        await verifyArtifact("graph", graph)
        return { zkey, graph }
      },
    })
    const started = performance.now()
    await preloadProver()
    console.log(`wasm prover load ${Math.round(performance.now() - started)} ms`)
  }, 120_000)

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

  it("encrypts a note to another user's viewing key (X25519)", async () => {
    const wasm = await WasmFactory.getInstance()
    const sender = new EncryptionService()
    sender.deriveFromSignature(new Uint8Array(64).fill(1))
    const rec = new EncryptionService()
    rec.deriveFromSignature(new Uint8Array(64).fill(2))
    const recKp = new Keypair(rec.utxoPrivateKey, wasm)
    const view = await rec.viewingPublicKey()
    const addr = encodePrivacyAddress(recKp.pubkey, view)
    const parsed = parsePrivacyAddress(addr)
    expect(parsed.spendPubkey.toString()).toBe(recKp.pubkey.toString())

    const note = new Utxo({
      wasm,
      amount: "42",
      keypair: Keypair.fromPubkey(recKp.pubkey, wasm),
      blinding: "99",
      index: 7,
      mintAddress: WRAPPED_SOL_MINT,
    })
    const own = new Utxo({
      wasm,
      amount: "42",
      keypair: recKp,
      blinding: "99",
      index: 7,
      mintAddress: WRAPPED_SOL_MINT,
    })
    expect(note.getCommitment()).toBe(own.getCommitment())

    const ct = await sender.encryptUtxo(note, view)
    expect(ct[7]).toBe(1)
    const back = await rec.decryptUtxo(ct as unknown as Uint8Array, wasm)
    expect(back.amount.toString()).toBe("42")
    expect(back.index).toBe(7)
    expect(back.getCommitment()).toBe(note.getCommitment())

    const viewHex = Buffer.from(view).toString("hex")
    expect(viewHex).toHaveLength(64)
    const viaHex = Uint8Array.from(Buffer.from(viewHex, "hex"))
    const ctHex = await sender.encryptUtxo(note, viaHex)
    const backHex = await rec.decryptUtxo(ctHex as unknown as Uint8Array, wasm)
    expect(backHex.amount.toString()).toBe("42")
    expect(backHex.getCommitment()).toBe(note.getCommitment())
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

    const started = performance.now()
    const { publicSignals, proofA, proofB, proofC } = await prove(
      circuitInput as unknown as Record<string, unknown>,
    )
    console.log(`wasm deposit prove ${Math.round(performance.now() - started)} ms`)
    expect(publicSignals.length).toBe(7)
    expect(proofA.length).toBe(32)
    expect(proofB.length).toBe(64)
    expect(proofC.length).toBe(32)

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

    const { publicSignals, proofA, proofB, proofC } = await prove({
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

    expect(proofA.length).toBe(32)
    expect(proofB.length).toBe(64)
    expect(proofC.length).toBe(32)

    const pub = parseToBytesArray(publicSignals)
    // ext_data_hash consistency: Fr_le(sha256) == Fr_be(proof.ext_data_hash)
    expect(mod(le(extDataHash))).toBe(mod(be(pub[2])))
    // withdraw public_amount: -(abs(ext_amount) + fee) == -gross (mod field)
    expect(mod(be(pub[1]))).toBe(mod(-gross))
    // the circuit's root public output must equal the mirror root we fed in
    expect(mod(be(pub[0]))).toBe(mod(BigInt(root)))
  }, 120_000)
})
