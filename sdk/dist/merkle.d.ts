export interface RelayerInfo {
    programId: string;
    feeRecipient: string;
    withdrawalFeeRateBps: number;
    feeErrorMarginBps: number;
    /** Floor on the relayer fee for ext=0 SOL transfers (lamports); absent on older backends. */
    minTransferFee?: number;
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
    /** Root the siblings hash up to, as a decimal field-element string (circuit-ready). */
    root: string;
    /** Tree size in the same snapshot as `root`. */
    nextLeafIndex: number;
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
/** Relayer-signed withdraw: POST proof fields; backend builds + signs + submits. */
export declare function relayWithdraw(req: {
    kind: "sol" | "spl";
    proofA: number[];
    proofB: number[];
    proofC: number[];
    root: number[];
    publicAmount: number[];
    extDataHash: number[];
    inputNullifiers: number[][];
    outputCommitments: number[][];
    extAmount: number;
    fee: number;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    /** SOL: wallet. SPL: recipient ATA. */
    recipient: string;
    mint?: string;
    /** SPL: wallet that owns the recipient ATA. */
    recipientOwner?: string;
    /** SPL: client-built ALT address so the relayer can compress the v0 withdraw tx. */
    altAddress?: string;
}): Promise<string>;
export declare function bytesToHex(bytes: ArrayLike<number>): string;
/** Poseidon / Fr decimal string → 32-byte big-endian hex (no 0x). */
export declare function fieldToHex32(dec: string): string;
export declare function fetchRelayerInfo(): Promise<RelayerInfo>;
export interface BlockhashInfo {
    blockhash: string;
    slot: number;
}
/** Latest blockhash + slot from the backend — no client RPC needed to build a tx. */
export declare function fetchBlockhash(): Promise<BlockhashInfo>;
/** Raw Address Lookup Table account bytes (hex), or null if it doesn't exist. */
export declare function fetchAltAccount(address: string): Promise<string | null>;
export declare function fetchTreeState(treeKey: string): Promise<TreeState>;
export declare function fetchMerkleProof(treeKey: string, leafIndex: number): Promise<MerkleProof>;
export declare function isNullifierSpent(hashHex: string): Promise<boolean>;
/**
 * Spent flags for many nullifiers in as few calls as possible: one batch
 * request per 90 (the scan otherwise paid a round trip per note — the slow
 * unlock and slow in-run sync passes). Input order is preserved.
 */
export declare function nullifiersSpent(hashHexes: string[]): Promise<boolean[]>;
/** Spent flag plus the spending tx signature, when the relayer recorded one. */
export declare function nullifierInfo(hashHex: string): Promise<{
    spent: boolean;
    signature?: string;
}>;
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