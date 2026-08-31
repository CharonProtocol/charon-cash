/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     silent-pay-merkle-index : to keep track of the decrypted notes.
 */

import { openDB, type IDBPDatabase } from "idb";

const CURRENTDBVERSION = 1;

export type StoredNoteSchema = {
  id?: number;
  encryptedNote: Uint8Array;
  walletPubkey: string;
};

const Indexes = {
  users: "walletPubkey",
};

const STORENAME = "SILENTPAY_NOTES";

const SilentPayMerkleIndex = "SILENT_PAY_MERKLE_INDEX";

export class StorageService {
  private db: IDBPDatabase;

  private constructor(db: IDBPDatabase) {
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
  async saveNote(walletPubkey: string, note: Uint8Array) {
    const StoredNoteSchema: StoredNoteSchema = {
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
  saveNoteBatch(notes: [Uint8Array], walletPubkey: string) {
    const tx = this.db.transaction(STORENAME, "readwrite");
    notes.forEach((note) => {
      const StoredNoteSchema: StoredNoteSchema = {
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
  async loadNotes(walletPubkey: string) {
    const notes = await this.db.getAllFromIndex(
      STORENAME,
      "users",
      walletPubkey,
    );
    return notes;
  }

  async loadPairOfNotes(walletPubkey: string, id1: number, id2: number) {
    const tx = this.db.transaction(STORENAME, "readonly");
    const noteStore = tx.objectStore(STORENAME);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));
    const secondNote = await noteStore.get(IDBKeyRange.only(id2));

    tx.commit();

    return [firstNote, secondNote];
  }

  async loadSingleNote(walletPubkey: string, id1: number) {
    const tx = this.db.transaction(STORENAME, "readonly");
    const noteStore = tx.objectStore(STORENAME);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));

    tx.commit();

    return firstNote;
  }

  async getMerkleIndex() {
    return Number(localStorage.getItem(SilentPayMerkleIndex));
  }

  async updateMerkleIndex(newIndex: number) {
    return localStorage.setItem(SilentPayMerkleIndex, newIndex.toString(10));
  }
}
