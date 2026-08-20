import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PublicKey, AddressLookupTableAccount } from "@solana/web3.js"
import { ed25519 } from "@noble/curves/ed25519"
import { sha256 } from "@noble/hashes/sha2"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import {
  FIELD_SIZE,
  RECEIVE_SIGN_MESSAGE,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "../src/constants"
import { EncryptionService, Keypair, Utxo } from "../src/crypto"
import { PrivacyCashClient, type Signer } from "../src/client"
import {
  publishRecipientKeys,
  RECIPIENT_PUT_PREFIX,
} from "../src/recipients"
import { LocalMirror } from "../src/local-provider"
import { fieldToHex32, setBackendUrl } from "../src/merkle"
import { clearNotes, loadNotes, newNoteId, saveNote } from "../src/notes"
import { setCircuitBuffers } from "../src/prover"
import { splAltAddresses } from "../src/alt"

const BACKEND = "http://sdk-transfer-test.local"
const PROGRAM_ID = "9PpZ9iUSCk6fuv4MvFEkN64hd7kkh28GxGLgSUDRZA9V"
const FEE_RECIPIENT = PublicKey.unique()
const MINT = PublicKey.unique()
const FEE_BPS = 25
const ALT_ADDRESS = PublicKey.unique()
const V3_PREFIX_HEX = Buffer.from("PCSv3\0\0\0", "ascii").toString("hex")

const FIELD = BigInt(FIELD_SIZE.toString())

function fakeSigner(seed: string): Signer {
  const secret = sha256(new TextEncoder().encode(seed))
  return {
    publicKey: new PublicKey(ed25519.getPublicKey(secret)),
    signMessage: async (m: Uint8Array) => ed25519.sign(m, secret),
    signTransaction: async (tx) => tx,
  }
}

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

/** 56-byte ALT meta + 32-byte address records, as AddressLookupTableAccount.deserialize parses. */
function fakeAltHex(addresses: PublicKey[]): string {
  const buf = Buffer.alloc(56 + addresses.length * 32)
  buf.writeUInt32LE(1, 0) // typeIndex: lookup table
  buf.fill(0xff, 4, 12) // deactivationSlot: u64 max
  addresses.forEach((a, i) => Buffer.from(a.toBytes()).copy(buf, 56 + i * 32))
  return buf.toString("hex")
}

const ALT_HEX = fakeAltHex(
  splAltAddresses({
    programId: new PublicKey(PROGRAM_ID),
    feeRecipient: FEE_RECIPIENT,
    mint: MINT,
  }),
)

interface TreeEntry {
  mirror: LocalMirror
  next: number
}

const realFetch = globalThis.fetch
const trees = new Map<string, TreeEntry>()
const recipients = new Map<string, { note_pubkey: string; enc_pubkey: string }>()
const relayBodies: Array<Record<string, any>> = []
const putBodies: Array<Record<string, any>> = []
const treeKeysSeen = new Set<string>()
let sigCounter = 0

function seedTree(treeKey: string, leaves: string[]): void {
  trees.set(treeKey, {
    mirror: LocalMirror.fromLeaves(MIRROR_WASM!, leaves),
    next: leaves.length,
  })
}

let MIRROR_WASM: import("@lightprotocol/hasher.rs").LightWasm | null = null

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function installFetch(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const reqMethod =
      typeof input === "object" && input.method ? input.method : undefined
    const method = (init?.method ?? reqMethod ?? "GET").toUpperCase()
    const parts = url.pathname.split("/").filter(Boolean)
    const body = init?.body ? JSON.parse(init.body as string) : null

    if (method === "GET" && url.pathname === "/api/relayer/info") {
      return json({
        program_id: PROGRAM_ID,
        fee_recipient: FEE_RECIPIENT.toBase58(),
        withdrawal_fee_rate_bps: FEE_BPS,
        fee_error_margin_bps: 0,
        supported_mints: [{ mint: MINT.toBase58(), fee_ata: PublicKey.unique().toBase58() }],
      })
    }
    if (method === "GET" && url.pathname === "/api/relayer/blockhash") {
      return json({ blockhash: PublicKey.unique().toBase58(), slot: 1234 })
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "relayer" && parts[2] === "alt") {
      return json({ exists: true, data_hex: ALT_HEX })
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "merkle") {
      const treeKey = decodeURIComponent(parts[2])
      treeKeysSeen.add(treeKey)
      const entry = trees.get(treeKey)
      if (!entry) return json({ error: { message: `unknown tree ${treeKey}` } }, 404)
      if (parts.length === 3) {
        return json({
          next_leaf_index: entry.next,
          current_root: fieldToHex32(entry.mirror.root()),
          known_roots: [],
        })
      }
      if (parts[3] === "proof") {
        const idx = Number(parts[4])
        const pathIndices: number[] = []
        for (let i = 0; i < 26; i++) {
          pathIndices[i] = (idx >> i) & 1
        }
        return json({
          path_elements: entry.mirror.path(idx).map((d) => "0x" + fieldToHex32(d)),
          path_indices: pathIndices,
        })
      }
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "nullifier") {
      return json({ spent: false })
    }
    if (method === "GET" && url.pathname === "/api/utxos/range") {
      const start = Number(url.searchParams.get("start"))
      return json({
        tree_key: url.searchParams.get("tree_key"),
        start,
        end: Number(url.searchParams.get("end")),
        total: 0,
        nextIndex: start,
        hasMore: false,
        utxos: [],
      })
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "notes") {
      return json({ error: { message: "not found" } }, 404)
    }
    if (method === "PUT" && url.pathname === "/api/notes") {
      return json({ ok: true })
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "recipients") {
      const row = recipients.get(decodeURIComponent(parts[2]))
      if (!row) return json({ error: { message: "not found" } }, 404)
      return json(row)
    }
    if (method === "PUT" && url.pathname === "/api/recipients") {
      putBodies.push(body)
      recipients.set(body.wallet, {
        note_pubkey: body.note_pubkey,
        enc_pubkey: body.enc_pubkey,
      })
      return json({ ok: true })
    }
    if (method === "POST" && url.pathname === "/api/relayer") {
      relayBodies.push(body)
      for (const entry of trees.values()) entry.next += 2
      return json({ signature: `SIG${++sigCounter}`, status: "confirmed" })
    }
    if (method === "POST" && url.pathname === "/api/relayer/submit") {
      return json({ signature: `SIG${++sigCounter}`, status: "confirmed" })
    }
    return json({ error: { message: `no route ${method} ${url.pathname}` } }, 404)
  }) as any
}

/** Replicate unlock()'s derivation so the test can pre-seed notes for the sender. */
function deriveSenderKeys(signer: Signer, wasm: import("@lightprotocol/hasher.rs").LightWasm) {
  return signer
    .signMessage(new TextEncoder().encode(SIGN_MESSAGE))
    .then((sig) =>
      signer
        .signMessage(new TextEncoder().encode(RECEIVE_SIGN_MESSAGE))
        .then((receiveSig) => ({ sig, receiveSig })),
    )
    .then(({ sig, receiveSig }) => {
      const enc = new EncryptionService()
      enc.deriveFromSignature(sig, receiveSig)
      return { enc, utxoKeypair: new Keypair(enc.utxoPrivateKey, wasm) }
    })
}

describe("shielded transfers (transferNoteSOL/SPL)", () => {
  beforeAll(async () => {
    const dir = circuitDir()
    setCircuitBuffers(
      new Uint8Array(readFileSync(path.join(dir, "transaction2.wasm"))),
      new Uint8Array(readFileSync(path.join(dir, "transaction2.zkey"))),
    )
    MIRROR_WASM = await WasmFactory.getInstance()
    setBackendUrl(BACKEND)
    process.env.VITE_ALT_ADDRESS = ALT_ADDRESS.toBase58()
    installFetch()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    delete process.env.VITE_ALT_ADDRESS
  })

  it("fixture sanity: the mock ALT bytes deserialize to a lookup table", () => {
    const alt = AddressLookupTableAccount.deserialize(Buffer.from(ALT_HEX, "hex"))
    const have = new Set(alt.addresses.map((a) => a.toBase58()))
    expect(have.has(FEE_RECIPIENT.toBase58())).toBe(true)
    expect(have.has(MINT.toBase58())).toBe(true)
    expect(have.size).toBeGreaterThan(4)
  })

  it("publishRecipientKeys PUTs a wallet-verifiable key binding", async () => {
    const signer = fakeSigner("recipient-sol")
    const keys = await publishRecipientKeys(signer)

    expect(putBodies.length).toBe(1)
    const body = putBodies[0]
    expect(body.wallet).toBe(signer.publicKey.toBase58())
    expect(body.note_pubkey).toBe(keys.notePubkey)
    expect(body.enc_pubkey).toBe(keys.encPubkey)
    // canonical bn254 field element, 64-char hex enc key
    expect(BigInt(keys.notePubkey)).toBeGreaterThan(0n)
    expect(BigInt(keys.notePubkey)).toBeLessThan(FIELD)
    expect(keys.encPubkey).toMatch(/^[0-9a-f]{64}$/)
    // the signature the workers route verifies: same message, wallet key
    const msg = new TextEncoder().encode(
      `${RECIPIENT_PUT_PREFIX}\n${body.wallet}\n${body.note_pubkey}\n${body.enc_pubkey}`,
    )
    const sig = Buffer.from(body.signature, "base64")
    expect(sig.length).toBe(64)
    // noble 1.9 verify order: (signature, message, publicKey)
    expect(ed25519.verify(sig, msg, signer.publicKey.toBytes())).toBe(true)
    // tampered keys do not verify
    expect(
      ed25519.verify(
        sig,
        new TextEncoder().encode(
          `${RECIPIENT_PUT_PREFIX}\n${body.wallet}\n123\n${body.enc_pubkey}`,
        ),
        signer.publicKey.toBytes(),
      ),
    ).toBe(false)
  })

  it("rejects transfers to a wallet that has not enabled private receiving", async () => {
    const sender = fakeSigner("sender-unregistered")
    const client = new PrivacyCashClient(sender)
    await client.unlock()
    await expect(
      client.transferNoteSOL(PublicKey.unique(), 1_000_000),
    ).rejects.toThrow(/has not enabled private receiving/)
  })

  it("transferNoteSOL relays ext=0 with a v3-encrypted recipient note", async () => {
    const sender = fakeSigner("sender-sol")
    const recipient = fakeSigner("recipient-sol-transfer")
    const wasm = MIRROR_WASM!
    const client = new PrivacyCashClient(sender)
    await client.unlock()
    clearNotes(sender.publicKey)

    const { utxoKeypair } = await deriveSenderKeys(sender, wasm)
    const note = new Utxo({
      wasm,
      amount: "10000000000",
      blinding: "424242",
      keypair: utxoKeypair,
      index: 0,
      mintAddress: WRAPPED_SOL_MINT,
    })
    seedTree(SOL_TREE_KEY, [note.getCommitment()])
    saveNote(sender.publicKey, {
      id: newNoteId(),
      amount: "10000000000",
      blinding: "424242",
      index: 0,
      mintAddress: WRAPPED_SOL_MINT,
      spent: false,
      createdAt: 1,
    })

    await publishRecipientKeys(recipient)
    const relayCountBefore = relayBodies.length
    const net = 2_000_000_000
    const result = await client.transferNoteSOL(recipient.publicKey, net)

    // hand-checked math: fee = ceil(2e9 * 25 / 10000) = 5_000_000
    expect(result.feeLamports).toBe(5_000_000)
    expect(result.recipientLamports).toBe(net)
    expect(result.changeLamports).toBe("7995000000")
    expect(result.leafIndex).toBe(1)

    expect(relayBodies.length).toBe(relayCountBefore + 1)
    const body = relayBodies[relayBodies.length - 1]
    expect(body.kind).toBe("sol")
    expect(body.ext_amount).toBe(0)
    expect(body.fee).toBe(5_000_000)
    expect(body.recipient).toBe(FEE_RECIPIENT.toBase58())
    expect(body.recipient_owner).toBeUndefined()
    expect(body.mint).toBeUndefined()
    // output 0 is v3-encrypted to the recipient's x25519 key
    expect(body.encrypted_output1.startsWith("0x" + V3_PREFIX_HEX)).toBe(true)
    expect(body.encrypted_output2.startsWith("0x" + V3_PREFIX_HEX)).toBe(false)
    // the relayed commitment matches the returned one (result.commitment is bare hex)
    expect(body.output_commitments[0]).toBe("0x" + result.commitment)
    expect(body.output_commitments[0]).toHaveLength(66)

    // the recipient decrypts output 0 with their own receive key
    const rEnc = await deriveSenderKeys(recipient, wasm).then((r) => r.enc)
    const ct1 = Buffer.from(body.encrypted_output1.slice(2), "hex")
    const got = await rEnc.decryptUtxo(ct1, wasm)
    expect(got.amount.toString()).toBe(String(net))
    expect(got.index).toBe(1)
    expect(got.mintAddress).toBe(WRAPPED_SOL_MINT)

    // sender-side note bookkeeping: input spent, change saved at leaf 2
    const unspent = loadNotes(sender.publicKey).filter((n) => !n.spent)
    expect(unspent.map((n) => n.index)).toEqual([2])
    expect(unspent[0].amount).toBe("7995000000")
    expect(unspent[0].mintAddress).toBe(WRAPPED_SOL_MINT)
  }, 180_000)

  it("transferNoteSPL mirrors SOL on the mint's tree with spl relay fields", async () => {
    const sender = fakeSigner("sender-spl")
    const recipient = fakeSigner("recipient-spl")
    const wasm = MIRROR_WASM!
    const client = new PrivacyCashClient(sender)
    await client.unlock()
    clearNotes(sender.publicKey)

    const { utxoKeypair } = await deriveSenderKeys(sender, wasm)
    const note = new Utxo({
      wasm,
      amount: "3000000000",
      blinding: "777",
      keypair: utxoKeypair,
      index: 0,
      mintAddress: MINT.toBase58(),
    })
    seedTree(MINT.toBase58(), [note.getCommitment()])
    saveNote(sender.publicKey, {
      id: newNoteId(),
      amount: "3000000000",
      blinding: "777",
      index: 0,
      mintAddress: MINT.toBase58(),
      spent: false,
      createdAt: 1,
    })

    await publishRecipientKeys(recipient)
    const relayCountBefore = relayBodies.length
    const net = 1_000_000_000
    const result = await client.transferNoteSPL(MINT, recipient.publicKey, net)

    // fee = ceil(1e9 * 25 / 10000) = 2_500_000; change = 3e9 - 1.0025e9
    expect(result.feeLamports).toBe(2_500_000)
    expect(result.recipientLamports).toBe(net)
    expect(result.changeLamports).toBe("1997500000")
    expect(result.leafIndex).toBe(1)
    // the SPL tree (keyed by mint b58) was consulted
    expect(treeKeysSeen.has(MINT.toBase58())).toBe(true)

    const body = relayBodies[relayBodies.length - 1]
    expect(body.kind).toBe("spl")
    expect(body.ext_amount).toBe(0)
    expect(body.fee).toBe(2_500_000)
    expect(body.mint).toBe(MINT.toBase58())
    expect(body.recipient).toBe(FEE_RECIPIENT.toBase58())
    expect(body.recipient_owner).toBe(FEE_RECIPIENT.toBase58())
    expect(body.alt_address).toBe(ALT_ADDRESS.toBase58())
    expect(body.encrypted_output1.startsWith("0x" + V3_PREFIX_HEX)).toBe(true)
    expect(body.output_commitments[0]).toBe("0x" + result.commitment)

    const rEnc = await deriveSenderKeys(recipient, wasm).then((r) => r.enc)
    const ct1 = Buffer.from(body.encrypted_output1.slice(2), "hex")
    const got = await rEnc.decryptUtxo(ct1, wasm)
    expect(got.amount.toString()).toBe(String(net))
    expect(got.mintAddress).toBe(MINT.toBase58())

    const unspent = loadNotes(sender.publicKey).filter((n) => !n.spent)
    expect(unspent.map((n) => n.index)).toEqual([2])
    expect(unspent[0].amount).toBe("1997500000")
    expect(unspent[0].mintAddress).toBe(MINT.toBase58())
  }, 180_000)
})
