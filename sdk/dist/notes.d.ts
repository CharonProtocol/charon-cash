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