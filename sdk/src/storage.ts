/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. LocalStorage
 *     SilentPayLastFetchedIndex : to keep track of the decrypted notes, it shall be sent
 *            while fetching new notes.
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
  walletPubkeyAndID: ["walletPubkey", "id"],
};

const STORENAME = "SILENTPAY_NOTES";

const SilentPayLastFetchedIndex = "SILENT_FETCHED_NOTE_INDEX";

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
  async saveNote(walletPubkey: string, note: Uint8Array) {
    const StoredNoteSchema: StoredNoteSchema = {
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
  async saveNoteBatch(walletPubkey: string, notes: Uint8Array[]) {
    const tx = this.db.transaction(STORENAME, "readwrite");
    for (let note of notes) {
      const storedNote: StoredNoteSchema = {
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
  async loadNotes(walletPubkey: string) {
    const notes = await this.db.getAllFromIndex(
      STORENAME,
      "users",
      walletPubkey,
    );
    return notes;
  }

  /**
   *
   * @param walletPubkey
   * @param fromId : notes with id greater than this
   * @returns array of notes
   */
  async loadNotesFrom(walletPubkey: string, fromId: number) {
    return this.db.getAllFromIndex(
      STORENAME,
      "walletPubkeyAndID",
      IDBKeyRange.bound(
        [walletPubkey, fromId],
        [walletPubkey, Infinity],
        true,
        false,
      ),
    );
  }

  async loadPairOfNotes(id1: number, id2: number) {
    const tx = this.db.transaction(STORENAME, "readonly");
    const noteStore = tx.objectStore(STORENAME);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));
    const secondNote = await noteStore.get(IDBKeyRange.only(id2));

    await tx.commit();

    return [firstNote, secondNote];
  }

  async loadSingleNote(id1: number) {
    const tx = this.db.transaction(STORENAME, "readonly");
    const noteStore = tx.objectStore(STORENAME);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));

    await tx.commit();

    return firstNote;
  }

  async getLastFetchedNote() {
    return Number(localStorage.getItem(SilentPayLastFetchedIndex));
  }

  async updateLastFetchedNote(newIndex: number) {
    return localStorage.setItem(
      SilentPayLastFetchedIndex,
      newIndex.toString(10),
    );
  }
}
