import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { type Note } from "./notes";
export interface Signer {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}
export interface DepositResult {
    signature: string;
    amountLamports: number;
    leafIndex: number;
    nullifiers?: string[];
}
export interface WithdrawResult {
    signature: string;
    recipientLamports: number;
    feeLamports: number;
    changeLamports: string;
    nullifiers?: string[];
}
export interface SyncResult {
    scanned: number;
    added: number;
    spent: number;
}
export declare class PrivacyCashClient {
    private signer;
    private wasm?;
    private enc?;
    private utxoKeypair?;
    private programId?;
    private info?;
    private unlocking;
    constructor(signer: Signer, programId?: PublicKey);
    get publicKey(): PublicKey;
    get feeRecipient(): PublicKey;
    init(): Promise<void>;
    /** Prompt wallet to sign the constant message; derive the note keypair. */
    unlock(): Promise<void>;
    isUnlocked(): boolean;
    /** Push the local note set to the backend (encrypted blob; server can't read it). */
    backupNotes(): Promise<void>;
    /** Pull + decrypt the encrypted note blob from the backend into local storage. */
    restoreNotes(): Promise<Note[]>;
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks.
     */
    syncNotes(treeKey: string, fromScratch?: boolean): Promise<SyncResult>;
    depositSOL(amountLamports: number): Promise<DepositResult>;
    withdrawSOL(grossLamports: number, recipient: PublicKey | string): Promise<WithdrawResult>;
    depositSPL(mint: PublicKey | string, amountRaw: number | string): Promise<DepositResult>;
    withdrawSPL(mint: PublicKey | string, grossRaw: number | string, recipient: PublicKey | string): Promise<WithdrawResult>;
    getPrivateBalanceSOL(): bigint;
    getPrivateBalanceSPL(mint: PublicKey | string): bigint;
    /** Poll the indexer's next_leaf_index. Never throws — deposit already settled. */
    private waitForLeaves;
    private balanceForMint;
    private feeAta;
    private withdrawInternal;
    private proveAndSend;
}
//# sourceMappingURL=client.d.ts.map