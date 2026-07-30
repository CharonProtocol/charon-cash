/**
 * Encrypted note blob sync with the backend.
 *
 * The note set (which includes each note's blinding factor — the spending
 * secret) is encrypted client-side with the wallet-signature-derived AES-GCM
 * key (see `EncryptionService`). Only the resulting ciphertext is sent to the
 * backend, which stores it as an opaque blob keyed by wallet pubkey. The server
 * can never read the notes. This gives fetchable/backup-able notes across
 * devices without weakening the privacy model.
 */
import type { PublicKey } from "@solana/web3.js";
import { EncryptionService } from "./crypto";
import { type Note } from "./notes";
/** Encrypt the note set to a hex blob using the wallet-derived key. */
export declare function encryptNotesBlob(enc: EncryptionService, notes: Note[]): Promise<string>;
/** Decrypt a hex blob back into notes using the wallet-derived key. */
export declare function decryptNotesBlob(enc: EncryptionService, hex: string): Promise<Note[]>;
/** Read local notes, encrypt, and PUT the blob to the backend (upsert). */
export declare function pushEncryptedNotes(wallet: PublicKey, enc: EncryptionService): Promise<void>;
/**
 * GET the encrypted blob, decrypt it, and upsert into local storage.
 * Returns the merged local note set. Missing backup (404 or empty) → [].
 */
export declare function pullEncryptedNotes(wallet: PublicKey, enc: EncryptionService): Promise<Note[]>;
//# sourceMappingURL=notestore.d.ts.map