/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. window.localStorage
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
export type IndexWalletSchema = {
  walletPubkey: string;
  index: string;
};

const Indexes = {
  users: "walletPubkey",
  walletPubkeyAndID: ["walletPubkey", "id"],
};

const NOTES_STORE = "SILENTPAY_NOTES";
const INDEX_STORE = "SILENT_PAY_NOTE_INDEX_PER_WALLET";

const SilentPayLastFetchedIndex = "SILENT_FETCHED_NOTE_INDEX";

export class StorageService {
  private db: IDBPDatabase;

  private constructor(db: IDBPDatabase) {
    this.db = db;
  }

  static async start() {
    const db = await openDB("SilentPay", CURRENTDBVERSION, {
      upgrade(db) {
        // schema for this is
        // StoredNoteSchema = {
        //         id?: number;
        //         encryptedNote: Uint8Array;
        //         walletPubkey: string;
        //   };
        const noteStore = db.createObjectStore(NOTES_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });

        Object.entries(Indexes).forEach(([key, value]) => {
          noteStore.createIndex(key, value);
        });

        // per wallet index
        // schema for this is
        // PerWalletIndex = {
        //         walletPubkey: string;
        //         index: string;
        //   };
        const indexStore = db.createObjectStore(INDEX_STORE, {
          keyPath: "walletPubkey",
        });
      },
    });

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

    await this.db.add(NOTES_STORE, StoredNoteSchema);
  }

  /**
   *
   * @param walletPubkey
   * @param note
   */
  async saveNoteBatch(walletPubkey: string, notes: Uint8Array[]) {
    const tx = this.db.transaction(NOTES_STORE, "readwrite");
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
  async loadNotes(walletPubkey: string): Promise<StoredNoteSchema[]> {
    const notes = await this.db.getAllFromIndex(
      NOTES_STORE,
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
  async loadNotesFrom(
    walletPubkey: string,
    fromId: number,
  ): Promise<StoredNoteSchema[]> {
    return this.db.getAllFromIndex(
      NOTES_STORE,
      "walletPubkeyAndID",
      IDBKeyRange.bound(
        [walletPubkey, fromId],
        [walletPubkey, Infinity],
        true,
        false,
      ),
    );
  }

  async loadPairOfNotes(id1: number, id2: number): Promise<StoredNoteSchema[]> {
    const tx = this.db.transaction(NOTES_STORE, "readonly");
    const noteStore = tx.objectStore(NOTES_STORE);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));
    const secondNote = await noteStore.get(IDBKeyRange.only(id2));

    await tx.commit();

    return [firstNote, secondNote];
  }

  async loadSingleNote(id1: number): Promise<StoredNoteSchema> {
    const tx = this.db.transaction(NOTES_STORE, "readonly");
    const noteStore = tx.objectStore(NOTES_STORE);
    const firstNote = await noteStore.get(IDBKeyRange.only(id1));

    await tx.commit();

    return firstNote;
  }

  async getNextNodeToFetchIndex(
    walletPubkey: string,
  ): Promise<IndexWalletSchema> {
    const tx = await this.db.get(INDEX_STORE, walletPubkey);

    // Here the starting index is "1" because in postgres default index starts from 1
    return { walletPubkey: walletPubkey, index: tx ? tx.index : 1 };
  }

  async updateNextNodeToFetchIndex(walletPubkey: string, newIndex: number) {
    const tx = await this.db.put(INDEX_STORE, {
      walletPubkey: walletPubkey,
      index: newIndex,
    });

    return tx;
  }

  async stop() {
    this.db.close();
  }
}
