/**
 * In-memory note cache for the current page session.
 *
 * Spending secrets (each note's `blinding`) are NEVER persisted to the browser.
 * Decrypted notes live only in this in-memory map while the wallet is unlocked,
 * and are wiped on reload. The authoritative, durable copy is the AES-GCM
 * encrypted blob stored on the backend (`encrypted_notes` table) — the server
 * holds no key. On unlock the client seeds this cache from that blob
 * (`pullEncryptedNotes`) and from the indexer scan (`syncNotes`); every
 * mutation is followed by an encrypted push back to the backend.
 *
 * Recovery safety net: even if the backend blob is lost, `syncNotes` rebuilds
 * the note set by decrypting the indexer's encrypted outputs, so funds are
 * never locked out as long as the wallet can re-sign.
 */
import { PublicKey } from "@solana/web3.js";
export interface Note {
    id: string;
    amount: string;
    blinding: string;
    index: number;
    mintAddress: string;
    spent: boolean;
    createdAt: number;
    depositTx?: string;
    spendTx?: string;
}
export declare function loadNotes(wallet: PublicKey): Note[];
export declare function saveNote(wallet: PublicKey, note: Note): void;
/** Insert or replace by (mintAddress, index). Preserves existing id/createdAt. */
export declare function upsertNote(wallet: PublicKey, note: Note): void;
export declare function markNoteSpent(wallet: PublicKey, noteId: string, spendTx: string): void;
export declare function markNoteSpentByIndex(wallet: PublicKey, mintAddress: string, index: number, spendTx?: string): void;
export declare function unspentNotes(wallet: PublicKey): Note[];
export declare function totalBalance(wallet: PublicKey, mintAddress?: string): bigint;
export declare function exportNotes(wallet: PublicKey): string;
export declare function importNotes(wallet: PublicKey, json: string, replace?: boolean): number;
export declare function clearNotes(wallet: PublicKey): void;
export declare function getSyncOffset(wallet: PublicKey, treeKey: string): number;
export declare function setSyncOffset(wallet: PublicKey, treeKey: string, offset: number): void;
export declare function resetSyncOffset(wallet: PublicKey, treeKey: string): void;
export declare function newNoteId(): string;
//# sourceMappingURL=notes.d.ts.map