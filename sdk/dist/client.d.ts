import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { type SiwsSignInInput, type SiwsSignInOutput, type SiwsUnlockInput } from "./constants";
import { type Note } from "./notes";
export interface Signer {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    /**
     * Wallet Standard SIWS. Required for `unlock()` — Phantom checks `domain`
     * against the page. `signMessage` is not a substitute (phishing can forge the bytes).
     */
    signIn?: (input: SiwsSignInInput) => Promise<SiwsSignInOutput>;
}
/** Overrides for Node tests / scripts. In the browser, domain/uri come from `window.location`. */
export type UnlockOpts = {
    domain?: string;
    uri?: string;
    chainId?: string;
};
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
    v1Seen: number;
    v1Decrypted: number;
}
export interface SwapResult {
    signature: string;
    amountIn: string;
    minAmountOut: string;
    fromMint: string;
    outMint: string;
    nullifiers: string[];
}
export interface ClientOptions {
    /**
     * Sign withdrawals and transfers with the user's own wallet instead of handing
     * the proof to the relayer.
     *
     * This is the escape hatch, and it is off by default because it costs the privacy
     * the pool exists to provide: a self-signed withdrawal puts the wallet on-chain as
     * fee payer beside the recipient and the amount, which links deposit to withdrawal
     * without breaking any cryptography.
     *
     * It exists because the alternative is worse. A relayer that is down, censoring, or
     * gone takes the funds with it if there is no other path, and the honest answer to
     * "can I always get my money out" has to be yes. So: use the relayer normally,
     * fall back to this when you must, and know what you are trading.
     */
    selfRelay?: boolean;
}
export declare class PrivacyCashClient {
    private signer;
    private wasm?;
    private enc?;
    private utxoKeypair?;
    private programId?;
    private info?;
    private unlocking;
    private unlockOpts?;
    private selfRelay;
    constructor(signer: Signer, programId?: PublicKey, unlock?: UnlockOpts, options?: ClientOptions);
    /**
     * Switch withdrawals and transfers between the relayer and the user's own wallet.
     * See `ClientOptions.selfRelay` — enabling this trades privacy for a guarantee of
     * access.
     */
    setSelfRelay(enabled: boolean): void;
    isSelfRelay(): boolean;
    get publicKey(): PublicKey;
    get feeRecipient(): PublicKey;
    /**
     * Minimum fee the relayer will accept, published by `/api/relayer/info` rather
     * than hardcoded so it cannot drift from what the relayer enforces. Almost all of
     * it is the unrecoverable rent for the two nullifier accounts a transact creates.
     */
    private relayFeeFloor;
    /**
     * Whether a relayed spend is possible for this asset. See `relay-policy.ts`;
     * notably a caller must never silently fall back to wallet signing, because that
     * deanonymizes the user without telling them.
     */
    canRelay(isSpl: boolean): boolean;
    /**
     * Smallest withdrawal worth making, in lamports. Below this the relayer's
     * unrecoverable nullifier rent exceeds the amount withdrawn. Surface this in the
     * UI so users meet it by choice rather than by error message.
     */
    minWithdrawalLamports(isSpl?: boolean): number;
    /** What a withdrawal of `grossLamports` actually pays the recipient after fees. */
    quoteWithdraw(grossLamports: number, isSpl?: boolean): {
        feeLamports: number;
        recipientLamports: number;
        minLamports: number;
    };
    init(): Promise<void>;
    /**
     * Sign In With Solana, then derive shielded spend/view keys from that signature.
     * Requires wallet `signIn` (Phantom binds `domain` to the real page). There is
     * no `signMessage` fallback — that path lets a phishing site forge the SIWS text.
     * No nonce / issuedAt — same wallet + site + cluster always yields the same key.
     */
    unlock(): Promise<void>;
    /** Canonical SIWS text the wallet must sign on `unlock()`. */
    unlockMessage(): string;
    siwsInput(): SiwsUnlockInput;
    private signUnlock;
    isUnlocked(): boolean;
    /** `pc1…` address: spend pubkey + X25519 viewing key. Recipients paste this to receive notes. */
    privacyAddress(): Promise<string>;
    private registerPrivacyKeys;
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
    withdrawSOL(grossLamports: number, recipient: PublicKey | string): Promise<WithdrawResult>;
    depositSPL(mint: PublicKey | string, amountRaw: number | string): Promise<DepositResult>;
    withdrawSPL(mint: PublicKey | string, grossRaw: number | string, recipient: PublicKey | string): Promise<WithdrawResult>;
    getPrivateBalanceSOL(): bigint;
    getPrivateBalanceSPL(mint: PublicKey | string): bigint;
    /** Poll the indexer's next_leaf_index. Never throws — deposit already settled. */
    private waitForLeaves;
    private balanceForMint;
    private feeAta;
    /**
     * Shielded transfer: spend your notes and insert a note the recipient owns in
     * the pool (`extAmount=0`). Nothing leaves the pool, so there is no public payout —
     * they withdraw later with their own key. Relayed by default, because a
     * wallet-signed transfer publishes the sender for a transaction whose whole point
     * is to hide them; the relayer's fee comes out of the sender's change, so the
     * recipient always receives exactly `amount`.
     *
     * `recipient` is their Solana wallet (they must have unlocked this app once so we
     * can look up their note keys).
     */
    transferSOL(amountLamports: number, recipient: string): Promise<WithdrawResult>;
    /**
     * Shielded SPL transfer: same as transferSOL — recipient gets a pool note,
     * not tokens in an ATA.
     */
    transferSPL(mint: PublicKey | string, amountRaw: number | string, recipient: string): Promise<WithdrawResult>;
    /**
     * Private send to a PUBLIC address: deposit from the user, then withdraw to
     * the recipient. Both legs are wallet-signed. Recipient gets public SOL
     * (amount − withdrawFee); the sender's deposit is unlinkable via ZK.
     */
    sendPrivateSOL(amountLamports: number, recipient: PublicKey | string): Promise<WithdrawResult>;
    sendPrivateSPL(mint: PublicKey | string, amountRaw: number | string, recipient: PublicKey | string): Promise<WithdrawResult>;
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
    /**
     * Rebuild the Poseidon tree from every indexed leaf and take paths locally.
     **/
    private merkleForSpend;
    private resolveRecipientKeys;
    private viewingKeyFromHex;
    private rewriteSpendError;
    /** JoinSplit with extAmount=0, fee=0: spend notes → recipient-owned pool note. */
    private transferInternal;
    /**
     * Poll until the indexer has caught up past `leafIndex`.
     *
     * Uses the tree's leaf count rather than asking for that leaf's Merkle proof.
     * The proof request would answer the same question, but it would also tell the
     * backend which leaf the caller is about to spend, which is exactly the leak
     * `merkleForSpend` goes to the trouble of avoiding. A leaf count is the same
     * request for everyone.
     */
    private waitForNoteIndexed;
    private withdrawInternal;
    private proveAndSend;
}
//# sourceMappingURL=client.d.ts.map