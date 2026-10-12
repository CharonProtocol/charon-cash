/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. window.localStorage
 *     SilentPayLastFetchedIndex : to keep track of the decrypted notes, it shall be sent
 *            while fetching new notes.
 */
import { openDB } from "idb";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error";
const CURRENTDBVERSION = 1;
const Indexes = {
    users: "walletPubkey",
    walletPubkeyAndID: ["walletPubkey", "id"],
};
const UTXO_STORE = "CHARONPROTOCOL_UTXOS";
const INDEX_STORE = "CHARON_PROTOCOL_UTXO_INDEX_PER_WALLET";
export class StorageError extends CharonProtocolError {
    constructor(message, options) {
        super(message, CharonProtocolErrorCode.STORAGE_ERROR, {
            cause: options?.cause,
        });
        this.name = "StorageError";
        Object.setPrototypeOf(this, StorageError.prototype);
    }
}
export class StorageService {
    db;
    constructor(db) {
        this.db = db;
    }
    static async start() {
        try {
            const db = await openDB("CHARONPROTOCOL_DB", CURRENTDBVERSION, {
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
        catch (error) {
            throw new StorageError("Unable to open the DB", { cause: error });
        }
    }
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    async saveUtxo(walletPubkey, utxoBytes) {
        try {
            const StoredUtxoSchema = {
                encryptedUtxo: utxoBytes,
                walletPubkey: walletPubkey,
            };
            await this.db.add(UTXO_STORE, StoredUtxoSchema);
        }
        catch (error) {
            throw new StorageError("Unable to store utxo in the store", {
                cause: error,
            });
        }
    }
    /**
     *
     * @param walletPubkey
     * @param note
     */
    async saveUtxoBatch(walletPubkey, utxos) {
        try {
            const tx = this.db.transaction(UTXO_STORE, "readwrite");
            for (let utxo of utxos) {
                const storedNote = {
                    encryptedUtxo: utxo,
                    walletPubkey,
                };
                tx.store.add(storedNote);
            }
            await tx.commit();
        }
        catch (error) {
            throw new StorageError("Unable to store utxo in batch in store", {
                cause: error,
            });
        }
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
    async loadUtxoBatch(walletPubkey) {
        try {
            const utxos = await this.db.getAllFromIndex(UTXO_STORE, "users", walletPubkey);
            return utxos;
        }
        catch (error) {
            throw new StorageError("Unable to Load utxo in batch from store", {
                cause: error,
            });
        }
    }
    /**
     *
     * @param walletPubkey
     * @param fromId : utxos with id greater than this
     * @returns array of utxo
     */
    async loadUtxosFrom(walletPubkey, fromId) {
        try {
            return this.db.getAllFromIndex(UTXO_STORE, "walletPubkeyAndID", IDBKeyRange.bound([walletPubkey, fromId], [walletPubkey, Number.MAX_SAFE_INTEGER], true, false));
        }
        catch (error) {
            throw new StorageError("Unable to Load utxo in batch from store", {
                cause: error,
            });
        }
    }
    async loadPairOfUtxo(id1, id2) {
        try {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const utxoStore = tx.objectStore(UTXO_STORE);
            const firstUtxo = await utxoStore.get(IDBKeyRange.only(id1));
            const secondUtxo = await utxoStore.get(IDBKeyRange.only(id2));
            await tx.commit();
            return [firstUtxo, secondUtxo];
        }
        catch (error) {
            throw new StorageError("Unable to load pair of utxos from store", {
                cause: error,
            });
        }
    }
    async loadUtxo(id1) {
        try {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const utxoStore = tx.objectStore(UTXO_STORE);
            const firstUtxo = await utxoStore.get(IDBKeyRange.only(id1));
            await tx.commit();
            return firstUtxo;
        }
        catch (error) {
            throw new StorageError("Unable to load of utxo from store", {
                cause: error,
            });
        }
    }
    async removeUtxo(id) {
        try {
            await this.db.delete(UTXO_STORE, id);
        }
        catch (error) {
            throw new StorageError("Failed to remove utxo from store", {
                cause: error,
            });
        }
    }
    async removeUtxoPair(id1, id2) {
        try {
            const tx = this.db.transaction(UTXO_STORE, "readwrite");
            await tx.store.delete(id1);
            await tx.store.delete(id2);
            await tx.commit();
        }
        catch (error) {
            throw new StorageError("Failed to remove pair of utxo from store", {
                cause: error,
            });
        }
    }
    async getNextUtxoToFetchIndex(walletPubkey) {
        try {
            const tx = await this.db.get(INDEX_STORE, walletPubkey);
            // Here the starting index is "1" because in postgres default index starts from 1
            return { walletPubkey: walletPubkey, index: tx ? tx.index : 1 };
        }
        catch (error) {
            throw new StorageError("Unable to load of next index", {
                cause: error,
            });
        }
    }
    async updateNextUtxoToFetchIndex(walletPubkey, newIndex) {
        try {
            const tx = await this.db.put(INDEX_STORE, {
                walletPubkey: walletPubkey,
                index: newIndex,
            });
            return tx;
        }
        catch (error) {
            throw new StorageError("Unable to update next index", {
                cause: error,
            });
        }
    }
    async stop() {
        this.db.close();
    }
}
