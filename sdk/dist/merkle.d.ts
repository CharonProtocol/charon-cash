export interface RelayerInfo {
    programId: string;
    feeRecipient: string;
    withdrawalFeeRateBps: number;
    feeErrorMarginBps: number;
    supportedMints: {
        mint: string;
        feeAta: string;
    }[];
}
export interface TreeState {
    nextLeafIndex: number;
    /** Merkle root as a decimal field-element string (circuit-ready). */
    root: string;
    knownRoots: string[];
}
export interface MerkleProof {
    /** 26 sibling hashes as decimal field-element strings (circuit-ready). */
    pathElements: string[];
    /** 26 direction bits (0 = left, 1 = right). */
    pathIndices: number[];
}
export interface IndexedUtxo {
    leafIndex: number;
    commitment: string;
    encryptedOutputHex: string;
    signature: string;
    slot: number;
}
export interface UtxoRangePage {
    treeKey: string;
    start: number;
    end: number;
    total: number;
    nextIndex: number;
    hasMore: boolean;
    utxos: IndexedUtxo[];
}
export interface UtxoCheckResult {
    exists: boolean;
    treeKey?: string;
    leafIndex?: number;
    commitment?: string;
    signature?: string;
    slot?: number;
}
export declare function setBackendUrl(url: string): void;
export declare function getBackendUrl(): string;
export declare function submitTransaction(serializedTx: Uint8Array): Promise<string>;
export declare function bytesToHex(bytes: ArrayLike<number>): string;
/** Poseidon / Fr decimal string → 32-byte big-endian hex (no 0x). */
export declare function fieldToHex32(dec: string): string;
export declare function fetchRelayerInfo(): Promise<RelayerInfo>;
export declare function fetchTreeState(treeKey: string): Promise<TreeState>;
export declare function fetchMerkleProof(treeKey: string, leafIndex: number): Promise<MerkleProof>;
export declare function isNullifierSpent(hashHex: string): Promise<boolean>;
export declare function fetchUtxoRange(treeKey: string, start: number, end: number): Promise<UtxoRangePage>;
export declare function checkEncryptedOutput(encryptedHex: string, treeKey?: string): Promise<UtxoCheckResult>;
export interface WaitOpts {
    timeoutMs?: number;
    intervalMs?: number;
}
/** Poll until `next_leaf_index > minLeafIndex` (i.e. leaves through minLeafIndex exist). */
export declare function waitForLeafIndex(treeKey: string, minLeafIndex: number, opts?: WaitOpts): Promise<TreeState>;
/** Poll until an encrypted output hex appears in the indexer. */
export declare function waitForEncryptedOutput(encryptedHex: string, treeKey?: string, opts?: WaitOpts): Promise<UtxoCheckResult>;
export declare function solTreeKey(): string;
export declare function splTreeKey(mint: string): string;
//# sourceMappingURL=merkle.d.ts.map