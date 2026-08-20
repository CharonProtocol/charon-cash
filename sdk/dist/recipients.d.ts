import { PublicKey } from "@solana/web3.js";
import type { Signer } from "./client";
export declare const RECIPIENT_PUT_PREFIX = "privacy-cash-recipients-v1";
export interface RecipientKeys {
    /** Poseidon note-spending pubkey (decimal field-element string). */
    notePubkey: string;
    /** x25519 encryption pubkey (64-char hex). */
    encPubkey: string;
}
/**
 * One-time enrollment for private receiving. The wallet signs three messages:
 * SIGN_MESSAGE (derives the existing note keypair, unchanged), RECEIVE_SIGN_MESSAGE
 * (derives the x25519 receive key), and the registry message binding wallet +
 * both pubkeys. The backend verifies the third signature before storing, so
 * nobody can overwrite someone else's keys.
 */
export declare function publishRecipientKeys(signer: Signer): Promise<RecipientKeys>;
/** Registered receive keys for a wallet, or null when the wallet has not enrolled. */
export declare function fetchRecipientKeys(wallet: PublicKey | string): Promise<RecipientKeys | null>;
//# sourceMappingURL=recipients.d.ts.map