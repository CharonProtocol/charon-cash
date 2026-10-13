import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
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
    /** Every note the deposit minted (absent for the single-note shape). */
    notes?: Array<{
        amount: string;
        blinding: string;
        leafIndex: number;
    }>;
}
/**
 * Split a deposit into two self-notes (⌊total/2⌋ + remainder) so a wide
 * payroll fan-out starts from two lane-worthy notes and skips one halving
 * wave. The circuit only checks that the outputs sum to ext − fee, which
 * holds for any split; both halves must be > 0 to be spendable notes.
 */
export declare function splitDepositAmounts(extAmount: BN, fee: BN): {
    half: BN;
    rem: BN;
};
/**
 * The trees one refreshNotes pass scans. Discovery (no `quick`) sweeps the
 * SOL tree plus every supported mint's tree: a recipient of a shielded SPL
 * transfer has no local hint about the mint. A mid-run `quick` poll scans
 * only the tree the caller names — the engine knows which mint it is
 * paying, and change notes land in that tree alone.
 */
export declare function refreshTreeKeys(opts: {
    quick?: string;
} | undefined, supportedMints: Array<{
    mint: string;
}> | undefined): string[];
/**
 * Whether this pass re-derives nullifiers for old notes to catch phantoms
 * (spent on-chain but still spendable locally). Forced at run start
 * (`recheckSpent`); otherwise ambient, at most once per 15s — deriving N
 * nullifiers is real CPU on big vaults and it starved the provers mid-run.
 * Never on a `quick` poll: a freshly landed note cannot be spent, the
 * engine tracks the notes it spends itself, and the run-start sweep stays
 * the phantom guard. fromScratch rescans only rebuild the set, so they
 * skip it too.
 */
export declare function shouldRecheckSpent(opts: {
    fromScratch?: boolean;
    recheckSpent?: boolean;
    quick?: string;
} | undefined, lastSpentRecheckAt: number, now: number): boolean;
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
/**
 * Fires right before a transfer is submitted to the network: the nullifiers
 * being spent and the identity of the fresh change note. A submit can outlive
 * its caller — the request dies at the transport layer while the transaction
 * lands — so callers that need to survive a misreported failure (parallel
 * payroll chains) journal this and later recover the change note by blinding.
 */
export interface PendingTransfer {
    nullifiers: string[];
    changeBlinding?: string;
    changeAmount?: string;
}
export type OnSubmitted = (pending: PendingTransfer) => void | Promise<void>;
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
    private persistRunning;
    private persistAgain;
    private lastPersistAt;
    /**
     * Coalesced, throttled, non-blocking backup of the encrypted note set: at
     * most one upload in flight, at most one every PERSIST_MIN_GAP_MS, plus a
     * trailing one so the last change always lands. Payout paths used to await
     * a full re-encrypt + PUT of every note after each relay and each
     * change-note resolve (on the lane's critical path); running them back to
     * back in the background instead kept the main thread busy re-encrypting.
     * Notes stay in memory and are recoverable from the chain.
     */
    private schedulePersist;
    /** In-memory notes for the current session (decrypted; never persisted locally). */
    getNotes(): Note[];
    exportNotesString(): string;
    /** Import notes from JSON into the in-memory cache and persist to the backend. */
    importNotesJson(json: string, replace?: boolean): Promise<number>;
    /** Clear all notes — wipes the in-memory cache and the encrypted backend blob. */
    clearAllNotes(): Promise<void>;
    /** Unlock + rescan + persist. Powers the UI "Load notes" action. */
    refreshNotes(opts?: {
        fromScratch?: boolean;
        recheckSpent?: boolean;
        /**
         * Mid-run poll: scan only this tree (the caller knows which mint it is
         * paying) and skip the ambient spent-recheck — new notes cannot be
         * spent, and the run-start `recheckSpent` sweep stays the phantom guard.
         */
        quick?: string;
    }): Promise<SyncResult>;
    /**
     * Nullifiers (32-byte hex) for saved notes, derived under the unlocked
     * keypair. A caller that lost track of a broadcast (relay answered but the
     * follow-up threw) polls these to learn whether the spend actually landed
     * before attempting any retry. Notes whose index is only a guess (freshly
     * saved change notes) yield a wrong nullifier — those are simply never
     * reported spent, which is the safe direction.
     */
    nullifiersForNotes(notes: Array<{
        amount: string;
        blinding: string;
        index: number;
        mintAddress?: string;
    }>): Promise<string[]>;
    /**
     * Spent flags through one path: the batch endpoint (which retries
     * in-place). The per-hex fallback is capped — it used to fan out per
     * leaf, so one saturated window produced hundreds of singular calls that
     * deepened the saturation; past the cap this throws and the caller skips
     * the pass instead.
     */
    private spentFlags;
    /**
     * Adjudication for a transfer that threw after the relay accepted it: look
     * up the named notes (by blinding, across spent AND unspent storage) and
     * return the spending tx signature if any of their nullifiers is already
     * recorded. Resolves in one batch call when the mirror has caught up;
     * callers poll with a short interval until it returns non-null or they
     * give up. Notes whose stored index is a guess (pending change notes)
     * hash to a nullifier that can never match — the safe direction.
     */
    signatureIfSpent(blindings: string[]): Promise<string | null>;
    /**
     * Chain-truth restore for notes burned at relay-accept whose tx later
     * failed execution: a nullifier absent from the chain means the note was
     * never consumed, so it re-enters the spendable set. Notes whose stored
     * index is a guess (pending) hash to a nullifier that can never match —
     * they are skipped rather than restored on a false negative.
     */
    markNotesUnspent(blindings: string[]): Promise<number>;
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks. Single-flight: a scan mutates the
     * note store, and a second scan running mid-transfer made pinned notes
     * vanish from the spendable set (the third 100-run failed 9 rows this
     * way) — concurrent callers now queue behind the running scan.
     */
    private syncQueue;
    private lastSyncDoneAt;
    private lastSpentRecheckAt;
    private lastRestoreRecheckAt;
    private syncForSpend;
    syncNotes(treeKey: string, fromScratch?: boolean): Promise<SyncResult>;
    private syncNotesLocked;
    /**
     * Recover the true leaf index of a just-landed output note (a deposit, or
     * the change of a transfer). The pre-send `nextLeafIndex` is only a guess:
     * concurrent transactions can append ahead of ours before it confirms.
     * Decrypt the window around the guess and match the note's blinding factor.
     * Returns -1 if not found within the deadline — callers must then save the
     * note as `pending` (never spendable at the guessed index; syncNotes heals
     * it authoritatively on the next scan).
     */
    private locateNoteLeaf;
    depositSOL(amountLamports: number, opts?: {
        split?: boolean;
    }): Promise<DepositResult>;
    withdrawSOL(grossLamports: number, recipient: PublicKey | string, opts?: {
        relay?: boolean;
        inputNotes?: Array<{
            blinding: string;
        }>;
    }): Promise<WithdrawResult>;
    /**
     * Shielded transfer: pay `netLamports` as a note only the recipient can spend.
     * ext=0 (no public SOL moves); the relayer fee comes out of the sender's notes.
     */
    transferNoteSOL(recipient: PublicKey | string, netLamports: number, opts?: {
        relay?: boolean;
        onSubmitted?: OnSubmitted;
        inputNote?: {
            blinding: string;
        };
        inputNotes?: Array<{
            blinding: string;
        }>;
    }): Promise<WithdrawResult & {
        leafIndex: number;
        commitment: string;
    }>;
    /** SPL twin of transferNoteSOL on a registered mint's tree. */
    transferNoteSPL(mint: PublicKey | string, recipient: PublicKey | string, netRaw: number, opts?: {
        relay?: boolean;
        onSubmitted?: OnSubmitted;
        inputNote?: {
            blinding: string;
        };
        inputNotes?: Array<{
            blinding: string;
        }>;
    }): Promise<WithdrawResult & {
        leafIndex: number;
        commitment: string;
    }>;
    depositSPL(mint: PublicKey | string, amountRaw: number | string, opts?: {
        split?: boolean;
    }): Promise<DepositResult>;
    withdrawSPL(mint: PublicKey | string, grossRaw: number | string, recipient: PublicKey | string, opts?: {
        relay?: boolean;
        inputNotes?: Array<{
            blinding: string;
        }>;
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
     * Replace a pending change note's guessed leaf index with the relayer's
     * authoritative one, matched by blinding. Polls the commitment lookup while
     * the tx lands; giving up leaves the note pending (the next syncNotes scan
     * heals it the old way). Index-independent: the commitment is rebuilt from
     * amount + blinding alone.
     */
    resolveChangeNote(treeKey: string, mintAddress: string | undefined, change: {
        amount: string;
        blinding: string;
    }, opts?: {
        timeoutMs?: number;
        intervalMs?: number;
    }): Promise<boolean>;
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