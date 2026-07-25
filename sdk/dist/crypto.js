import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { keccak256, sha256 } from "ethers";
import { FIELD_SIZE, SIGN_MESSAGE, WRAPPED_SOL_MINT } from "./constants";
/**
 * Field-element keypair used inside UTXO commitments/nullifiers.
 * Ported 1:1 from privacy-cash-sdk/src/models/keypair.ts (browser-safe).
 * privkey is an Fr scalar; pubkey = poseidon(privkey).
 */
export class Keypair {
    privkey;
    pubkey;
    wasm;
    constructor(privkeyHex, wasm) {
        this.privkey = new BN((BigInt(privkeyHex) % BigInt(FIELD_SIZE.toString())).toString());
        this.wasm = wasm;
        this.pubkey = new BN(this.wasm.poseidonHashString([this.privkey.toString()]));
    }
    /** poseidon(privkey, commitment, merklePath) */
    sign(commitment, merklePath) {
        return this.wasm.poseidonHashString([
            this.privkey.toString(),
            commitment,
            merklePath,
        ]);
    }
}
/** First-31-bytes / 248-bit field encoding of an SPL mint; SOL mint passes through. */
export function getMintAddressField(mint) {
    const mintStr = mint instanceof PublicKey ? mint.toString() : mint;
    if (mintStr === WRAPPED_SOL_MINT)
        return mintStr;
    const bytes = (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBytes();
    return new BN(bytes.slice(0, 31), "be").toString();
}
/**
 * UTXO ported from privacy-cash-sdk/src/models/utxo.ts.
 * commitment = poseidon(amount, pubkey, blinding, mintField)
 * nullifier   = poseidon(commitment, index, sign(commitment, index))
 */
export class Utxo {
    amount;
    blinding;
    keypair;
    index;
    mintAddress;
    wasm;
    constructor(opts) {
        this.wasm = opts.wasm;
        this.amount = new BN((opts.amount ?? 0).toString());
        this.blinding = new BN((opts.blinding ?? randomInt(1_000_000_000)).toString());
        this.keypair = opts.keypair;
        this.index = opts.index ?? 0;
        this.mintAddress = opts.mintAddress ?? WRAPPED_SOL_MINT;
    }
    getCommitment() {
        return this.wasm.poseidonHashString([
            this.amount.toString(),
            this.keypair.pubkey.toString(),
            this.blinding.toString(),
            getMintAddressField(this.mintAddress),
        ]);
    }
    async getNullifier() {
        const commitment = this.getCommitment();
        const sig = this.keypair.sign(commitment, new BN(this.index).toString());
        return this.wasm.poseidonHashString([
            commitment,
            new BN(this.index).toString(),
            sig,
        ]);
    }
}
export function randomInt(maxExclusive) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % maxExclusive;
}
/**
 * ext_data_hash = SHA-256 over:
 *   recipient(32) | ext_amount.le(8) | enc1.len.le(4) | enc1
 *                  | enc2.len.le(4) | enc2 | fee.le(8) | fee_recipient(32) | mint(32)
 *
 * Built manually to be byte-identical to the SDK's borsh output and to the
 * Pinocchio program's `calculate_complete_ext_data_hash` (see backend validate.rs).
 */
export function getExtDataHash(ext) {
    const recipient = toPubkeyBytes(ext.recipient);
    const feeRecipient = toPubkeyBytes(ext.feeRecipient);
    const mint = toPubkeyBytes(ext.mintAddress);
    const extAmount = new BN(ext.extAmount.toString());
    const fee = new BN(ext.fee.toString());
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
    ]);
    return Buffer.from(sha256(data).slice(2), "hex");
}
function toU32LE(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}
function toPubkeyBytes(v) {
    return Buffer.from((v instanceof PublicKey ? v : new PublicKey(v)).toBytes());
}
const ENCRYPTION_VERSION_V2 = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
]);
/**
 * Browser-native EncryptionService (Web Crypto AES-256-GCM).
 * Mirrors privacy-cash-sdk's V2 format:
 *   [version(8)] [iv(12)] [authTag(16)] [ciphertext]
 * UTXO private key is derived deterministically from a wallet signature, so the
 * same wallet always recovers the same note set.
 */
export class EncryptionService {
    encKeyV2 = null;
    utxoPrivKeyV2 = null;
    cryptoKey = null;
    /** Derive keys from an ed25519 signature of the constant SIGN_MESSAGE. */
    deriveFromSignature(signature) {
        this.encKeyV2 = Buffer.from(keccak256(signature).slice(2), "hex");
        this.utxoPrivKeyV2 =
            "0x" + keccak256(this.encKeyV2).slice(2);
        this.cryptoKey = null;
    }
    get utxoPrivateKey() {
        if (!this.utxoPrivKeyV2) {
            throw new Error("EncryptionService not initialised — sign first");
        }
        return this.utxoPrivKeyV2;
    }
    async key() {
        if (!this.encKeyV2) {
            throw new Error("EncryptionService not initialised — sign first");
        }
        if (!this.cryptoKey) {
            this.cryptoKey = await crypto.subtle.importKey("raw", bs(this.encKeyV2), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        }
        return this.cryptoKey;
    }
    async encrypt(data) {
        const key = await this.key();
        const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
        const iv = randomBytes(12);
        const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(buf)));
        const ciphertext = enc.slice(0, enc.length - 16);
        const tag = enc.slice(enc.length - 16);
        return Buffer.concat([ENCRYPTION_VERSION_V2, iv, tag, ciphertext]);
    }
    async decrypt(encrypted) {
        const key = await this.key();
        const iv = encrypted.slice(8, 20);
        const tag = encrypted.slice(20, 36);
        const ciphertext = encrypted.slice(36);
        const joined = new Uint8Array(ciphertext.length + 16);
        joined.set(ciphertext, 0);
        joined.set(tag, ciphertext.length);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(joined));
        return Buffer.from(plain);
    }
    /** Encrypt a UTXO as "amount|blinding|index|mintAddress" (pipe-delimited). */
    async encryptUtxo(utxo) {
        return this.encrypt(`${utxo.amount.toString()}|${utxo.blinding.toString()}|${utxo.index}|${utxo.mintAddress}`);
    }
    async decryptUtxo(encrypted, wasm) {
        const plain = (await this.decrypt(encrypted)).toString();
        const [amount, blinding, index, mintAddress] = plain.split("|");
        return new Utxo({
            wasm,
            amount,
            blinding,
            keypair: new Keypair(this.utxoPrivateKey, wasm),
            index: Number(index),
            mintAddress,
        });
    }
}
export function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}
/** Cast for Web Crypto BufferSource params (TS lib.dom ArrayBuffer/SharedArrayBuffer split). */
function bs(u) {
    return u;
}
export { SIGN_MESSAGE };
