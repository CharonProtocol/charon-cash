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

export type StoredUtxoSchema = {
  id?: number;
  encryptedUtxo: Uint8Array;
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

const UTXO_STORE = "SILENTPAY_UTXOS";
const INDEX_STORE = "SILENT_PAY_UTXO_INDEX_PER_WALLET";

export class StorageService {
  private db: IDBPDatabase;

  private constructor(db: IDBPDatabase) {
    this.db = db;
  }

  static async start() {
    const db = await openDB("SilentPay", CURRENTDBVERSION, {
      upgrade(db) {
        // schema for this is
        // StoredUtxoSchema = {
        //         id?: number;
        //         encryptedNote: Uint8Array;
        //         walletPubkey: string;
        //   };
        const utxoStore = db.createObjectStore(UTXO_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });

        Object.entries(Indexes).forEach(([key, value]) => {
          utxoStore.createIndex(key, value);
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
  async saveUtxo(walletPubkey: string, utxoBytes: Uint8Array) {
    const StoredUtxoSchema: StoredUtxoSchema = {
      encryptedUtxo: utxoBytes,
      walletPubkey: walletPubkey,
    };

    await this.db.add(UTXO_STORE, StoredUtxoSchema);
  }

  /**
   *
   * @param walletPubkey
   * @param note
   */
  async saveUtxoBatch(walletPubkey: string, utxos: Uint8Array[]) {
    const tx = this.db.transaction(UTXO_STORE, "readwrite");
    for (let utxo of utxos) {
      const storedNote: StoredUtxoSchema = {
        encryptedUtxo: utxo,
        walletPubkey,
      };

      tx.store.add(storedNote);
    }

    await tx.commit();
  }

  /**
   *
   * @param walletPubkey
   * @returns [`StoredUtxoSchema = {
                    id: number;
                    encryptedUtxos: Uint8Array;
                    walletPubkey: string;
        };`]
   */
  async loadUtxoBatch(walletPubkey: string): Promise<StoredUtxoSchema[]> {
    const utxos = await this.db.getAllFromIndex(
      UTXO_STORE,
      "users",
      walletPubkey,
    );
    return utxos;
  }

  /**
   *
   * @param walletPubkey
   * @param fromId : utxos with id greater than this
   * @returns array of utxo
   */
  async loadUtxosFrom(
    walletPubkey: string,
    fromId: number,
  ): Promise<StoredUtxoSchema[]> {
    return this.db.getAllFromIndex(
      UTXO_STORE,
      "walletPubkeyAndID",
      IDBKeyRange.bound(
        [walletPubkey, fromId],
        [walletPubkey, Infinity],
        true,
        false,
      ),
    );
  }

  async loadPairOfUtxo(id1: number, id2: number): Promise<StoredUtxoSchema[]> {
    const tx = this.db.transaction(UTXO_STORE, "readonly");
    const utxoStore = tx.objectStore(UTXO_STORE);
    const firstUtxo = await utxoStore.get(IDBKeyRange.only(id1));
    const secondUtxo = await utxoStore.get(IDBKeyRange.only(id2));

    await tx.commit();

    return [firstUtxo, secondUtxo];
  }

  async loadUtxo(id1: number): Promise<StoredUtxoSchema> {
    const tx = this.db.transaction(UTXO_STORE, "readonly");
    const utxoStore = tx.objectStore(UTXO_STORE);
    const firstUtxo = await utxoStore.get(IDBKeyRange.only(id1));

    await tx.commit();

    return firstUtxo;
  }

  async getNextUtxoToFetchIndex(
    walletPubkey: string,
  ): Promise<IndexWalletSchema> {
    const tx = await this.db.get(INDEX_STORE, walletPubkey);

    // Here the starting index is "1" because in postgres default index starts from 1
    return { walletPubkey: walletPubkey, index: tx ? tx.index : 1 };
  }

  async updateNextUtxoToFetchIndex(walletPubkey: string, newIndex: number) {
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
