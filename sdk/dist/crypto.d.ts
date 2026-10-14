import type { LightWasm } from "@lightprotocol/hasher.rs";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SIGN_MESSAGE } from "./constants";
/**
 * Field-element keypair used inside UTXO commitments/nullifiers.
 * Ported 1:1 from privacy-cash-sdk/src/models/keypair.ts (browser-safe).
 * privkey is an Fr scalar; pubkey = poseidon(privkey).
 */
export declare class Keypair {
    privkey: BN;
    pubkey: BN;
    private wasm;
    constructor(privkeyHex: string, wasm: LightWasm);
    /** poseidon(privkey, commitment, merklePath) */
    sign(commitment: string, merklePath: string): string;
}
/** First-31-bytes / 248-bit field encoding of an SPL mint; SOL mint passes through. */
export declare function getMintAddressField(mint: PublicKey | string): string;
/**
 * UTXO ported from privacy-cash-sdk/src/models/utxo.ts.
 * commitment = poseidon(amount, pubkey, blinding, mintField)
 * nullifier   = poseidon(commitment, index, sign(commitment, index))
 */
export declare class Utxo {
    amount: BN;
    blinding: BN;
    /** Owner pubkey hashed into the commitment. Always set. */
    pubkey: BN;
    /** Owner secret keypair; null on a pubkey-only output owned by someone else. */
    keypair: Keypair | null;
    index: number;
    mintAddress: string;
    private wasm;
    constructor(opts: {
        wasm: LightWasm;
        amount?: BN | number | string;
        /** Spending keypair; omit when building an output committed to a foreign pubkey. */
        keypair?: Keypair;
        /** Commitment pubkey for a keypair-less output (recipient's note pubkey). */
        pubkey?: BN | number | string;
        blinding?: BN | number | string;
        index?: number;
        mintAddress?: string;
    });
    getCommitment(): string;
    getNullifier(): Promise<string>;
}
export declare function randomInt(maxExclusive: number): number;
/**
 * ext_data_hash = SHA-256 over:
 *   recipient(32) | ext_amount.le(8) | enc1.len.le(4) | enc1
 *                  | enc2.len.le(4) | enc2 | fee.le(8) | fee_recipient(32) | mint(32)
 *
 * Built manually to be byte-identical to the SDK's borsh output and to the
 * Pinocchio program's `calculate_complete_ext_data_hash` (see backend validate.rs).
 */
export declare function getExtDataHash(ext: {
    recipient: PublicKey | string;
    extAmount: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN | number | string;
    feeRecipient: PublicKey | string;
    mintAddress: PublicKey | string;
}): Uint8Array;
/**
 * x25519 receive keypair for v3 recipient-encrypted notes, derived from the
 * wallet signature of RECEIVE_SIGN_MESSAGE. The scalar is sha256(sig); noble's
 * x25519 clamps it into the valid scalar range on every use (RFC 7748), so the
 * raw sha256 output is kept as the secret. Pure: same signature, same keys.
 */
export declare function deriveReceiveKeys(sig: Uint8Array): {
    x25519Secret: Uint8Array;
    x25519Public: Uint8Array;
};
/**
 * Encrypt a UTXO note to a recipient's x25519 public key (v3 format):
 *   [v3 prefix 8][ephemeral x25519 pub 32][iv 12][tag 16][ciphertext]
 * AES-256-GCM key = HKDF-SHA256 over the x25519 shared secret, over the exact
 * "amount|blinding|index|mintAddress" plaintext encryptUtxo builds. Anyone can
 * encrypt; only the holder of the recipient receive secret can open it.
 */
export declare function encryptUtxoTo(recipientXPub: Uint8Array, utxo: Utxo): Promise<Buffer>;
/**
 * Browser-native EncryptionService (Web Crypto AES-256-GCM).
 * v2 (own notes): [version(8)][iv(12)][authTag(16)][ciphertext], AES key =
 * keccak256(signature of SIGN_MESSAGE). UTXO private key is derived
 * deterministically from the same signature, so the same wallet always
 * recovers the same note set.
 * v3 (received notes): x25519 recipient encryption; the receive secret comes
 * from a SECOND wallet signature (RECEIVE_SIGN_MESSAGE) via deriveReceiveKeys.
 */
export declare class EncryptionService {
    private encKeyV2;
    private utxoPrivKeyV2;
    private cryptoKey;
    private receiveSecretV3;
    private receivePublicV3;
    /** The receive secret as a native WebCrypto X25519 key (null: no native support). */
    private receiveKeyV3;
    /**
     * Derive keys from an ed25519 signature of the constant SIGN_MESSAGE, plus
     * optionally the second signature of RECEIVE_SIGN_MESSAGE that enables v3
     * note decryption (encryptUtxoTo payloads). Re-derivation resets both.
     */
    deriveFromSignature(signature: Uint8Array, receiveSignature?: Uint8Array): void;
    /**
     * x25519(receive secret, ephPub). Every v3 leaf a scan meets costs one of
     * these, ours or not: native WebCrypto X25519 runs it ~35x faster than the
     * pure-JS curve (0.02 vs 0.75 ms), which is most of a wallet's catch-up scan.
     * Engines without it (older browsers) fall back to @noble — same result.
     */
    private receiveShared;
    /** x25519 public key others encrypt v3 notes to (null until receive keys are derived). */
    getReceivePublicKey(): Uint8Array | null;
    get utxoPrivateKey(): string;
    private key;
    encrypt(data: Uint8Array | string): Promise<Buffer>;
    decrypt(encrypted: Uint8Array): Promise<Buffer>;
    /** Encrypt a UTXO as "amount|blinding|index|mintAddress" (pipe-delimited). */
    encryptUtxo(utxo: Utxo): Promise<Buffer>;
    decryptUtxo(encrypted: Uint8Array, wasm: LightWasm): Promise<Utxo>;
    /** Open a v3 recipient-encrypted note with our x25519 receive secret. */
    private decryptV3;
}
export declare function randomBytes(n: number): Uint8Array;
export { SIGN_MESSAGE };
//# sourceMappingURL=crypto.d.ts.map