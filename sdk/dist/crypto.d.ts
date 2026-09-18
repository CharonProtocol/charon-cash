import type { LightWasm } from "@lightprotocol/hasher.rs";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
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
    /** Output-only keypair (recipient note). Cannot spend. */
    static fromPubkey(pubkey: BN | string, wasm: LightWasm): Keypair;
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
    keypair: Keypair;
    index: number;
    mintAddress: string;
    private wasm;
    constructor(opts: {
        wasm: LightWasm;
        amount?: BN | number | string;
        keypair: Keypair;
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
export declare const SWAP_IN_DOMAIN: Buffer<ArrayBuffer>;
export declare const SWAP_OUT_DOMAIN: Buffer<ArrayBuffer>;
export declare function getSwapInExtDataHash(args: {
    extAmountIn: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    inMint: PublicKey | string;
    outMint: PublicKey | string;
    minAmountOut: BN | number | string;
    outCommitments: [Uint8Array, Uint8Array] | Uint8Array[];
}): Uint8Array;
export declare function getSwapOutExtDataHash(args: {
    extAmountOut: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    outMint: PublicKey | string;
}): Uint8Array;
/**
 * Browser-native EncryptionService (Web Crypto AES-256-GCM).
 * Mirrors privacy-cash-sdk's V2 format:
 *   [version(8)] [iv(12)] [authTag(16)] [ciphertext]
 * UTXO private key is derived deterministically from a wallet signature, so the
 * same wallet always recovers the same note set.
 */
export declare class EncryptionService {
    private encKeyV2;
    private utxoPrivKeyV2;
    private cryptoKey;
    private signature;
    private asym;
    /** Derive AES + UTXO spend keys from a SIWS (`signIn`) signature. */
    deriveFromSignature(signature: Uint8Array): void;
    get utxoPrivateKey(): string;
    private key;
    encrypt(data: Uint8Array | string): Promise<Buffer>;
    decrypt(encrypted: Uint8Array): Promise<Buffer>;
    /** Encrypt a UTXO as "amount|blinding|index|mintAddress" (pipe-delimited).
     *  Own notes use AES-GCM (V2). Notes for another user use X25519 (V1). */
    encryptUtxo(utxo: Utxo, recipientViewingKey?: Uint8Array): Promise<Buffer>;
    decryptUtxo(encrypted: Uint8Array, wasm: LightWasm): Promise<Utxo>;
    viewingPublicKey(): Promise<Uint8Array>;
    private asymEnc;
}
export declare const PRIVACY_ADDRESS_PREFIX = "pc1";
export declare function encodePrivacyAddress(spendPubkey: BN, viewingKey: Uint8Array): string;
export declare function parsePrivacyAddress(addr: string): {
    spendPubkey: BN;
    viewingKey: Uint8Array;
};
export declare function isPrivacyAddress(addr: string): boolean;
export declare function randomBytes(n: number): Uint8Array;
export { buildUnlockMessage, type SiwsUnlockInput, type SiwsSignInInput, type SiwsSignInOutput, } from "./constants";
//# sourceMappingURL=crypto.d.ts.map