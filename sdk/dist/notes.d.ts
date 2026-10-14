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
    /**
     * True while `index` is still the pre-send guess: concurrent txs may have
     * appended ahead of ours, so the true leaf position is not confirmed yet.
     * Pending notes are excluded from `unspentNotes` — spending a note at a
     * wrong index makes the circuit's root check (ForceEqualIfEnabled) fail.
     * Cleared by locateNoteLeaf / the next syncNotes scan.
     */
    pending?: boolean;
    /**
     * Resolve windows that timed out while this note stayed pending. A note
     * that keeps failing is a phantom change note (its tx landed but failed
     * execution, so no leaf was ever minted) or a mirror hole; past a cap it
     * is dropped instead of polled forever. A hole that later heals is
     * re-added by any scan.
     */
    pendingAttempts?: number;
    /**
     * Leaf index at/after the current tree's end (another network's note, or a
     * reset chain): held out of spending, never deleted, and cleared as soon as
     * a sync sees a tree that contains the index.
     */
    foreign?: boolean;
}
export declare function loadNotes(wallet: PublicKey): Note[];
/**
 * Flag confirmed notes whose leaf lies at or beyond this tree's end as
 * foreign (not spendable) and clear the flag on notes the tree now contains.
 * Nothing is deleted: the tree size comes from the backend, which must not be
 * able to make the wallet forget real notes. Returns how many are flagged.
 */
export declare function flagNotesBeyondTree(wallet: PublicKey, mintAddress: string, treeSize: number): number;
export declare function saveNote(wallet: PublicKey, note: Note): void;
/** Insert, or update the same note (by blinding). Preserves existing id/createdAt. */
export declare function upsertNote(wallet: PublicKey, note: Note): void;
export declare function markNoteSpent(wallet: PublicKey, noteId: string, spendTx: string): void;
/**
 * Reverse a premature spend-mark: the transfer path burns notes at
 * relay-accept, but a tx that later fails execution never consumed the
 * nullifier, so the note is still spendable and must re-enter the balance.
 */
export declare function markNoteUnspent(wallet: PublicKey, noteId: string): void;
/**
 * Pin a pending note's authoritative leaf index (matched by blinding — the
 * pre-send index is a guess, so it cannot key the lookup) and un-pend it.
 * A note whose blinding is absent (already healed by a sync scan, or spent)
 * is left alone.
 */
export declare function resolvePendingNote(wallet: PublicKey, match: {
    mintAddress: string;
    blinding: string;
    index: number;
}): void;
/**
 * Count a timed-out resolve window for this pending note. Past
 * `maxAttempts` the note is dropped (it is either a phantom that will never
 * exist or a hole a later scan re-adds) and true is returned so callers
 * stop polling. Notes that resolve successfully reset to zero instead.
 */
export declare function recordResolveFailure(wallet: PublicKey, mintAddress: string, blinding: string, maxAttempts: number): boolean;
export declare function markNoteSpentByIndex(wallet: PublicKey, mintAddress: string, index: number, spendTx?: string, blinding?: string): void;
export declare function unspentNotes(wallet: PublicKey): Note[];
export declare function totalBalance(wallet: PublicKey, mintAddress?: string): bigint;
export declare function exportNotes(wallet: PublicKey): string;
export declare function importNotes(wallet: PublicKey, json: string, replace?: boolean): number;
export declare function clearNotes(wallet: PublicKey): void;
/**
 * Drop any unspent note that duplicates (mint, amount, blinding) at a DIFFERENT
 * index. A note's commitment is Poseidon(amount, pubkey, blinding, mint), so a
 * given UTXO lives at exactly one leaf index; any other index for the same
 * (amount, blinding, mint) is a stale label left by a relayer-mirror rebuild.
 * Called from syncNotes before upserting the authoritative copy.
 */
export declare function removeStaleNote(wallet: PublicKey, mintAddress: string, amount: string, blinding: string, keepIndex: number): void;
export declare function getSyncOffset(wallet: PublicKey, treeKey: string): number;
export declare function setSyncOffset(wallet: PublicKey, treeKey: string, offset: number): void;
export declare function resetSyncOffset(wallet: PublicKey, treeKey: string): void;
/**
 * Read any pre-migration plaintext notes left in localStorage by older builds.
 * Returns [] outside the browser or if none exist. Used once on unlock to
 * migrate them into the encrypted backend blob, after which the legacy key is
 * purged by `purgeLegacyStorage`.
 */
export declare function readLegacyNotes(wallet: PublicKey): Note[];
/**
 * Remove the legacy plaintext notes key for this wallet. Idempotent; safe to
 * call on every unlock. The sync offset is deliberately NOT purged: it is a
 * plain integer cursor with no secret material, and deleting it here forced a
 * full-tree rescan on every unlock (the multi-minute unlock). A stale offset
 * is handled by syncNotes's indexer-reset guard instead.
 */
export declare function purgeLegacyStorage(wallet: PublicKey): void;
export declare function newNoteId(): string;
//# sourceMappingURL=notes.d.ts.map