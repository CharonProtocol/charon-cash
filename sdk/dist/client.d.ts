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
    /**
     * The change note minted by this transfer, identified by the blinding factor
     * generated for it. Concurrent senders shift leaf positions between proof
     * time and landing, so callers that spend the change under concurrency must
     * match on the blinding, never on a predicted leaf index.
     */
    changeNote?: {
        amount: string;
        blinding: string;
        index: number;
    };
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
    /** Unlock + rescan + persist. Powers the UI "Load notes" action. */
    refreshNotes(): Promise<SyncResult>;
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks.
     */
    syncNotes(treeKey: string, fromScratch?: boolean): Promise<SyncResult>;
    /**
     * Recover the true leaf index of a just-landed output note (a deposit, or
     * the change of a transfer). The pre-send `nextLeafIndex` is only a guess:
     * concurrent transactions can append ahead of ours before it confirms.
     * Decrypt the window around the guess and match the note's blinding factor;
     * fall back to the guess if the indexer never serves the note (syncNotes
     * corrects the index on the next scan anyway).
     */
    private locateNoteLeaf;
    depositSOL(amountLamports: number): Promise<DepositResult>;
    withdrawSOL(grossLamports: number, recipient: PublicKey | string, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult>;
    /**
     * Shielded transfer: pay `netLamports` as a note only the recipient can spend.
     * ext=0 (no public SOL moves); the relayer fee comes out of the sender's notes.
     */
    transferNoteSOL(recipient: PublicKey | string, netLamports: number, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult & {
        leafIndex: number;
        commitment: string;
    }>;
    /** SPL twin of transferNoteSOL on a registered mint's tree. */
    transferNoteSPL(mint: PublicKey | string, recipient: PublicKey | string, netRaw: number, opts?: {
        relay?: boolean;
    }): Promise<WithdrawResult & {
        leafIndex: number;
        commitment: string;
    }>;
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
    /** Poll until the indexer can serve a Merkle proof for `leafIndex` (mirror caught up). */
    private waitForNoteIndexed;
    private withdrawInternal;
    /**
     * Shared shielded-transfer flow (ext=0): output 0 is a note encrypted to the
     * recipient's registered x25519 key and committed to their note pubkey;
     * output 1 is our change note, encrypted to ourselves as usual. The relay
     * request's recipient field is the fee recipient wallet by convention (the
     * backend enforces the equality; nothing is actually paid to it at ext=0).
     */
    private transferNoteInternal;
    /** Prove + POST to relayer (backend signs with RELAYER_KEYPAIR). No wallet tx. */
    private proveAndRelay;
    private proveAndSend;
}
//# sourceMappingURL=client.d.ts.map