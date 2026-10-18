/**
 * Encrypted note blob sync with the backend — the authoritative note store.
 *
 * Notes (including each note's blinding factor — the spending secret) are NEVER
 * persisted to the browser. The wallet-signature-derived AES-GCM key (see
 * `EncryptionService`) encrypts the in-memory note set into an opaque blob that
 * is PUT to the backend (`encrypted_notes` table) and GET back on unlock. The
 * server stores only ciphertext and holds no key.
 *
 * Flow: the client keeps decrypted notes in an in-memory cache for the session
 * (`notes.ts`). On `unlock()` it seeds that cache by GET-ing + decrypting the
 * blob (`pullEncryptedNotes`) and by scanning the indexer (`syncNotes`); after
 * every mutation it PUTs a fresh ciphertext (`pushEncryptedNotes`). Reload wipes
 * the cache; the blob survives. Even without the blob, `syncNotes` rebuilds the
 * notes from the indexer's encrypted outputs, so funds are never locked out.
 */
import { PublicKey } from "@solana/web3.js";
import { EncryptionService } from "./crypto";
import { type Note } from "./notes";
/** Encrypt the note set to a hex blob using the wallet-derived key. */
export declare function encryptNotesBlob(enc: EncryptionService, notes: Note[]): Promise<string>;
/** Decrypt a hex blob back into notes using the wallet-derived key. */
export declare function decryptNotesBlob(enc: EncryptionService, hex: string): Promise<Note[]>;
/** What the backup key signs for one upload: wallet, time, and the blob's hash. */
export declare function noteBackupMessage(wallet: string, ts: number, ciphertext: string): Uint8Array;
/** What the wallet signs once to link its backup key. */
export declare function noteKeyLinkMessage(wallet: string, backupKey: string): Uint8Array;
/**
 * Read the in-memory note set, encrypt, and PUT the blob to the backend
 * (upsert), signed by the wallet's backup key. The first upload to a backend
 * that has no key for this wallet links it with one wallet signature.
 */
export declare function pushEncryptedNotes(wallet: PublicKey, enc: EncryptionService, signMessage?: (message: Uint8Array) => Promise<Uint8Array>): Promise<void>;
/**
 * GET the encrypted blob, decrypt it, and upsert into the in-memory cache.
 * Returns the merged in-memory note set. Missing backup (404 or empty) → [].
 */
export declare function pullEncryptedNotes(wallet: PublicKey, enc: EncryptionService): Promise<Note[]>;
//# sourceMappingURL=notestore.d.ts.map