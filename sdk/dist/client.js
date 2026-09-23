import { WasmFactory } from "@lightprotocol/hasher.rs";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, } from "@solana/spl-token";
import { PublicKey, } from "@solana/web3.js";
import BN from "bn.js";
import { buildUnlockMessage, defaultSiwsDomain, defaultSiwsUri, envProgramId, FIELD_SIZE, MERKLE_TREE_DEPTH, NATIVE_MINT, requireStableSiws, SIWS_STATEMENT, SIWS_VERSION, SOL_TREE_KEY, WRAPPED_SOL_MINT, } from "./constants";
import { EncryptionService, Keypair, Utxo, encodePrivacyAddress, getExtDataHash, getMintAddressField, getSwapInExtDataHash, getSwapOutExtDataHash, isPrivacyAddress, parsePrivacyAddress, } from "./crypto";
import { LocalMirror } from "./local-provider";
import { bytesToHex, fetchJupiterRoute, fetchRelayerInfo, fetchBlockhash, fetchTreeLeavesFrom, fetchTreeState, fetchUtxoRange, fieldToHex32, isNullifierSpent, lookupPrivacyKeys, registerPrivacyKeys, submitTransaction, relaySwap, relayTransact, waitForLeafIndex, } from "./merkle";
import { clearCachedLeaves, loadCachedLeaves, saveCachedLeaves, } from "./mirror-cache";
import { canRelay, minEconomicWithdrawal, transferFee, transferRecipient, withdrawalFee, } from "./relay-policy";
import { clearNotes, exportNotes, getSyncOffset, importNotes, loadNotes, markNoteSpent, newNoteId, resetSyncOffset, saveNote, setSyncOffset, unspentNotes, upsertNote, markNoteSpentByIndex, } from "./notes";
import { pushEncryptedNotes, pullEncryptedNotes } from "./notestore";
import { parseToBytesArray, prove } from "./prover";
import { buildTransactSplTransaction, buildTransactTransaction, deriveSwapAccounts, } from "./program";
import { ensureAlt, envAltAddress, splAltAddresses, } from "./alt";
function mixerTreeKey(mint) {
    return mint === WRAPPED_SOL_MINT ? SOL_TREE_KEY : mint;
}
function isSolMixerMint(mint) {
    return (mint === WRAPPED_SOL_MINT ||
        mint === NATIVE_MINT.toBase58() ||
        mint === PublicKey.default.toBase58());
}
function jupiterMint(mixerMint) {
    return isSolMixerMint(mixerMint) ? NATIVE_MINT.toBase58() : mixerMint;
}
const DEPOSIT_FEE = 0;
const RANGE_PAGE = 2_000;
function toPubkey(value) {
    return value instanceof PublicKey ? value : new PublicKey(value);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export class PrivacyCashClient {
    signer;
    wasm;
    enc;
    utxoKeypair;
    programId;
    info;
    unlocking = null;
    unlockOpts;
    selfRelay;
    constructor(signer, programId, unlock, options) {
        this.signer = signer;
        this.programId = programId ?? envProgramId() ?? undefined;
        this.unlockOpts = unlock;
        this.selfRelay = options?.selfRelay ?? false;
    }
    /**
     * Switch withdrawals and transfers between the relayer and the user's own wallet.
     * See `ClientOptions.selfRelay` — enabling this trades privacy for a guarantee of
     * access.
     */
    setSelfRelay(enabled) {
        this.selfRelay = enabled;
    }
    isSelfRelay() {
        return this.selfRelay;
    }
    get publicKey() {
        return this.signer.publicKey;
    }
    get feeRecipient() {
        return new PublicKey(this.info.feeRecipient);
    }
    /**
     * Minimum fee the relayer will accept, published by `/api/relayer/info` rather
     * than hardcoded so it cannot drift from what the relayer enforces. Almost all of
     * it is the unrecoverable rent for the two nullifier accounts a transact creates.
     */
    relayFeeFloor() {
        return new BN(this.info?.minTransactFeeLamports ?? 0);
    }
    /**
     * Whether a relayed spend is possible for this asset. See `relay-policy.ts`;
     * notably a caller must never silently fall back to wallet signing, because that
     * deanonymizes the user without telling them.
     */
    canRelay(isSpl) {
        return canRelay({
            selfRelay: this.selfRelay,
            isSpl,
            splRelayAvailable: this.info?.splRelayAvailable !== false,
        });
    }
    /**
     * Smallest withdrawal worth making, in lamports. Below this the relayer's
     * unrecoverable nullifier rent exceeds the amount withdrawn. Surface this in the
     * UI so users meet it by choice rather than by error message.
     */
    minWithdrawalLamports(isSpl = false) {
        return minEconomicWithdrawal({
            withdrawalFeeRateBps: this.info?.withdrawalFeeRateBps ?? 0,
            minRelayFeeLamports: this.relayFeeFloor(),
            relay: this.canRelay(isSpl),
        }).toNumber();
    }
    /** What a withdrawal of `grossLamports` actually pays the recipient after fees. */
    quoteWithdraw(grossLamports, isSpl = false) {
        const gross = new BN(grossLamports);
        const fee = withdrawalFee({
            grossLamports: gross,
            withdrawalFeeRateBps: this.info?.withdrawalFeeRateBps ?? 0,
            minRelayFeeLamports: this.relayFeeFloor(),
            relay: this.canRelay(isSpl),
        });
        return {
            feeLamports: fee.toNumber(),
            recipientLamports: gross.sub(fee).toNumber(),
            minLamports: this.minWithdrawalLamports(isSpl),
        };
    }
    async init() {
        if (!this.wasm)
            this.wasm = await WasmFactory.getInstance();
        if (!this.programId || !this.info) {
            this.info = await fetchRelayerInfo();
            if (!this.programId)
                this.programId = new PublicKey(this.info.programId);
        }
    }
    /**
     * Sign In With Solana, then derive shielded spend/view keys from that signature.
     * Requires wallet `signIn` (Phantom binds `domain` to the real page). There is
     * no `signMessage` fallback — that path lets a phishing site forge the SIWS text.
     * No nonce / issuedAt — same wallet + site + cluster always yields the same key.
     */
    async unlock() {
        if (!this.signer.signIn) {
            throw new Error("wallet must support Sign In With Solana (signIn). Phantom and other Wallet Standard wallets provide this; signMessage is not accepted for unlock.");
        }
        await this.init();
        if (this.utxoKeypair)
            return;
        if (!this.unlocking) {
            this.unlocking = (async () => {
                const sig = await this.signUnlock();
                const enc = new EncryptionService();
                enc.deriveFromSignature(sig);
                this.enc = enc;
                this.utxoKeypair = new Keypair(enc.utxoPrivateKey, this.wasm);
                // Recover notes from the indexer scan (decrypted straight into memory).
                await this.syncNotes(SOL_TREE_KEY, true).catch(() => {
                    /* unlock still succeeds if indexer is briefly down */
                });
                // Hydrate from the encrypted note blob in the backend (new device / cleared browser).
                await pullEncryptedNotes(this.publicKey, this.enc).catch(() => {
                    /* restore is best-effort */
                });
                // Persist the unified in-memory note set to the encrypted backend blob.
                await this.persistNotes().catch(() => {
                    /* best-effort: indexer scan can still recover notes later */
                });
                await this.registerPrivacyKeys().catch(() => {
                    /* registry is best-effort so senders can paste a Solana address */
                });
            })();
            this.unlocking.catch(() => {
                this.unlocking = null;
            });
        }
        await this.unlocking;
    }
    /** Canonical SIWS text the wallet must sign on `unlock()`. */
    unlockMessage() {
        return buildUnlockMessage(this.siwsInput());
    }
    siwsInput() {
        // Omit chainId by default. Phantom treats a custom localhost RPC as
        // mainnet, so sending `localnet` makes it refuse to show the prompt.
        // Domain (page origin) is the phishing bind; cluster is not.
        return {
            domain: this.unlockOpts?.domain ?? defaultSiwsDomain(),
            address: this.publicKey.toBase58(),
            statement: SIWS_STATEMENT,
            uri: this.unlockOpts?.uri ?? defaultSiwsUri(),
            version: SIWS_VERSION,
            ...(this.unlockOpts?.chainId
                ? { chainId: this.unlockOpts.chainId }
                : {}),
        };
    }
    async signUnlock() {
        const signIn = this.signer.signIn;
        if (!signIn) {
            throw new Error("wallet must support Sign In With Solana (signIn). Phantom and other Wallet Standard wallets provide this; signMessage is not accepted for unlock.");
        }
        const expected = this.unlockMessage();
        const input = this.siwsInput();
        const out = await signIn({
            domain: input.domain,
            address: input.address,
            statement: input.statement,
            uri: input.uri,
            version: input.version,
            ...(input.chainId ? { chainId: input.chainId } : {}),
        });
        requireStableSiws(out.signedMessage, expected);
        return out.signature;
    }
    isUnlocked() {
        return !!this.utxoKeypair;
    }
    /** `pc1…` address: spend pubkey + X25519 viewing key. Recipients paste this to receive notes. */
    async privacyAddress() {
        await this.unlock();
        const view = await this.enc.viewingPublicKey();
        return encodePrivacyAddress(this.utxoKeypair.pubkey, view);
    }
    async registerPrivacyKeys() {
        if (!this.enc || !this.utxoKeypair)
            return;
        const view = await this.enc.viewingPublicKey();
        if (view.length !== 32) {
            throw new Error(`viewing key must be 32 bytes, got ${view.length}`);
        }
        await registerPrivacyKeys({
            wallet: this.publicKey.toBase58(),
            spendPubkey: this.utxoKeypair.pubkey.toString(),
            viewingPubkeyHex: Buffer.from(view).toString("hex"),
        });
    }
    /** Push the local note set to the backend (encrypted blob; server can't read it). */
    async backupNotes() {
        await this.unlock();
        await pushEncryptedNotes(this.publicKey, this.enc);
    }
    /** Pull + decrypt the encrypted note blob from the backend into the in-memory cache. */
    async restoreNotes() {
        await this.unlock();
        return pullEncryptedNotes(this.publicKey, this.enc);
    }
    /**
     * Best-effort: encrypt the in-memory note set and PUT it to the backend. This
     * is the single persistence path — call it after every note mutation. Failure
     * is non-fatal because `syncNotes` can always rebuild notes from the indexer.
     */
    async persistNotes() {
        if (!this.enc)
            return;
        await pushEncryptedNotes(this.publicKey, this.enc);
    }
    /** In-memory notes for the current session (decrypted; never persisted locally). */
    getNotes() {
        return loadNotes(this.publicKey);
    }
    exportNotesString() {
        return exportNotes(this.publicKey);
    }
    /** Import notes from JSON into the in-memory cache and persist to the backend. */
    async importNotesJson(json, replace = false) {
        await this.unlock();
        const n = importNotes(this.publicKey, json, replace);
        await this.persistNotes().catch(() => { });
        return n;
    }
    /** Clear all notes — wipes the in-memory cache and the encrypted backend blob. */
    async clearAllNotes() {
        await this.unlock();
        clearNotes(this.publicKey);
        await this.persistNotes().catch(() => { });
    }
    /** Unlock + rescan SOL and supported SPL trees + persist. Powers the UI "Load notes" action. */
    async refreshNotes() {
        await this.unlock();
        const acc = { scanned: 0, added: 0, spent: 0, v1Seen: 0, v1Decrypted: 0 };
        const add = (r) => {
            acc.scanned += r.scanned;
            acc.added += r.added;
            acc.spent += r.spent;
            acc.v1Seen += r.v1Seen;
            acc.v1Decrypted += r.v1Decrypted;
        };
        add(await this.syncNotes(SOL_TREE_KEY, true).catch(() => ({
            scanned: 0,
            added: 0,
            spent: 0,
            v1Seen: 0,
            v1Decrypted: 0,
        })));
        for (const m of this.info?.supportedMints ?? []) {
            add(await this.syncNotes(m.mint, true).catch(() => ({
                scanned: 0,
                added: 0,
                spent: 0,
                v1Seen: 0,
                v1Decrypted: 0,
            })));
        }
        await this.persistNotes().catch(() => { });
        return acc;
    }
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks.
     */
    async syncNotes(treeKey, fromScratch = false) {
        await this.unlock();
        const enc = this.enc;
        const wasm = this.wasm;
        const wallet = this.publicKey;
        if (fromScratch)
            resetSyncOffset(wallet, treeKey);
        let start = fromScratch ? 0 : getSyncOffset(wallet, treeKey);
        let scanned = 0;
        let added = 0;
        let spent = 0;
        let v1Seen = 0;
        let v1Decrypted = 0;
        while (true) {
            const page = await fetchUtxoRange(treeKey, start, start + RANGE_PAGE);
            for (const row of page.utxos) {
                scanned++;
                let utxo;
                const bytes = Buffer.from(row.encryptedOutputHex ?? "", "hex");
                const isV1 = bytes.length >= 8 && bytes[7] === 1;
                if (isV1)
                    v1Seen++;
                try {
                    utxo = await enc.decryptUtxo(bytes, wasm);
                    if (isV1)
                        v1Decrypted++;
                }
                catch {
                    continue; // not ours / garbage
                }
                if (utxo.amount.isZero())
                    continue;
                // Prefer leaf index from the indexer (authoritative).
                utxo.index = row.leafIndex;
                const nullifier = await utxo.getNullifier();
                const spentOnChain = await isNullifierSpent(fieldToHex32(nullifier));
                if (spentOnChain) {
                    markNoteSpentByIndex(wallet, utxo.mintAddress, utxo.index);
                    spent++;
                    continue;
                }
                const before = unspentNotes(wallet).some((n) => n.mintAddress === utxo.mintAddress && n.index === utxo.index);
                upsertNote(wallet, {
                    id: newNoteId(),
                    amount: utxo.amount.toString(),
                    blinding: utxo.blinding.toString(),
                    index: utxo.index,
                    mintAddress: utxo.mintAddress,
                    spent: false,
                    createdAt: Date.now(),
                    depositTx: row.signature,
                });
                if (!before)
                    added++;
            }
            setSyncOffset(wallet, treeKey, page.end);
            if (!page.hasMore)
                break;
            start = page.end;
        }
        return { scanned, added, spent, v1Seen, v1Decrypted };
    }
    async depositSOL(amountLamports) {
        await this.unlock();
        const treeKey = SOL_TREE_KEY;
        const onChain = await fetchTreeState(treeKey);
        const root = onChain.root;
        const nextLeafIndex = onChain.nextLeafIndex;
        const extAmount = new BN(amountLamports);
        const fee = new BN(DEPOSIT_FEE);
        const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0");
        const inputs = [
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair }),
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair }),
        ];
        const outputs = [
            new Utxo({
                wasm: this.wasm,
                amount: extAmount.sub(fee).toString(),
                keypair: this.utxoKeypair,
                index: nextLeafIndex,
                mintAddress: WRAPPED_SOL_MINT,
            }),
            new Utxo({
                wasm: this.wasm,
                amount: "0",
                keypair: this.utxoKeypair,
                index: nextLeafIndex + 1,
                mintAddress: WRAPPED_SOL_MINT,
            }),
        ];
        const enc1 = await this.enc.encryptUtxo(outputs[0]);
        const enc2 = await this.enc.encryptUtxo(outputs[1]);
        const { signature, nullifiers } = await this.proveAndSend({
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements: [dummyPath, dummyPath],
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            recipient: this.feeRecipient,
            feeRecipientForHash: this.feeRecipient,
            mintAddress: WRAPPED_SOL_MINT,
            isSpl: false,
        });
        // Persist note immediately — deposit already settled; indexer wait is best-effort.
        saveNote(this.publicKey, {
            id: newNoteId(),
            amount: outputs[0].amount.toString(),
            blinding: outputs[0].blinding.toString(),
            index: nextLeafIndex,
            mintAddress: WRAPPED_SOL_MINT,
            spent: false,
            createdAt: Date.now(),
            depositTx: signature,
        });
        await this.persistNotes().catch(() => { });
        await this.waitForLeaves(treeKey, nextLeafIndex + 1);
        return { signature, amountLamports, leafIndex: nextLeafIndex, nullifiers };
    }
    async withdrawSOL(grossLamports, recipient) {
        await this.unlock();
        const sync = await this.syncNotes(SOL_TREE_KEY, true);
        try {
            return await this.withdrawInternal({
                treeKey: SOL_TREE_KEY,
                mintAddress: WRAPPED_SOL_MINT,
                grossLamports,
                recipient: toPubkey(recipient),
                isSpl: false,
            });
        }
        catch (e) {
            throw this.rewriteSpendError(e, sync, "SOL");
        }
    }
    async depositSPL(mint, amountRaw) {
        await this.unlock();
        const mintPk = toPubkey(mint);
        const mintStr = mintPk.toBase58();
        const treeKey = mintStr;
        const onChain = await fetchTreeState(treeKey);
        const root = onChain.root;
        const nextLeafIndex = onChain.nextLeafIndex;
        const extAmount = new BN(amountRaw.toString());
        const fee = new BN(DEPOSIT_FEE);
        const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0");
        const inputs = [
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair, mintAddress: mintStr }),
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair, mintAddress: mintStr }),
        ];
        const outputs = [
            new Utxo({
                wasm: this.wasm,
                amount: extAmount.sub(fee).toString(),
                keypair: this.utxoKeypair,
                index: nextLeafIndex,
                mintAddress: mintStr,
            }),
            new Utxo({
                wasm: this.wasm,
                amount: "0",
                keypair: this.utxoKeypair,
                index: nextLeafIndex + 1,
                mintAddress: mintStr,
            }),
        ];
        const enc1 = await this.enc.encryptUtxo(outputs[0]);
        const enc2 = await this.enc.encryptUtxo(outputs[1]);
        const signerAta = getAssociatedTokenAddressSync(mintPk, this.publicKey);
        const feeAta = this.feeAta(mintPk);
        // For deposits, on-chain hashes recipient_token_account — use fee ATA (fee=0).
        const recipientAta = feeAta;
        const { signature, nullifiers } = await this.proveAndSend({
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements: [dummyPath, dummyPath],
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            recipient: this.feeRecipient,
            feeRecipientForHash: feeAta,
            mintAddress: mintStr,
            isSpl: true,
            mint: mintPk,
            signerTokenAccount: signerAta,
            recipientTokenAccount: recipientAta,
            feeRecipientAta: feeAta,
        });
        saveNote(this.publicKey, {
            id: newNoteId(),
            amount: outputs[0].amount.toString(),
            blinding: outputs[0].blinding.toString(),
            index: nextLeafIndex,
            mintAddress: mintStr,
            spent: false,
            createdAt: Date.now(),
            depositTx: signature,
        });
        await this.persistNotes().catch(() => { });
        await this.waitForLeaves(treeKey, nextLeafIndex + 1);
        return {
            signature,
            amountLamports: Number(amountRaw),
            leafIndex: nextLeafIndex,
            nullifiers,
        };
    }
    async withdrawSPL(mint, grossRaw, recipient) {
        await this.unlock();
        const mintPk = toPubkey(mint);
        const mintStr = mintPk.toBase58();
        const sync = await this.syncNotes(mintStr, true);
        try {
            return await this.withdrawInternal({
                treeKey: mintStr,
                mintAddress: mintStr,
                grossLamports: Number(grossRaw),
                recipient: toPubkey(recipient),
                isSpl: true,
                mint: mintPk,
            });
        }
        catch (e) {
            throw this.rewriteSpendError(e, sync, "SPL");
        }
    }
    getPrivateBalanceSOL() {
        return this.balanceForMint(WRAPPED_SOL_MINT);
    }
    getPrivateBalanceSPL(mint) {
        const m = mint instanceof PublicKey ? mint.toBase58() : mint;
        return this.balanceForMint(m);
    }
    /** Poll the indexer's next_leaf_index. Never throws — deposit already settled. */
    async waitForLeaves(treeKey, minLeafIndex) {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
            try {
                const st = await fetchTreeState(treeKey);
                if (st.nextLeafIndex > minLeafIndex)
                    return;
            }
            catch {
                /* keep polling */
            }
            await new Promise((r) => setTimeout(r, 750));
        }
    }
    balanceForMint(mintAddress) {
        return unspentNotes(this.publicKey)
            .filter((n) => n.mintAddress === mintAddress)
            .reduce((s, n) => s + BigInt(n.amount), 0n);
    }
    feeAta(mint) {
        const hit = this.info.supportedMints.find((m) => m.mint === mint.toBase58());
        if (hit)
            return new PublicKey(hit.feeAta);
        return getAssociatedTokenAddressSync(mint, this.feeRecipient, true);
    }
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
    async transferSOL(amountLamports, recipient) {
        await this.unlock();
        await this.syncNotes(SOL_TREE_KEY, true);
        return this.transferInternal({
            treeKey: SOL_TREE_KEY,
            mintAddress: WRAPPED_SOL_MINT,
            amount: amountLamports,
            recipient,
            isSpl: false,
        });
    }
    /**
     * Shielded SPL transfer: same as transferSOL — recipient gets a pool note,
     * not tokens in an ATA.
     */
    async transferSPL(mint, amountRaw, recipient) {
        const mintPk = toPubkey(mint);
        const mintStr = mintPk.toBase58();
        await this.unlock();
        await this.syncNotes(mintStr, true);
        return this.transferInternal({
            treeKey: mintStr,
            mintAddress: mintStr,
            amount: amountRaw,
            recipient,
            isSpl: true,
            mint: mintPk,
        });
    }
    /**
     * Private send to a PUBLIC address: deposit from the user, then withdraw to
     * the recipient. Both legs are wallet-signed. Recipient gets public SOL
     * (amount − withdrawFee); the sender's deposit is unlinkable via ZK.
     */
    async sendPrivateSOL(amountLamports, recipient) {
        await this.unlock();
        const dep = await this.depositSOL(amountLamports);
        await this.waitForNoteIndexed(SOL_TREE_KEY, dep.leafIndex);
        return this.withdrawSOL(amountLamports, recipient);
    }
    async sendPrivateSPL(mint, amountRaw, recipient) {
        const mintStr = (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBase58();
        await this.unlock();
        const dep = await this.depositSPL(mint, amountRaw);
        await this.waitForNoteIndexed(mintStr, dep.leafIndex);
        return this.withdrawSPL(mint, amountRaw, recipient);
    }
    /**
     * Jupiter quote for a private SOL↔SPL swap. Does not unlock notes.
     * `fromMint` / `outMint` are mixer mints (`WRAPPED_SOL_MINT` or an SPL mint).
     */
    async quotePrivateSwap(args) {
        await this.init();
        const fromMint = toPubkey(args.fromMint).toBase58() === NATIVE_MINT.toBase58()
            ? WRAPPED_SOL_MINT
            : toPubkey(args.fromMint).toBase58();
        const outMint = toPubkey(args.outMint).toBase58() === NATIVE_MINT.toBase58()
            ? WRAPPED_SOL_MINT
            : toPubkey(args.outMint).toBase58();
        if (isSolMixerMint(fromMint) === isSolMixerMint(outMint)) {
            throw new Error("swap is SOL ↔ SPL only");
        }
        const splMint = new PublicKey(isSolMixerMint(fromMint) ? outMint : fromMint);
        const { globalConfig } = deriveSwapAccounts(this.programId, splMint);
        const route = await fetchJupiterRoute({
            inputMint: jupiterMint(fromMint),
            outputMint: jupiterMint(outMint),
            amount: args.amountIn,
            userPublicKey: globalConfig.toBase58(),
            slippageBps: args.slippageBps,
        });
        if (!route.minOut || route.minOut === "0") {
            throw new Error("jupiter quote returned no output");
        }
        return { minOut: route.minOut, outAmount: route.outAmount };
    }
    /**
     * Atomic private swap: spend shielded notes, Jupiter CPI, reshield the output.
     * Relayer signs the v1 packet (Phantom cannot). Wallet only signs the unlock message.
     */
    async swapPrivate(args) {
        await this.unlock();
        const fromMint = toPubkey(args.fromMint).toBase58() === NATIVE_MINT.toBase58()
            ? WRAPPED_SOL_MINT
            : toPubkey(args.fromMint).toBase58();
        const outMint = toPubkey(args.outMint).toBase58() === NATIVE_MINT.toBase58()
            ? WRAPPED_SOL_MINT
            : toPubkey(args.outMint).toBase58();
        if (isSolMixerMint(fromMint) === isSolMixerMint(outMint)) {
            throw new Error("swap is SOL ↔ SPL only");
        }
        const inTreeKey = mixerTreeKey(fromMint);
        const outTreeKey = mixerTreeKey(outMint);
        await this.syncNotes(inTreeKey, true);
        const amountIn = new BN(args.amountIn.toString());
        if (amountIn.lten(0))
            throw new Error("enter a valid amount");
        const wasm = this.wasm;
        const utxoKeypair = this.utxoKeypair;
        const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0");
        const sorted = unspentNotes(this.publicKey)
            .filter((n) => n.mintAddress === fromMint)
            .sort((a, b) => Number(b.amount) - Number(a.amount));
        if (sorted.length === 0)
            throw new Error("no spendable notes for the input mint");
        let inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(amountIn.toString()));
        if (inputNotes.length === 0) {
            const a = sorted[0];
            const need = BigInt(amountIn.toString()) - BigInt(a.amount);
            const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need);
            if (!b && BigInt(a.amount) < BigInt(amountIn.toString())) {
                throw new Error(`insufficient private balance: have ${a.amount}, need ${amountIn.toString()}`);
            }
            inputNotes = b ? [a, b] : [a];
        }
        else {
            inputNotes = [inputNotes[0]];
        }
        const realInputs = inputNotes.map((n) => new Utxo({
            wasm,
            amount: n.amount,
            blinding: n.blinding,
            keypair: utxoKeypair,
            index: n.index,
            mintAddress: fromMint,
        }));
        const inputs = realInputs.length === 2
            ? realInputs
            : [
                realInputs[0],
                new Utxo({
                    wasm,
                    keypair: utxoKeypair,
                    amount: "0",
                    mintAddress: fromMint,
                }),
            ];
        const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0));
        if (amountIn.gt(totalInput)) {
            throw new Error(`insufficient private balance: have ${totalInput.toString()}, need ${amountIn.toString()}`);
        }
        const changeAmt = totalInput.sub(amountIn);
        const inMerkle = await this.merkleForSpend(inTreeKey, inputs);
        const outTree = await fetchTreeState(outTreeKey);
        const inputPathElements = inMerkle.inputPathElements;
        const splMint = new PublicKey(isSolMixerMint(fromMint) ? outMint : fromMint);
        const { globalConfig } = deriveSwapAccounts(this.programId, splMint);
        const route = await fetchJupiterRoute({
            inputMint: jupiterMint(fromMint),
            outputMint: jupiterMint(outMint),
            amount: amountIn.toString(),
            userPublicKey: globalConfig.toBase58(),
            slippageBps: args.slippageBps,
        });
        const minOut = new BN(route.minOut);
        if (minOut.lten(0))
            throw new Error("jupiter quote returned no output");
        const change = new Utxo({
            wasm,
            amount: changeAmt.toString(),
            keypair: utxoKeypair,
            index: inMerkle.nextLeafIndex,
            mintAddress: fromMint,
        });
        const dummyChange = new Utxo({
            wasm,
            amount: "0",
            keypair: utxoKeypair,
            index: inMerkle.nextLeafIndex + 1,
            mintAddress: fromMint,
        });
        const dest0 = new Utxo({
            wasm,
            amount: minOut.toString(),
            keypair: utxoKeypair,
            index: outTree.nextLeafIndex,
            mintAddress: outMint,
        });
        const dest1 = new Utxo({
            wasm,
            amount: "0",
            keypair: utxoKeypair,
            index: outTree.nextLeafIndex + 1,
            mintAddress: outMint,
        });
        const dummyOutIn = [
            new Utxo({ wasm, keypair: utxoKeypair, mintAddress: outMint }),
            new Utxo({ wasm, keypair: utxoKeypair, mintAddress: outMint }),
        ];
        const encIn1 = await this.enc.encryptUtxo(change);
        const encIn2 = await this.enc.encryptUtxo(dummyChange);
        const encOut1 = await this.enc.encryptUtxo(dest0);
        const encOut2 = await this.enc.encryptUtxo(dest1);
        const extIn = amountIn.neg();
        const outComm = [
            Uint8Array.from(parseToBytesArray([dest0.getCommitment()])[0]),
            Uint8Array.from(parseToBytesArray([dest1.getCommitment()])[0]),
        ];
        const inHash = getSwapInExtDataHash({
            extAmountIn: extIn,
            encryptedOutput1: encIn1,
            encryptedOutput2: encIn2,
            inMint: fromMint,
            outMint,
            minAmountOut: minOut,
            outCommitments: outComm,
        });
        const outHash = getSwapOutExtDataHash({
            extAmountOut: minOut,
            encryptedOutput1: encOut1,
            encryptedOutput2: encOut2,
            outMint,
        });
        const publicAmountIn = extIn.add(FIELD_SIZE).mod(FIELD_SIZE);
        const proofIn = await this.proveSwapLeg({
            root: inMerkle.root,
            inputNullifier: await Promise.all(inputs.map((n) => n.getNullifier())),
            outputCommitment: [change.getCommitment(), dummyChange.getCommitment()],
            publicAmount: publicAmountIn.toString(),
            extDataHash: inHash,
            inAmount: inputs.map((n) => n.amount.toString(10)),
            inPrivateKey: inputs.map((n) => n.keypair.privkey),
            inBlinding: inputs.map((n) => n.blinding.toString(10)),
            inPathIndices: inputs.map((n) => n.index),
            inPathElements: inputPathElements,
            outAmount: [change.amount.toString(10), dummyChange.amount.toString(10)],
            outBlinding: [change.blinding.toString(10), dummyChange.blinding.toString(10)],
            outPubkey: [change.keypair.pubkey, dummyChange.keypair.pubkey],
            mintAddress: getMintAddressField(fromMint),
        });
        const proofOut = await this.proveSwapLeg({
            root: outTree.root,
            inputNullifier: await Promise.all(dummyOutIn.map((n) => n.getNullifier())),
            outputCommitment: [dest0.getCommitment(), dest1.getCommitment()],
            publicAmount: minOut.toString(),
            extDataHash: outHash,
            inAmount: ["0", "0"],
            inPrivateKey: dummyOutIn.map((n) => n.keypair.privkey),
            inBlinding: dummyOutIn.map((n) => n.blinding.toString(10)),
            inPathIndices: [0, 0],
            inPathElements: [dummyPath, dummyPath],
            outAmount: [dest0.amount.toString(10), dest1.amount.toString(10)],
            outBlinding: [dest0.blinding.toString(10), dest1.blinding.toString(10)],
            outPubkey: [dest0.keypair.pubkey, dest1.keypair.pubkey],
            mintAddress: getMintAddressField(outMint),
        });
        const signature = await relaySwap({
            proofIn,
            proofOut,
            extAmountIn: extIn.toString(),
            extAmountOut: minOut.toString(),
            encryptedOutputIn1: encIn1,
            encryptedOutputIn2: encIn2,
            encryptedOutputOut1: encOut1,
            encryptedOutputOut2: encOut2,
            fromMint,
            outMint,
            routeData: route.routeData,
            routeAccounts: route.routeAccounts,
        });
        for (const n of inputNotes)
            markNoteSpent(this.publicKey, n.id, signature);
        if (changeAmt.gt(new BN(0))) {
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: change.amount.toString(),
                blinding: change.blinding.toString(),
                index: inMerkle.nextLeafIndex,
                mintAddress: fromMint,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
            });
        }
        saveNote(this.publicKey, {
            id: newNoteId(),
            amount: dest0.amount.toString(),
            blinding: dest0.blinding.toString(),
            index: outTree.nextLeafIndex,
            mintAddress: outMint,
            spent: false,
            createdAt: Date.now(),
            depositTx: signature,
        });
        await this.persistNotes().catch(() => { });
        await this.waitForLeaves(outTreeKey, outTree.nextLeafIndex + 1);
        return {
            signature,
            amountIn: amountIn.toString(),
            minAmountOut: minOut.toString(),
            fromMint,
            outMint,
            nullifiers: proofIn.nullifiers,
        };
    }
    async proveSwapLeg(circuitInput) {
        const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
        const pub = parseToBytesArray(publicSignals);
        return {
            proofA,
            proofB,
            proofC,
            root: pub[0],
            publicAmount: pub[1],
            extDataHash: pub[2],
            inputNullifiers: [pub[3], pub[4]],
            outputCommitments: [pub[5], pub[6]],
            nullifiers: [pub[3], pub[4]].map((b) => bytesToHex(b)),
        };
    }
    /**
     * Rebuild the Poseidon tree from every indexed leaf and take paths locally.
     **/
    async merkleForSpend(treeKey, inputs) {
        const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0");
        const deadline = Date.now() + 45_000;
        let lastErr = "merkle indexer not ready";
        // Hoisted out of the retry loop. A transient root mismatch means the indexer is
        // a few leaves behind, so the fix is to top up the delta on the next pass — not
        // to re-download and rebuild the entire tree, which is what made a brief
        // mismatch cost the whole 45-second deadline.
        let leaves = await loadCachedLeaves(treeKey).catch(() => []);
        let mirror = LocalMirror.fromLeaves(this.wasm, leaves);
        let persistedCount = leaves.length;
        while (Date.now() < deadline) {
            try {
                const onChain = await fetchTreeState(treeKey);
                if (leaves.length > onChain.nextLeafIndex) {
                    // The cache holds more leaves than the tree has, so it belongs to a
                    // different tree — a reset localnet, say. Nothing to salvage.
                    lastErr = `cached merkle mirror for ${treeKey} has ${leaves.length} leaves but the tree is at ${onChain.nextLeafIndex}; discarding it`;
                    await clearCachedLeaves(treeKey).catch(() => { });
                    leaves = [];
                    mirror = LocalMirror.fromLeaves(this.wasm, leaves);
                    persistedCount = 0;
                    continue;
                }
                if (leaves.length < onChain.nextLeafIndex) {
                    const delta = await fetchTreeLeavesFrom(treeKey, leaves.length);
                    for (const leaf of delta.leaves) {
                        mirror.insert(leaf);
                        leaves.push(leaf);
                    }
                    if (leaves.length < onChain.nextLeafIndex) {
                        lastErr = `merkle indexer is behind for ${treeKey}: indexed ${leaves.length} leaves vs on-chain next_index=${onChain.nextLeafIndex}`;
                        await sleep(800);
                        continue;
                    }
                }
                if (mirror.root() !== onChain.root) {
                    // Same leaf count but a different root means the cached leaves are wrong,
                    // not merely stale, so topping up cannot fix it. Rebuild from scratch.
                    lastErr = `merkle root mismatch for ${treeKey}: rebuilt ${leaves.length} leaves do not hash to the root the indexer reports; rebuilding`;
                    await clearCachedLeaves(treeKey).catch(() => { });
                    leaves = [];
                    mirror = LocalMirror.fromLeaves(this.wasm, leaves);
                    persistedCount = 0;
                    await sleep(800);
                    continue;
                }
                if (leaves.length > persistedCount) {
                    await saveCachedLeaves(treeKey, leaves, persistedCount).catch(() => { });
                    persistedCount = leaves.length;
                }
                const inputPathElements = [];
                for (const u of inputs) {
                    if (u.amount.gt(new BN(0))) {
                        if (u.index < 0 || u.index >= leaves.length) {
                            throw new Error(`note leaf index ${u.index} is not in the tree yet`);
                        }
                        inputPathElements.push(mirror.path(u.index));
                    }
                    else {
                        // Zero-value inputs are dummies; the circuit skips their membership check.
                        inputPathElements.push(dummyPath);
                    }
                }
                return {
                    root: onChain.root,
                    nextLeafIndex: onChain.nextLeafIndex,
                    inputPathElements,
                };
            }
            catch (e) {
                lastErr = e.message;
                await sleep(800);
            }
        }
        throw new Error(lastErr);
    }
    async resolveRecipientKeys(recipient) {
        const s = recipient.trim();
        if (!s)
            throw new Error("enter the recipient’s Solana address");
        if (isPrivacyAddress(s))
            return parsePrivacyAddress(s);
        let wallet;
        try {
            wallet = new PublicKey(s);
        }
        catch {
            throw new Error("paste the recipient’s Solana wallet address");
        }
        const hit = await lookupPrivacyKeys(wallet.toBase58());
        if (!hit) {
            throw new Error("recipient has not connected this app yet — ask them to connect and approve the sign-in once, then retry");
        }
        return {
            spendPubkey: new BN(hit.spendPubkey),
            viewingKey: this.viewingKeyFromHex(hit.viewingPubkeyHex),
        };
    }
    viewingKeyFromHex(hex) {
        const raw = Uint8Array.from(Buffer.from(hex.replace(/^0x/i, ""), "hex"));
        if (raw.length !== 32) {
            throw new Error(`invalid recipient viewing key (${raw.length} bytes)`);
        }
        return raw;
    }
    rewriteSpendError(e, sync, asset) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no spendable notes|insufficient private balance/.test(msg)) {
            return e instanceof Error ? e : new Error(msg);
        }
        if (sync.v1Seen > 0 && sync.v1Decrypted === 0) {
            return new Error(`couldn't decrypt the private ${asset} transfer — connect the exact wallet the sender paid to, then approve sign-in`);
        }
        if (/no spendable notes/.test(msg)) {
            return new Error(`no spendable private ${asset} (scanned ${sync.scanned} outputs). Use the receiving wallet and approve sign-in so the note can be decrypted.`);
        }
        return e instanceof Error ? e : new Error(msg);
    }
    /** JoinSplit with extAmount=0, fee=0: spend notes → recipient-owned pool note. */
    async transferInternal(args) {
        const wasm = this.wasm;
        const utxoKeypair = this.utxoKeypair;
        const sendAmt = new BN(args.amount.toString());
        if (sendAmt.lten(0))
            throw new Error("enter a valid amount");
        const keys = await this.resolveRecipientKeys(args.recipient);
        const destKp = Keypair.fromPubkey(keys.spendPubkey, wasm);
        const relay = this.canRelay(args.isSpl);
        if (!relay && !this.selfRelay) {
            throw new Error("this relayer cannot sign SPL transfers (it has no Address Lookup Table configured). " +
                "Enable selfRelay to transfer with your own wallet, understanding that it publishes " +
                "your wallet on-chain.");
        }
        const fee = transferFee({ minRelayFeeLamports: this.relayFeeFloor(), relay });
        const needed = sendAmt.add(fee);
        const sorted = unspentNotes(this.publicKey)
            .filter((n) => n.mintAddress === args.mintAddress)
            .sort((a, b) => Number(b.amount) - Number(a.amount));
        if (sorted.length === 0)
            throw new Error("no spendable notes");
        let inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(needed.toString()));
        if (inputNotes.length === 0) {
            const a = sorted[0];
            const need = BigInt(needed.toString()) - BigInt(a.amount);
            const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need);
            if (!b && BigInt(a.amount) < BigInt(needed.toString())) {
                throw new Error(`insufficient private balance: have ${a.amount}, need ${needed.toString()}` +
                    (fee.isZero() ? "" : ` (including a ${fee.toString()} lamport relayer fee)`));
            }
            inputNotes = b ? [a, b] : [a];
        }
        else {
            inputNotes = [inputNotes[0]];
        }
        const realInputs = inputNotes.map((n) => new Utxo({
            wasm,
            amount: n.amount,
            blinding: n.blinding,
            keypair: utxoKeypair,
            index: n.index,
            mintAddress: args.mintAddress,
        }));
        const inputs = realInputs.length === 2
            ? realInputs
            : [
                realInputs[0],
                new Utxo({
                    wasm,
                    keypair: utxoKeypair,
                    amount: "0",
                    mintAddress: args.mintAddress,
                }),
            ];
        const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0));
        if (needed.gt(totalInput)) {
            throw new Error(`insufficient private balance: have ${totalInput.toString()}, need ${needed.toString()}` +
                (fee.isZero() ? "" : ` (including a ${fee.toString()} lamport relayer fee)`));
        }
        const change = totalInput.sub(needed);
        const { root, nextLeafIndex, inputPathElements } = await this.merkleForSpend(args.treeKey, inputs);
        const outputs = [
            new Utxo({
                wasm,
                amount: sendAmt.toString(),
                keypair: destKp,
                index: nextLeafIndex,
                mintAddress: args.mintAddress,
            }),
            new Utxo({
                wasm,
                amount: change.toString(),
                keypair: utxoKeypair,
                index: nextLeafIndex + 1,
                mintAddress: args.mintAddress,
            }),
        ];
        const enc1 = await this.enc.encryptUtxo(outputs[0], keys.viewingKey);
        const enc2 = await this.enc.encryptUtxo(outputs[1]);
        const extAmount = new BN(0);
        // A transfer moves nothing out of the pool, so this account is never touched —
        // but it is still published, and it used to be the sender's own wallet. See
        // `transferRecipient` in `relay-policy.ts`.
        const neutralRecipient = transferRecipient({
            relay,
            wallet: this.publicKey,
            feeRecipient: this.feeRecipient,
        });
        let splExtras;
        let feeRecipientForHash = this.feeRecipient;
        if (args.isSpl && args.mint) {
            const mint = args.mint;
            const signerAta = getAssociatedTokenAddressSync(mint, this.publicKey);
            const feeAta = this.feeAta(mint);
            feeRecipientForHash = feeAta;
            splExtras = {
                mint,
                signerTokenAccount: signerAta,
                // Same reasoning as `neutralRecipient`: hashed and passed, but never
                // transferred to, so it must not be the sender's own token account.
                recipientTokenAccount: relay ? feeAta : signerAta,
                feeRecipientAta: feeAta,
                preIxs: relay
                    ? undefined
                    : [
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, signerAta, this.publicKey, mint),
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, feeAta, this.feeRecipient, mint),
                    ],
            };
        }
        const { signature, nullifiers } = await this.proveAndSend({
            relay,
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements,
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            recipient: neutralRecipient,
            feeRecipientForHash,
            mintAddress: args.mintAddress,
            isSpl: args.isSpl,
            ...splExtras,
        });
        for (const n of inputNotes)
            markNoteSpent(this.publicKey, n.id, signature);
        if (change.gt(new BN(0))) {
            await waitForLeafIndex(args.treeKey, nextLeafIndex + 1).catch(() => { });
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[1].amount.toString(),
                blinding: outputs[1].blinding.toString(),
                index: nextLeafIndex + 1,
                mintAddress: args.mintAddress,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
            });
        }
        await this.persistNotes().catch(() => { });
        return {
            signature,
            recipientLamports: sendAmt.toNumber(),
            feeLamports: fee.toNumber(),
            changeLamports: change.toString(),
            nullifiers,
        };
    }
    /**
     * Poll until the indexer has caught up past `leafIndex`.
     *
     * Uses the tree's leaf count rather than asking for that leaf's Merkle proof.
     * The proof request would answer the same question, but it would also tell the
     * backend which leaf the caller is about to spend, which is exactly the leak
     * `merkleForSpend` goes to the trouble of avoiding. A leaf count is the same
     * request for everyone.
     */
    async waitForNoteIndexed(treeKey, leafIndex, timeoutMs = 30_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const { nextLeafIndex } = await fetchTreeState(treeKey);
                if (nextLeafIndex > leafIndex)
                    return;
            }
            catch {
                /* indexer briefly down; the deadline is the backstop */
            }
            await sleep(1000);
        }
    }
    async withdrawInternal(args) {
        const feeBps = this.info.withdrawalFeeRateBps;
        const wasm = this.wasm;
        const utxoKeypair = this.utxoKeypair;
        const sorted = unspentNotes(this.publicKey)
            .filter((n) => n.mintAddress === args.mintAddress)
            .sort((a, b) => Number(b.amount) - Number(a.amount));
        if (sorted.length === 0)
            throw new Error("no spendable notes");
        let inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(args.grossLamports));
        if (inputNotes.length === 0) {
            const a = sorted[0];
            const need = BigInt(args.grossLamports) - BigInt(a.amount);
            const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need);
            if (!b && BigInt(a.amount) < BigInt(args.grossLamports)) {
                throw new Error(`insufficient private balance: have ${a.amount}, need ${args.grossLamports}`);
            }
            inputNotes = b ? [a, b] : [a];
        }
        else {
            inputNotes = [inputNotes[0]];
        }
        const realInputs = inputNotes.map((n) => new Utxo({
            wasm,
            amount: n.amount,
            blinding: n.blinding,
            keypair: utxoKeypair,
            index: n.index,
            mintAddress: args.mintAddress,
        }));
        const inputs = realInputs.length === 2
            ? realInputs
            : [
                realInputs[0],
                new Utxo({
                    wasm,
                    keypair: utxoKeypair,
                    amount: "0",
                    mintAddress: args.mintAddress,
                }),
            ];
        const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0));
        const gross = new BN(args.grossLamports);
        if (gross.gt(totalInput)) {
            throw new Error(`insufficient private balance: have ${totalInput.toString()}, need ${gross.toString()}`);
        }
        const relay = this.canRelay(args.isSpl);
        if (!relay && !this.selfRelay) {
            throw new Error("this relayer cannot sign SPL withdrawals (it has no Address Lookup Table configured). " +
                "Enable selfRelay to withdraw with your own wallet, understanding that it publishes " +
                "your wallet beside the recipient and amount.");
        }
        const fee = withdrawalFee({
            grossLamports: gross,
            withdrawalFeeRateBps: feeBps,
            minRelayFeeLamports: this.relayFeeFloor(),
            relay,
        });
        const recipientGets = gross.sub(fee);
        if (recipientGets.lten(0)) {
            throw new Error(`withdrawing ${gross.toString()} would not cover the ${fee.toString()} lamport fee. ` +
                `Relaying pays about ${this.relayFeeFloor().toString()} lamports of unrecoverable ` +
                `nullifier rent per spend, so the minimum worth withdrawing is ` +
                `${this.minWithdrawalLamports(args.isSpl)} (fewer, larger withdrawals are also better ` +
                `for privacy).`);
        }
        const extAmount = recipientGets.neg();
        const change = totalInput.sub(gross);
        const { root, nextLeafIndex, inputPathElements } = await this.merkleForSpend(args.treeKey, inputs);
        const outputs = [
            new Utxo({
                wasm,
                amount: change.toString(),
                keypair: utxoKeypair,
                index: nextLeafIndex,
                mintAddress: args.mintAddress,
            }),
            new Utxo({
                wasm,
                amount: "0",
                keypair: utxoKeypair,
                index: nextLeafIndex + 1,
                mintAddress: args.mintAddress,
            }),
        ];
        const enc1 = await this.enc.encryptUtxo(outputs[0]);
        const enc2 = await this.enc.encryptUtxo(outputs[1]);
        let feeRecipientForHash = this.feeRecipient;
        if (args.isSpl && args.mint)
            feeRecipientForHash = this.feeAta(args.mint);
        let splExtras;
        if (args.isSpl && args.mint) {
            const mint = args.mint;
            const recipientAta = getAssociatedTokenAddressSync(mint, args.recipient);
            const signerAta = getAssociatedTokenAddressSync(mint, this.publicKey);
            const feeAta = this.feeAta(mint);
            splExtras = {
                mint,
                signerTokenAccount: signerAta,
                recipientTokenAccount: recipientAta,
                feeRecipientAta: feeAta,
                // Only for the self-relay path. When the relayer signs it creates these
                // itself, because it is the fee payer and the wallet is deliberately absent.
                preIxs: relay
                    ? undefined
                    : [
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, recipientAta, args.recipient, mint),
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, feeAta, this.feeRecipient, mint),
                    ],
            };
        }
        const { signature, nullifiers } = await this.proveAndSend({
            relay,
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements,
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            recipient: args.recipient,
            feeRecipientForHash,
            mintAddress: args.mintAddress,
            isSpl: args.isSpl,
            ...splExtras,
        });
        for (const n of inputNotes)
            markNoteSpent(this.publicKey, n.id, signature);
        if (change.gt(new BN(0))) {
            await waitForLeafIndex(args.treeKey, nextLeafIndex).catch(() => { });
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[0].amount.toString(),
                blinding: outputs[0].blinding.toString(),
                index: nextLeafIndex,
                mintAddress: args.mintAddress,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
            });
        }
        await this.persistNotes().catch(() => { });
        return {
            signature,
            recipientLamports: recipientGets.toNumber(),
            feeLamports: fee.toNumber(),
            changeLamports: change.toString(),
            nullifiers,
        };
    }
    async proveAndSend(args) {
        const inputNullifiers = await Promise.all(args.inputs.map((x) => x.getNullifier()));
        const outputCommitments = args.outputs.map((x) => x.getCommitment());
        // SPL: program hashes recipient_token_account + fee_recipient_ata.
        const hashRecipient = args.isSpl
            ? args.recipientTokenAccount
            : args.recipient;
        const hashFeeRecipient = args.feeRecipientForHash;
        const extDataHash = getExtDataHash({
            recipient: hashRecipient,
            extAmount: args.extAmount,
            encryptedOutput1: args.encryptedOutput1,
            encryptedOutput2: args.encryptedOutput2,
            fee: args.fee,
            feeRecipient: hashFeeRecipient,
            mintAddress: args.mintAddress,
        });
        const publicAmount = args.extAmount
            .sub(args.fee)
            .add(FIELD_SIZE)
            .mod(FIELD_SIZE);
        const circuitInput = {
            root: args.root,
            inputNullifier: inputNullifiers,
            outputCommitment: outputCommitments,
            publicAmount: publicAmount.toString(),
            extDataHash,
            inAmount: args.inputs.map((x) => x.amount.toString(10)),
            inPrivateKey: args.inputs.map((x) => x.keypair.privkey),
            inBlinding: args.inputs.map((x) => x.blinding.toString(10)),
            inPathIndices: args.inputPathIndices,
            inPathElements: args.inputPathElements,
            outAmount: args.outputs.map((x) => x.amount.toString(10)),
            outBlinding: args.outputs.map((x) => x.blinding.toString(10)),
            outPubkey: args.outputs.map((x) => x.keypair.pubkey),
            mintAddress: getMintAddressField(args.mintAddress),
        };
        const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
        const pub = parseToBytesArray(publicSignals);
        const proofSubmit = {
            proofA,
            proofB,
            proofC,
            root: pub[0],
            publicAmount: pub[1],
            extDataHash: pub[2],
            inputNullifiers: [pub[3], pub[4]],
            outputCommitments: [pub[5], pub[6]],
        };
        const nullifierHexes = [pub[3], pub[4]].map((b) => bytesToHex(b));
        if (args.relay) {
            // The relayer compiles and signs, so the wallet never appears in the
            // transaction. It cannot alter any of this: every field below is hashed into
            // `extDataHash`, which the program verifies as a Groth16 public input.
            const { signature } = await relayTransact({
                proof: proofSubmit,
                extAmount: args.extAmount.toString(),
                fee: args.fee.toString(),
                encryptedOutput1: args.encryptedOutput1,
                encryptedOutput2: args.encryptedOutput2,
                recipient: args.recipient.toBase58(),
                feeRecipient: hashFeeRecipient.toBase58(),
                mint: args.mintAddress,
                isSpl: args.isSpl,
                ...(args.isSpl
                    ? { recipientTokenAccount: args.recipientTokenAccount.toBase58() }
                    : {}),
            });
            return { signature, nullifiers: nullifierHexes };
        }
        const { blockhash } = await fetchBlockhash();
        let transaction;
        if (args.isSpl) {
            const mint = args.mint;
            const alt = await ensureAlt({
                signer: this.signer,
                preferred: envAltAddress(),
                addresses: [
                    ...splAltAddresses({
                        programId: this.programId,
                        feeRecipient: this.feeRecipient,
                        mint,
                    }),
                    args.signerTokenAccount,
                    args.recipientTokenAccount,
                    args.feeRecipientAta,
                    args.recipient,
                ],
            });
            const built = await buildTransactSplTransaction({
                blockhash,
                programId: this.programId,
                signer: this.publicKey,
                isSpl: true,
                proof: proofSubmit,
                extAmount: args.extAmount,
                fee: args.fee,
                encryptedOutput1: args.encryptedOutput1,
                encryptedOutput2: args.encryptedOutput2,
                recipient: args.recipient,
                feeRecipient: this.feeRecipient,
                mint,
                signerTokenAccount: args.signerTokenAccount,
                recipientTokenAccount: args.recipientTokenAccount,
                feeRecipientAta: args.feeRecipientAta,
                preIxs: args.preIxs,
                lookupTables: [alt],
            });
            transaction = built.transaction;
        }
        else {
            const built = await buildTransactTransaction({
                blockhash,
                programId: this.programId,
                signer: this.publicKey,
                isSpl: false,
                proof: proofSubmit,
                extAmount: args.extAmount,
                fee: args.fee,
                encryptedOutput1: args.encryptedOutput1,
                encryptedOutput2: args.encryptedOutput2,
                recipient: args.recipient,
                feeRecipient: this.feeRecipient,
            });
            transaction = built.transaction;
        }
        const signed = (await this.signer.signTransaction(transaction));
        const signature = await submitTransaction(signed.serialize());
        return { signature, nullifiers: nullifierHexes };
    }
}
