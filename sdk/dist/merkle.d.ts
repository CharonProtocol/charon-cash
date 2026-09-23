export interface RelayerInfo {
    programId: string;
    feeRecipient: string;
    withdrawalFeeRateBps: number;
    feeErrorMarginBps: number;
    supportedMints: {
        mint: string;
        feeAta: string;
    }[];
    /**
     * Unrecoverable rent for the two nullifier marker accounts every transact
     * creates. The relayer fronts this and is reimbursed the fee in the same
     * transaction, so it is the floor a fee has to clear — not the ~5,000 lamport
     * transaction fee, which it dwarfs by roughly 250x.
     */
    transactRentLamports: number;
    /** The minimum fee `/api/relayer/transact` will accept, rent and margin included. */
    minTransactFeeLamports: number;
    /** False when the relayer has no lookup table configured, so SPL cannot be relayed. */
    splRelayAvailable: boolean;
}
export interface TreeState {
    nextLeafIndex: number;
    /** Merkle root as a decimal field-element string (circuit-ready). */
    root: string;
    knownRoots: string[];
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
export declare function setBackendUrl(url: string): void;
export declare function getBackendUrl(): string;
/** Point `/api/relayer/*` at a separate origin. Defaults to the backend URL. */
export declare function setRelayerUrl(url: string): void;
export declare function getRelayerUrl(): string;
export declare function submitTransaction(serializedTx: Uint8Array): Promise<string>;
/** Shim-signed atomic v1 swap. Does not use Phantom. */
export declare function relaySwap(req: {
    proofIn: {
        proofA: number[];
        proofB: number[];
        proofC: number[];
        root: number[];
        publicAmount: number[];
        extDataHash: number[];
        inputNullifiers: number[][];
        outputCommitments: number[][];
    };
    proofOut: {
        proofA: number[];
        proofB: number[];
        proofC: number[];
        root: number[];
        publicAmount: number[];
        extDataHash: number[];
        inputNullifiers: number[][];
        outputCommitments: number[][];
    };
    extAmountIn: number | string;
    extAmountOut: number | string;
    encryptedOutputIn1: Uint8Array;
    encryptedOutputIn2: Uint8Array;
    encryptedOutputOut1: Uint8Array;
    encryptedOutputOut2: Uint8Array;
    fromMint: string;
    outMint: string;
    routeData: Uint8Array;
    routeAccounts: {
        pubkey: string;
        isWritable: boolean;
    }[];
}): Promise<string>;
export interface JupiterRoute {
    minOut: string;
    outAmount: string;
    routeData: Uint8Array;
    routeAccounts: {
        pubkey: string;
        isWritable: boolean;
    }[];
}
/** Quote + swap-instructions via the backend shim (avoids browser CORS to Jupiter). */
export declare function fetchJupiterRoute(req: {
    inputMint: string;
    outputMint: string;
    amount: string | number;
    userPublicKey: string;
    slippageBps?: number;
}): Promise<JupiterRoute>;
export declare function bytesToHex(bytes: ArrayLike<number>): string;
/** Poseidon / Fr decimal string → 32-byte big-endian hex (no 0x). */
export declare function fieldToHex32(dec: string): string;
export declare function fetchRelayerInfo(): Promise<RelayerInfo>;
export interface RelayProofPayload {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    root: number[];
    publicAmount: number[];
    extDataHash: number[];
    inputNullifiers: number[][];
    outputCommitments: number[][];
}
export interface RelayTransactRequest {
    proof: RelayProofPayload;
    /** Negative for a withdrawal, zero for a shielded transfer. */
    extAmount: string;
    fee: string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    recipient: string;
    feeRecipient: string;
    mint: string;
    isSpl: boolean;
    recipientTokenAccount?: string;
}
export interface RelayTransactResult {
    signature: string;
    /** What the relayer paid out of its own float, for fee-transparency in the UI. */
    rentLamports: number;
    feeLamports: number;
}
/**
 * Hand a proof to the relayer and let it build, sign and submit.
 *
 * This is the privacy-critical path. A wallet-signed withdrawal names the
 * withdrawing wallet as fee payer and signer directly beside the recipient and the
 * amount, which links them without breaking any cryptography. Sending a pre-signed
 * transaction cannot fix that, because the fee payer is part of the signed message —
 * so the relayer has to be the one compiling it.
 *
 * The relayer cannot tamper with any of this: recipient, amount, fee, fee recipient,
 * mint and both ciphertexts are hashed into `extDataHash`, a Groth16 public input the
 * program verifies. It can refuse, delay, reorder and observe. Nothing else.
 */
export declare function relayTransact(req: RelayTransactRequest): Promise<RelayTransactResult>;
export interface BlockhashInfo {
    blockhash: string;
    slot: number;
}
/** Latest blockhash + slot from the backend — no client RPC needed to build a tx. */
export declare function fetchBlockhash(): Promise<BlockhashInfo>;
/** Raw Address Lookup Table account bytes (hex), or null if it doesn't exist. */
export declare function fetchAltAccount(address: string): Promise<string | null>;
export declare function fetchTreeState(treeKey: string): Promise<TreeState>;
export declare function isNullifierSpent(hashHex: string): Promise<boolean>;
export declare function fetchUtxoRange(treeKey: string, start: number, end: number): Promise<UtxoRangePage>;
export interface WaitOpts {
    timeoutMs?: number;
    intervalMs?: number;
}
/** Poll until `next_leaf_index > minLeafIndex` (i.e. leaves through minLeafIndex exist). */
export declare function waitForLeafIndex(treeKey: string, minLeafIndex: number, opts?: WaitOpts): Promise<TreeState>;
export declare function solTreeKey(): string;
export declare function splTreeKey(mint: string): string;
/** Hex (with or without 0x, 64 nybbles) or already-decimal field element → decimal. */
export declare function commitmentToDecimal(c: string): string;
/**
 * Commitments from `from` onward, in leaf-index order (decimal field elements).
 *
 * Deliberately not parameterized by which leaf you care about. The request is
 * identical for everyone at the same sync position, so it tells the backend nothing
 * about which note is yours — see the note above `merkleForSpend` in `client.ts`.
 * `/api/merkle/{tree}/leaves` returns bare commitments, roughly an order of
 * magnitude less bandwidth than `/api/utxos/range`, which also ships the ciphertext
 * and signature per leaf only for this caller to discard them.
 */
export declare function fetchTreeLeavesFrom(treeKey: string, from?: number): Promise<{
    leaves: string[];
    from: number;
    nextIndex: number;
}>;
/** All tree commitments in leaf-index order (decimal field elements). */
export declare function fetchTreeLeaves(treeKey: string): Promise<string[]>;
export declare function registerPrivacyKeys(args: {
    wallet: string;
    spendPubkey: string;
    viewingPubkeyHex: string;
}): Promise<void>;
export declare function lookupPrivacyKeys(wallet: string): Promise<{
    spendPubkey: string;
    viewingPubkeyHex: string;
} | null>;
//# sourceMappingURL=merkle.d.ts.map