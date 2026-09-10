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
export interface SwapResult {
    signature: string;
    amountIn: string;
    minAmountOut: string;
    fromMint: string;
    outMint: string;
    nullifiers: string[];
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
    /** Pull + decrypt the encrypted note blob from the backend into the in-memory cache. */
    restoreNotes(): Promise<Note[]>;
    /**
     * Best-effort: encrypt the in-memory note set and PUT it to the backend. This
     * is the single persistence path — call it after every note mutation. Failure
     * is non-fatal because `syncNotes` can always rebuild notes from the indexer.
     */
    private persistNotes;
    /** In-memory notes for the current session (decrypted; never persisted locally). */
    getNotes(): Note[];
    exportNotesString(): string;
    /** Import notes from JSON into the in-memory cache and persist to the backend. */
    importNotesJson(json: string, replace?: boolean): Promise<number>;
    /** Clear all notes — wipes the in-memory cache and the encrypted backend blob. */
    clearAllNotes(): Promise<void>;
    /** Unlock + rescan SOL and supported SPL trees + persist. Powers the UI "Load notes" action. */
    refreshNotes(): Promise<SyncResult>;
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks.
     */
    syncNotes(treeKey: string, fromScratch?: boolean): Promise<SyncResult>;
    depositSOL(amountLamports: number): Promise<DepositResult>;
    withdrawSOL(grossLamports: number, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    depositSPL(mint: PublicKey | string, amountRaw: number | string): Promise<DepositResult>;
    withdrawSPL(mint: PublicKey | string, grossRaw: number | string, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    getPrivateBalanceSOL(): bigint;
    getPrivateBalanceSPL(mint: PublicKey | string): bigint;
    /** Poll the indexer's next_leaf_index. Never throws — deposit already settled. */
    private waitForLeaves;
    private balanceForMint;
    private feeAta;
    /**
     * Private transfer: spend a private note to pay another address. Mechanically a
     * withdraw to `recipient` — your deposit stays unlinked (proven via ZK), and the
     * recipient receives public SOL at their address. Honors the same { relay } option
     * as withdraw (default true = gasless relayer-signed).
     */
    transferSOL(amountLamports: number, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    /**
     * Private SPL transfer: spend a private SPL note to pay another address (their
     * ATA is created idempotently). Same mechanics/privacy as transferSOL.
     */
    transferSPL(mint: PublicKey | string, amountRaw: number | string, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    /**
     * Private send to a PUBLIC address (Mode A): deposit fresh from the user, then
     * withdraw-to-recipient gaslessly via the relayer (relay=true). The user signs +
     * pays the deposit; the relayer signs the withdraw. Recipient gets public SOL/SPL
     * (amount − withdrawFee) at their address; the sender's deposit is unlinkable to
     * it via ZK. (deposit can never be gasless — the signer is who puts funds in.)
     */
    sendPrivateSOL(amountLamports: number, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    sendPrivateSPL(mint: PublicKey | string, amountRaw: number | string, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    /**
     * Jupiter quote for a private SOL↔SPL swap. Does not unlock notes.
     * `fromMint` / `outMint` are mixer mints (`WRAPPED_SOL_MINT` or an SPL mint).
     */
    quotePrivateSwap(args: {
        fromMint: PublicKey | string;
        outMint: PublicKey | string;
        amountIn: number | string;
        slippageBps?: number;
    }): Promise<{
        minOut: string;
        outAmount: string;
    }>;
    /**
     * Atomic private swap: spend shielded notes, Jupiter CPI, reshield the output.
     * Relayer signs the v1 packet (Phantom cannot). Wallet only signs the unlock message.
     */
    swapPrivate(args: {
        fromMint: PublicKey | string;
        outMint: PublicKey | string;
        amountIn: number | string;
        slippageBps?: number;
    }): Promise<SwapResult>;
    private proveSwapLeg;
    /** Poll until the indexer can serve a Merkle proof for `leafIndex` (mirror caught up). */
    private waitForNoteIndexed;
    private withdrawInternal;
    /** Prove + POST to relayer (backend signs with RELAYER_KEYPAIR). No wallet tx. */
    private proveAndRelay;
    private proveAndSend;
}
//# sourceMappingURL=client.d.ts.map