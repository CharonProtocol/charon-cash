/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     silent-pay-merkle-index : to keep track of the decrypted notes.
 */
import { openDB } from "idb";
const CURRENTDBVERSION = 1;
const Indexes = {
    users: "walletPubkey",
};
const STORENAME = "SILENTPAY_NOTES";
const SilentPayMerkleIndex = "SILENT_PAY_MERKLE_INDEX";
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
        if (!localStorage.getItem(SilentPayMerkleIndex)) {
            localStorage.setItem(SilentPayMerkleIndex, "0");
        }
        return new StorageService(db);
    }
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    async insertNote(walletPubkey, note) {
        const StoredNoteSchema = {
            encryptedNote: note,
            walletPubkey: walletPubkey,
        };
        await this.db.add(STORENAME, StoredNoteSchema);
    }
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    insertNoteInBatch(notes, walletPubkey) {
        const tx = this.db.transaction(STORENAME, "readwrite");
        notes.forEach((note) => {
            const StoredNoteSchema = {
                encryptedNote: note,
                walletPubkey,
            };
            tx.store.add(StoredNoteSchema);
        });
        tx.commit();
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
    async fetchNotes(walletPubkey) {
        const notes = await this.db.getAllFromIndex(STORENAME, "walletPubkey", walletPubkey);
        return notes;
    }
    async getMerkleIndex() {
        return Number(localStorage.getItem(SilentPayMerkleIndex));
    }
    async updateMerkleIndex(newIndex) {
        return localStorage.setItem(SilentPayMerkleIndex, newIndex.toString(10));
    }
}
