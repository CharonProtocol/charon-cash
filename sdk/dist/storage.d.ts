/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     SilentPayLastFetchedIndex : to keep track of the decrypted notes, it shall be sent
 *            while fetching new notes.
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
    saveNote(walletPubkey: string, note: Uint8Array): Promise<void>;
    /**
     *
     * @param walletPubkey
     * @param note
     */
    saveNoteBatch(walletPubkey: string, notes: Uint8Array[]): Promise<void>;
    /**
     *
     * @param walletPubkey
     * @returns [`StoredNoteSchema = {
                      id: number;
                      encryptedNote: Uint8Array;
                      walletPubkey: string;
          };`]
     */
    loadNotes(walletPubkey: string): Promise<any[]>;
    /**
     *
     * @param walletPubkey
     * @param fromId : notes with id greater than this
     * @returns array of notes
     */
    loadNotesFrom(walletPubkey: string, fromId: number): Promise<any[]>;
    loadPairOfNotes(id1: number, id2: number): Promise<any[]>;
    loadSingleNote(id1: number): Promise<any>;
    getLastFetchedNote(): Promise<number>;
    updateLastFetchedNote(newIndex: number): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map