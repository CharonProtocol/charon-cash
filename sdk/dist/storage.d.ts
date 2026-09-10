/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     silent-pay-merkle-index : to keep track of the decrypted notes.
 */
export type StoredNoteSchema = {
    id?: number;
    encryptedNote: Uint8Array;
    walletPubkey: string;
};
export declare class StorageService {
    private db;
    private constructor();
    static start(): Promise<StorageService>;
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    insertNote(walletPubkey: string, note: Uint8Array): Promise<void>;
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    insertNoteInBatch(notes: [Uint8Array], walletPubkey: string): void;
    /**
     *
     * @param walletPubkey
     * @returns [`StoredNoteSchema = {
                      id: number;
                      encryptedNote: Uint8Array;
                      walletPubkey: string;
          };`]
     */
    fetchNotes(walletPubkey: string): Promise<any[]>;
    getMerkleIndex(): Promise<number>;
    updateMerkleIndex(newIndex: number): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map