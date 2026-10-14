import type { LightWasm } from "@lightprotocol/hasher.rs"
import { x25519 } from "@noble/curves/ed25519"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 as sha256n } from "@noble/hashes/sha2"
import { PublicKey } from "@solana/web3.js"
import BN from "bn.js"
import { keccak256, sha256 } from "ethers"

import { FIELD_SIZE, SIGN_MESSAGE, WRAPPED_SOL_MINT } from "./constants"

/**
 * Field-element keypair used inside UTXO commitments/nullifiers.
 * Ported 1:1 from privacy-cash-sdk/src/models/keypair.ts (browser-safe).
 * privkey is an Fr scalar; pubkey = poseidon(privkey).
 */
export class Keypair {
  privkey: BN
  pubkey: BN
  private wasm: LightWasm

  constructor(privkeyHex: string, wasm: LightWasm) {
    this.privkey = new BN(
      (BigInt(privkeyHex) % BigInt(FIELD_SIZE.toString())).toString(),
    )
    this.wasm = wasm
    this.pubkey = new BN(this.wasm.poseidonHashString([this.privkey.toString()]))
  }

  /** poseidon(privkey, commitment, merklePath) */
  sign(commitment: string, merklePath: string): string {
    return this.wasm.poseidonHashString([
      this.privkey.toString(),
      commitment,
      merklePath,
    ])
  }
}

/** First-31-bytes / 248-bit field encoding of an SPL mint; SOL mint passes through. */
export function getMintAddressField(mint: PublicKey | string): string {
  const mintStr = mint instanceof PublicKey ? mint.toString() : mint
  if (mintStr === WRAPPED_SOL_MINT) return mintStr
  const bytes = (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBytes()
  return new BN(bytes.slice(0, 31), "be").toString()
}

/**
 * UTXO ported from privacy-cash-sdk/src/models/utxo.ts.
 * commitment = poseidon(amount, pubkey, blinding, mintField)
 * nullifier   = poseidon(commitment, index, sign(commitment, index))
 */
export class Utxo {
  amount: BN
  blinding: BN
  /** Owner pubkey hashed into the commitment. Always set. */
  pubkey: BN
  /** Owner secret keypair; null on a pubkey-only output owned by someone else. */
  keypair: Keypair | null
  index: number
  mintAddress: string
  private wasm: LightWasm

  constructor(opts: {
    wasm: LightWasm
    amount?: BN | number | string
    /** Spending keypair; omit when building an output committed to a foreign pubkey. */
    keypair?: Keypair
    /** Commitment pubkey for a keypair-less output (recipient's note pubkey). */
    pubkey?: BN | number | string
    blinding?: BN | number | string
    index?: number
    mintAddress?: string
  }) {
    if (!opts.keypair && opts.pubkey === undefined) {
      throw new Error("Utxo requires a keypair or a pubkey")
    }
    this.wasm = opts.wasm
    this.amount = new BN((opts.amount ?? 0).toString())
    this.blinding = new BN(
      (opts.blinding ?? randomInt(1_000_000_000)).toString(),
    )
    this.keypair = opts.keypair ?? null
    this.pubkey = opts.keypair
      ? opts.keypair.pubkey
      : new BN(opts.pubkey!.toString())
    this.index = opts.index ?? 0
    this.mintAddress = opts.mintAddress ?? WRAPPED_SOL_MINT
  }

  getCommitment(): string {
    return this.wasm.poseidonHashString([
      this.amount.toString(),
      this.pubkey.toString(),
      this.blinding.toString(),
      getMintAddressField(this.mintAddress),
    ])
  }

  async getNullifier(): Promise<string> {
    if (!this.keypair) {
      throw new Error(
        "Utxo has no keypair (pubkey-only output); it cannot sign or compute a nullifier",
      )
    }
    const commitment = this.getCommitment()
    const sig = this.keypair.sign(commitment, new BN(this.index).toString())
    return this.wasm.poseidonHashString([
      commitment,
      new BN(this.index).toString(),
      sig,
    ])
  }
}

export function randomInt(maxExclusive: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % maxExclusive
}

/**
 * ext_data_hash = SHA-256 over:
 *   recipient(32) | ext_amount.le(8) | enc1.len.le(4) | enc1
 *                  | enc2.len.le(4) | enc2 | fee.le(8) | fee_recipient(32) | mint(32)
 *
 * Built manually to be byte-identical to the SDK's borsh output and to the
 * Pinocchio program's `calculate_complete_ext_data_hash` (see backend validate.rs).
 */
export function getExtDataHash(ext: {
  recipient: PublicKey | string
  extAmount: BN | number | string
  encryptedOutput1: Uint8Array
  encryptedOutput2: Uint8Array
  fee: BN | number | string
  feeRecipient: PublicKey | string
  mintAddress: PublicKey | string
}): Uint8Array {
  const recipient = toPubkeyBytes(ext.recipient)
  const feeRecipient = toPubkeyBytes(ext.feeRecipient)
  const mint = toPubkeyBytes(ext.mintAddress)
  const extAmount = new BN(ext.extAmount.toString())
  const fee = new BN(ext.fee.toString())

  const data = Buffer.concat([
    recipient,
    new BN(extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
    toU32LE(ext.encryptedOutput1.length),
    Buffer.from(ext.encryptedOutput1),
    toU32LE(ext.encryptedOutput2.length),
    Buffer.from(ext.encryptedOutput2),
    fee.toArrayLike(Buffer, "le", 8),
    feeRecipient,
    mint,
  ])
  return Buffer.from(sha256(data).slice(2), "hex")
}

function toU32LE(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function toPubkeyBytes(v: PublicKey | string): Buffer {
  return Buffer.from(
    (v instanceof PublicKey ? v : new PublicKey(v)).toBytes(),
  )
}

const ENCRYPTION_VERSION_V2 = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
])

/** v3 recipient-encrypted notes: ASCII "PCSv3" zero-padded to 8 bytes. */
const ENCRYPTION_VERSION_V3 = Buffer.from("PCSv3\0\0\0", "ascii")

/** HKDF salt binding v3 note keys to this protocol version. */
const NOTE_KDF_SALT = Buffer.from("privacy-cash-note-v2", "utf8")

const V3_EPH_OFF = 8
const V3_IV_OFF = 40
const V3_TAG_OFF = 52
const V3_CT_OFF = 68

/** "amount|blinding|index|mintAddress" note plaintext shared by the v2 and v3 formats. */
function utxoPlaintext(utxo: Utxo): string {
  return `${utxo.amount.toString()}|${utxo.blinding.toString()}|${utxo.index}|${utxo.mintAddress}`
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false
  }
  return true
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bs(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  )
}

/** AES-256-GCM seal; returns the 12-byte iv, 16-byte tag and ciphertext apart. */
async function aesGcmSeal(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(12)
  const enc = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(plaintext)),
  )
  return {
    iv,
    ciphertext: enc.slice(0, enc.length - 16),
    tag: enc.slice(enc.length - 16),
  }
}

/** AES-256-GCM open over split ct||tag; rejects (throws) on any key/tag mismatch. */
async function aesGcmOpen(
  key: CryptoKey,
  iv: Uint8Array,
  tag: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const joined = new Uint8Array(ciphertext.length + 16)
  joined.set(ciphertext, 0)
  joined.set(tag, ciphertext.length)
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(joined)),
  )
}

/**
 * x25519 receive keypair for v3 recipient-encrypted notes, derived from the
 * wallet signature of RECEIVE_SIGN_MESSAGE. The scalar is sha256(sig); noble's
 * x25519 clamps it into the valid scalar range on every use (RFC 7748), so the
 * raw sha256 output is kept as the secret. Pure: same signature, same keys.
 */
export function deriveReceiveKeys(sig: Uint8Array): {
  x25519Secret: Uint8Array
  x25519Public: Uint8Array
} {
  const x25519Secret = sha256n(sig)
  return { x25519Secret, x25519Public: x25519.getPublicKey(x25519Secret) }
}

/** HKDF-SHA256(x25519 shared secret, salt, info = ephemeral pub) -> AES-256 key. */
function deriveNoteKey(
  shared: Uint8Array,
  ephemeralPub: Uint8Array,
): Uint8Array {
  return hkdf(sha256n, shared, NOTE_KDF_SALT, ephemeralPub, 32)
}

/**
 * Encrypt a UTXO note to a recipient's x25519 public key (v3 format):
 *   [v3 prefix 8][ephemeral x25519 pub 32][iv 12][tag 16][ciphertext]
 * AES-256-GCM key = HKDF-SHA256 over the x25519 shared secret, over the exact
 * "amount|blinding|index|mintAddress" plaintext encryptUtxo builds. Anyone can
 * encrypt; only the holder of the recipient receive secret can open it.
 */
export async function encryptUtxoTo(
  recipientXPub: Uint8Array,
  utxo: Utxo,
): Promise<Buffer> {
  const ephSecret = x25519.utils.randomSecretKey()
  const ephPub = x25519.getPublicKey(ephSecret)
  const shared = x25519.getSharedSecret(ephSecret, recipientXPub)
  const key = await importAesKey(deriveNoteKey(shared, ephPub))
  const { iv, tag, ciphertext } = await aesGcmSeal(
    key,
    Buffer.from(utxoPlaintext(utxo)),
  )
  return Buffer.concat([ENCRYPTION_VERSION_V3, ephPub, iv, tag, ciphertext])
}

/**
 * Browser-native EncryptionService (Web Crypto AES-256-GCM).
 * v2 (own notes): [version(8)][iv(12)][authTag(16)][ciphertext], AES key =
 * keccak256(signature of SIGN_MESSAGE). UTXO private key is derived
 * deterministically from the same signature, so the same wallet always
 * recovers the same note set.
 * v3 (received notes): x25519 recipient encryption; the receive secret comes
 * from a SECOND wallet signature (RECEIVE_SIGN_MESSAGE) via deriveReceiveKeys.
 */
export class EncryptionService {
  private encKeyV2: Uint8Array | null = null
  private utxoPrivKeyV2: string | null = null
  private cryptoKey: CryptoKey | null = null
  private receiveSecretV3: Uint8Array | null = null
  private receivePublicV3: Uint8Array | null = null
  /** The receive secret as a native WebCrypto X25519 key (null: no native support). */
  private receiveKeyV3: Promise<CryptoKey | null> | null = null

  /**
   * Derive keys from an ed25519 signature of the constant SIGN_MESSAGE, plus
   * optionally the second signature of RECEIVE_SIGN_MESSAGE that enables v3
   * note decryption (encryptUtxoTo payloads). Re-derivation resets both.
   */
  deriveFromSignature(signature: Uint8Array, receiveSignature?: Uint8Array): void {
    this.encKeyV2 = Buffer.from(keccak256(signature).slice(2), "hex")
    this.utxoPrivKeyV2 =
      "0x" + keccak256(this.encKeyV2).slice(2)
    this.cryptoKey = null
    const receive = receiveSignature
      ? deriveReceiveKeys(receiveSignature)
      : null
    this.receiveSecretV3 = receive ? receive.x25519Secret : null
    this.receivePublicV3 = receive ? receive.x25519Public : null
    this.receiveKeyV3 = null
  }

  /**
   * x25519(receive secret, ephPub). Every v3 leaf a scan meets costs one of
   * these, ours or not: native WebCrypto X25519 runs it ~35x faster than the
   * pure-JS curve (0.02 vs 0.75 ms), which is most of a wallet's catch-up scan.
   * Engines without it (older browsers) fall back to @noble — same result.
   */
  private async receiveShared(ephPub: Uint8Array): Promise<Uint8Array> {
    const secret = this.receiveSecretV3!
    try {
      if (!this.receiveKeyV3) {
        // base64url by hand: browser Buffer polyfills lack the encoding, and
        // a throw here made every self-addressed note undecryptable
        const b64u = (u: Uint8Array) =>
          btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
        this.receiveKeyV3 = crypto.subtle
          .importKey("jwk", { kty: "OKP", crv: "X25519", d: b64u(secret), x: b64u(this.receivePublicV3!) }, { name: "X25519" }, false, [
            "deriveBits",
          ])
          .catch(() => null)
      }
      const key = await this.receiveKeyV3
      if (key) {
        const eph = await crypto.subtle.importKey("raw", bs(ephPub), { name: "X25519" }, true, [])
        return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, key, 256))
      }
    } catch {
      /* no native X25519, or it rejected the point: the reference implementation decides */
    }
    return x25519.getSharedSecret(secret, ephPub)
  }

  /** x25519 public key others encrypt v3 notes to (null until receive keys are derived). */
  getReceivePublicKey(): Uint8Array | null {
    return this.receivePublicV3
  }

  get utxoPrivateKey(): string {
    if (!this.utxoPrivKeyV2) {
      throw new Error("EncryptionService not initialised - sign first")
    }
    return this.utxoPrivKeyV2
  }

  private async key(): Promise<CryptoKey> {
    if (!this.encKeyV2) {
      throw new Error("EncryptionService not initialised - sign first")
    }
    if (!this.cryptoKey) {
      this.cryptoKey = await importAesKey(this.encKeyV2)
    }
    return this.cryptoKey
  }

  async encrypt(data: Uint8Array | string): Promise<Buffer> {
    const key = await this.key()
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data)
    const { iv, tag, ciphertext } = await aesGcmSeal(key, buf)
    return Buffer.concat([ENCRYPTION_VERSION_V2, iv, tag, ciphertext])
  }

  async decrypt(encrypted: Uint8Array): Promise<Buffer> {
    const key = await this.key()
    const plain = await aesGcmOpen(
      key,
      encrypted.slice(8, 20),
      encrypted.slice(20, 36),
      encrypted.slice(36),
    )
    return Buffer.from(plain)
  }

  /** Encrypt a UTXO as "amount|blinding|index|mintAddress" (pipe-delimited). */
  async encryptUtxo(utxo: Utxo): Promise<Buffer> {
    return this.encrypt(utxoPlaintext(utxo))
  }

  async decryptUtxo(encrypted: Uint8Array, wasm: LightWasm): Promise<Utxo> {
    const plain = (
      hasPrefix(encrypted, ENCRYPTION_VERSION_V3)
        ? await this.decryptV3(encrypted)
        : await this.decrypt(encrypted)
    ).toString()
    const [amount, blinding, index, mintAddress] = plain.split("|")
    return new Utxo({
      wasm,
      amount,
      blinding,
      keypair: new Keypair(this.utxoPrivateKey, wasm),
      index: Number(index),
      mintAddress,
    })
  }

  /** Open a v3 recipient-encrypted note with our x25519 receive secret. */
  private async decryptV3(encrypted: Uint8Array): Promise<Buffer> {
    if (!this.receiveSecretV3) {
      throw new Error(
        "EncryptionService receive keys not derived - sign RECEIVE_SIGN_MESSAGE",
      )
    }
    if (encrypted.length < V3_CT_OFF) {
      throw new Error("truncated v3 encrypted note")
    }
    const ephPub = encrypted.slice(V3_EPH_OFF, V3_IV_OFF)
    const shared = await this.receiveShared(ephPub)
    const key = await importAesKey(deriveNoteKey(shared, ephPub))
    const plain = await aesGcmOpen(
      key,
      encrypted.slice(V3_IV_OFF, V3_TAG_OFF),
      encrypted.slice(V3_TAG_OFF, V3_CT_OFF),
      encrypted.slice(V3_CT_OFF),
    )
    return Buffer.from(plain)
  }
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Cast for Web Crypto BufferSource params (TS lib.dom ArrayBuffer/SharedArrayBuffer split). */
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource
}

export { SIGN_MESSAGE }
