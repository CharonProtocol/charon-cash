/**
 *  Storages Used :
 *  1. IndexedDB
 *      encryptedOutput will be stored corresponding to the specific walletPubkey
 *
 *  2. window.localStorage
 *     SilentPayLastFetchedIndex : to keep track of the decrypted notes, it shall be sent
 *            while fetching new notes.
 */
import { CharonProtocolError } from "./error";
export type StoredUtxoSchema = {
    id?: number;
    encryptedUtxo: Uint8Array;
    walletPubkey: string;
};
export type IndexWalletSchema = {
    walletPubkey: string;
    index: string;
};
export declare class StorageError extends CharonProtocolError {
    constructor(message: string, options?: {
        cause: unknown;
    });
}
export declare class StorageService {
    private db;
    private constructor();
    static start(): Promise<StorageService>;
    /**
     *
     * @param walletPubkey : wallet whose note this belongs to
     * @param note
     */
    saveUtxo(walletPubkey: string, utxoBytes: Uint8Array): Promise<void>;
    /**
     *
     * @param walletPubkey
     * @param note
     */
    saveUtxoBatch(walletPubkey: string, utxos: Uint8Array[]): Promise<void>;
    /**
     *
     * @param walletPubkey
     * @returns [`StoredUtxoSchema = {
                      id: number;
                      encryptedUtxos: Uint8Array;
                      walletPubkey: string;
          };`]
     */
    loadUtxoBatch(walletPubkey: string): Promise<StoredUtxoSchema[]>;
    /**
     *
     * @param walletPubkey
     * @param fromId : utxos with id greater than this
     * @returns array of utxo
     */
    loadUtxosFrom(walletPubkey: string, fromId: number): Promise<StoredUtxoSchema[]>;
    loadPairOfUtxo(id1: number, id2: number): Promise<StoredUtxoSchema[]>;
    loadUtxo(id1: number): Promise<StoredUtxoSchema>;
    removeUtxo(id: number): Promise<void>;
    removeUtxoPair(id1: number, id2: number): Promise<void>;
    getNextUtxoToFetchIndex(walletPubkey: string): Promise<IndexWalletSchema>;
    updateNextUtxoToFetchIndex(walletPubkey: string, newIndex: number): Promise<IDBValidKey>;
    stop(): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map