import { describe, it, expect } from "bun:test"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import { WRAPPED_SOL_MINT } from "../src/constants"
import {
  EncryptionService,
  Keypair,
  Utxo,
  deriveReceiveKeys,
  encryptUtxoTo,
  getMintAddressField,
} from "../src/crypto"

const V2_PREFIX = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2])
const V3_PREFIX = Buffer.from("PCSv3\0\0\0", "ascii")

function service(sigByte: number, receiveByte?: number): EncryptionService {
  const enc = new EncryptionService()
  enc.deriveFromSignature(
    new Uint8Array(64).fill(sigByte),
    receiveByte === undefined
      ? undefined
      : new Uint8Array(64).fill(receiveByte),
  )
  return enc
}

const receivePubOf = (byte: number): Uint8Array =>
  deriveReceiveKeys(new Uint8Array(64).fill(byte)).x25519Public

describe("deriveReceiveKeys", () => {
  it("derives deterministic x25519 keys from the receive signature (pinned vector, tweetnacl-verified)", () => {
    const a = deriveReceiveKeys(new Uint8Array(64).fill(3))
    const b = deriveReceiveKeys(new Uint8Array(64).fill(3))
    expect(Buffer.from(a.x25519Secret).toString("hex")).toBe(
      "6aa56c4bcd208911792ad24c7681fefb93bed51903afc54860c9bd37e41e5a31",
    )
    expect(Buffer.from(a.x25519Public).toString("hex")).toBe(
      "f06ed9ec97b2cb6521d9122f69f59c2c7e8f52a138cb311849e263d63898355d",
    )
    expect(Buffer.from(b.x25519Public).equals(a.x25519Public)).toBe(true)
  })

  it("changes completely when the signature changes", () => {
    const a = deriveReceiveKeys(new Uint8Array(64).fill(3))
    const b = deriveReceiveKeys(new Uint8Array(64).fill(4))
    expect(Buffer.from(a.x25519Public).equals(b.x25519Public)).toBe(false)
  })
})

describe("v3 recipient-encrypted notes", () => {
  it("round-trips: recipient decrypts exactly what was encrypted to their x25519 key", async () => {
    const wasm = await WasmFactory.getInstance()
    const recipient = service(21, 22)
    const recipientNoteKp = new Keypair(recipient.utxoPrivateKey, wasm)

    const out = new Utxo({
      wasm,
      amount: "123456789",
      blinding: "987654321",
      index: 5,
      mintAddress: WRAPPED_SOL_MINT,
      pubkey: recipientNoteKp.pubkey,
    })
    const ct = await encryptUtxoTo(receivePubOf(22), out)
    expect(ct.subarray(0, 8).equals(V3_PREFIX)).toBe(true)
    expect(ct.length).toBeGreaterThanOrEqual(68)

    const back = await recipient.decryptUtxo(ct, wasm)
    expect(back.amount.toString()).toBe("123456789")
    expect(back.blinding.toString()).toBe("987654321")
    expect(back.index).toBe(5)
    expect(back.mintAddress).toBe(WRAPPED_SOL_MINT)
    expect(back.getCommitment()).toBe(out.getCommitment())
    expect(back.keypair!.pubkey.eq(recipientNoteKp.pubkey)).toBe(true)
  })

  it("a fully-unlocked sender cannot decrypt a v3 note paid to someone else", async () => {
    const wasm = await WasmFactory.getInstance()
    const recipient = service(21, 22)
    const sender = service(31, 32)
    const kp = new Keypair(recipient.utxoPrivateKey, wasm)
    const out = new Utxo({ wasm, amount: "42", pubkey: kp.pubkey, index: 0 })
    const ct = await encryptUtxoTo(receivePubOf(22), out)
    let threw = false
    try {
      await sender.decryptUtxo(ct, wasm)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it("v3 decrypt without receive keys throws a clear error", async () => {
    const wasm = await WasmFactory.getInstance()
    const holder = service(21)
    const kp = new Keypair(holder.utxoPrivateKey, wasm)
    const out = new Utxo({ wasm, amount: "7", pubkey: kp.pubkey })
    const ct = await encryptUtxoTo(receivePubOf(22), out)
    let err: unknown
    try {
      await holder.decryptUtxo(ct, wasm)
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toContain("RECEIVE_SIGN_MESSAGE")
  })

  it("v2 round-trip still passes and keeps the v2 prefix (regression)", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = service(9, 10)
    const kp = new Keypair(enc.utxoPrivateKey, wasm)
    const u = new Utxo({
      wasm,
      amount: "555",
      keypair: kp,
      index: 2,
      mintAddress: WRAPPED_SOL_MINT,
    })
    const ct = await enc.encryptUtxo(u)
    expect(ct.subarray(0, 8).equals(V2_PREFIX)).toBe(true)
    const back = await enc.decryptUtxo(ct, wasm)
    expect(back.amount.toString()).toBe("555")
    expect(back.getCommitment()).toBe(u.getCommitment())
  })

  it("wrong-key v2 decrypt still throws (syncNotes relies on that skip)", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = service(9, 10)
    const other = service(11, 12)
    const kp = new Keypair(enc.utxoPrivateKey, wasm)
    const ct = await enc.encryptUtxo(
      new Utxo({ wasm, amount: "1", keypair: kp }),
    )
    let threw = false
    try {
      await other.decryptUtxo(ct, wasm)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe("pubkey-only Utxo", () => {
  it("commits to exactly the given pubkey as the hasher specifies", async () => {
    const wasm = await WasmFactory.getInstance()
    const kp = new Keypair("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", wasm)
    const u = new Utxo({
      wasm,
      amount: "777",
      blinding: "654321",
      index: 9,
      pubkey: kp.pubkey,
      mintAddress: WRAPPED_SOL_MINT,
    })
    expect(u.keypair).toBeNull()
    const expected = wasm.poseidonHashString([
      "777",
      kp.pubkey.toString(),
      "654321",
      getMintAddressField(WRAPPED_SOL_MINT),
    ])
    expect(u.getCommitment()).toBe(expected)
  })

  it("throws on nullifier access and on construction without an owner", async () => {
    const wasm = await WasmFactory.getInstance()
    const kp = new Keypair("0x" + "ab".repeat(32), wasm)
    const u = new Utxo({ wasm, amount: "1", pubkey: kp.pubkey })
    let err: unknown
    try {
      await u.getNullifier()
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toContain("no keypair")

    let ctorErr: unknown
    try {
      new Utxo({ wasm, amount: "1" })
    } catch (e) {
      ctorErr = e
    }
    expect((ctorErr as Error).message).toContain("keypair or a pubkey")
  })

  it("keeps commitments identical between keypair-built and pubkey-built UTXOs", async () => {
    const wasm = await WasmFactory.getInstance()
    const enc = service(41, 42)
    const kp = new Keypair(enc.utxoPrivateKey, wasm)
    const a = new Utxo({ wasm, amount: "3", keypair: kp, blinding: "77", index: 1 })
    const b = new Utxo({ wasm, amount: "3", pubkey: kp.pubkey, blinding: "77", index: 1 })
    expect(a.getCommitment()).toBe(b.getCommitment())
  })
})
