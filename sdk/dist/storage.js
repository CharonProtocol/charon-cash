/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     SilentPayLastFetchedIndex : to keep track of the decrypted notes, it shall be sent
 *            while fetching new notes.
 */
import { openDB } from "idb";
const CURRENTDBVERSION = 1;
const Indexes = {
    users: "walletPubkey",
    walletPubkeyAndID: ["walletPubkey", "id"],
};
const STORENAME = "SILENTPAY_NOTES";
const SilentPayLastFetchedIndex = "SILENT_FETCHED_NOTE_INDEX";
export class StorageService {
    db;
    constructor(db) {
        this.db = db;
    }
    static async start() {
        const db = await openDB("SilentPay", CURRENTDBVERSION, {
            upgrade(db) {
                const store = db.createObjectStore(STORENAME, {
                    keyPath: "id",
                    autoIncrement: true,
                });
                Object.entries(Indexes).forEach(([key, value]) => {
                    store.createIndex(key, value);
                });
            },
        });
        if (!localStorage.getItem(SilentPayLastFetchedIndex)) {
            localStorage.setItem(SilentPayLastFetchedIndex, "0");
        }
        return new StorageService(db);
    }
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    async saveNote(walletPubkey, note) {
        const StoredNoteSchema = {
            encryptedNote: note,
            walletPubkey: walletPubkey,
        };
        await this.db.add(STORENAME, StoredNoteSchema);
    }
    /**
     *
     * @param walletPubkey
     * @param note
     */
    async saveNoteBatch(walletPubkey, notes) {
        const tx = this.db.transaction(STORENAME, "readwrite");
        for (let note of notes) {
            const storedNote = {
                encryptedNote: note,
                walletPubkey,
            };
            tx.store.add(storedNote);
        }
        await tx.commit();
    }
    /**
     *
     * @param walletPubkey
     * @returns [`StoredNoteSchema = {
                      id: number;
                      encryptedNote: Uint8Array;
                      walletPubkey: string;
          };`]
     */
    async loadNotes(walletPubkey) {
        const notes = await this.db.getAllFromIndex(STORENAME, "users", walletPubkey);
        return notes;
    }
    /**
     *
     * @param walletPubkey
     * @param fromId : notes with id greater than this
     * @returns array of notes
     */
    async loadNotesFrom(walletPubkey, fromId) {
        return this.db.getAllFromIndex(STORENAME, "walletPubkeyAndID", IDBKeyRange.bound([walletPubkey, fromId], [walletPubkey, Infinity], true, false));
    }
    async loadPairOfNotes(id1, id2) {
        const tx = this.db.transaction(STORENAME, "readonly");
        const noteStore = tx.objectStore(STORENAME);
        const firstNote = await noteStore.get(IDBKeyRange.only(id1));
        const secondNote = await noteStore.get(IDBKeyRange.only(id2));
        await tx.commit();
        return [firstNote, secondNote];
    }
    async loadSingleNote(id1) {
        const tx = this.db.transaction(STORENAME, "readonly");
        const noteStore = tx.objectStore(STORENAME);
        const firstNote = await noteStore.get(IDBKeyRange.only(id1));
        await tx.commit();
        return firstNote;
    }
    async getLastFetchedNote() {
        return Number(localStorage.getItem(SilentPayLastFetchedIndex));
    }
    async updateLastFetchedNote(newIndex) {
        return localStorage.setItem(SilentPayLastFetchedIndex, newIndex.toString(10));
    }
}
