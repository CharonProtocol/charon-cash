import { WasmFactory } from "@lightprotocol/hasher.rs";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, } from "@solana/spl-token";
import { PublicKey, } from "@solana/web3.js";
import BN from "bn.js";
import { envProgramId, FIELD_SIZE, MERKLE_TREE_DEPTH, RECEIVE_SIGN_MESSAGE, SIGN_MESSAGE, SOL_TREE_KEY, WRAPPED_SOL_MINT, } from "./constants";
import { EncryptionService, Keypair, Utxo, encryptUtxoTo, getExtDataHash, getMintAddressField, } from "./crypto";
import { fetchRecipientKeys } from "./recipients";
import { bytesToHex, fetchCommitmentLeaf, fetchMerkleProof, fetchMerkleSnapshot, fetchRelayerInfo, fetchBlockhash, fetchTreeState, fetchUtxoRange, fieldToHex32, isNullifierSpent, kickIndexer, nullifiersSpent, nullifierInfo, submitTransaction, relayWithdraw, waitForLeafIndex, getBackendUrl, } from "./merkle";
import { clearNotes, exportNotes, getSyncOffset, importNotes, loadNotes, markNoteSpent, markNoteUnspent, recordResolveFailure, newNoteId, purgeLegacyStorage, removeStaleNote, readLegacyNotes, resolvePendingNote, saveNote, setSyncOffset, unspentNotes, upsertNote, markNoteSpentByIndex, } from "./notes";
import { pushEncryptedNotes, pullEncryptedNotes } from "./notestore";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover";
import { buildTransactSplTransaction, buildTransactTransaction, } from "./program";
import { ensureAlt, envAltAddress, splAltAddresses, } from "./alt";
/**
 * Split a deposit into two self-notes (⌊total/2⌋ + remainder) so a wide
 * payroll fan-out starts from two lane-worthy notes and skips one halving
 * wave. The circuit only checks that the outputs sum to ext − fee, which
 * holds for any split; both halves must be > 0 to be spendable notes.
 */
export function splitDepositAmounts(extAmount, fee) {
    const total = extAmount.sub(fee);
    if (total.ltn(2))
        throw new Error("split deposit needs a total of at least 2 (ext − fee)");
    const half = total.div(new BN(2));
    return { half, rem: total.sub(half) };
}
/**
 * The trees one refreshNotes pass scans. Discovery (no `quick`) sweeps the
 * SOL tree plus every supported mint's tree: a recipient of a shielded SPL
 * transfer has no local hint about the mint. A mid-run `quick` poll scans
 * only the tree the caller names — the engine knows which mint it is
 * paying, and change notes land in that tree alone.
 */
export function refreshTreeKeys(opts, supportedMints) {
    if (opts?.quick)
        return [opts.quick];
    return [SOL_TREE_KEY, ...(supportedMints ?? []).map((m) => m.mint)];
}
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
export function shouldRecheckSpent(opts, lastSpentRecheckAt, now) {
    if (opts?.fromScratch || opts?.quick)
        return false;
    return Boolean(opts?.recheckSpent) || now - lastSpentRecheckAt > 15_000;
}
const DEPOSIT_FEE = 0;
// Resolve windows that may fail before a pending change note stops being
// polled and is dropped as a phantom (see resolveChangeNote).
const RESOLVE_MAX_FAILURES = 6;
// D1 bills rows READ per page request: a 2000-wide page made every routine
// sync burn thousands of billed rows for a handful of leaves (the free tier
// died mid-day after ten 100-row runs). 128 keeps fromScratch scans at the
// same total reads (leaf count) while the common incremental pass costs
// almost nothing.
const RANGE_PAGE = 128;
function toPubkey(value) {
    return value instanceof PublicKey ? value : new PublicKey(value);
}
/**
 * Root + sibling paths for every spendable input, guaranteed same-snapshot.
 * Fast path: the /merkle snapshot endpoint serves the root and ALL input paths
 * from ONE mirror read — fetching each input's proof separately is what let a
 * mirror sync commit land between requests and hand back paths that disagreed
 * on the root (the 15:05Z run lost 28 rows × 3 attempts to exactly that:
 * "merkle proofs did not converge on one root" while sync wave trains rolled).
 * A missing leaf (sync cursor behind) is labeled as such and kicks the indexer
 * instead of being misread as churn. The per-leaf loop stays as the fallback
 * for backends that predate the snapshot route (404).
 */
async function convergedMerkleInputs(treeKey, inputs) {
    const spendable = inputs.filter((u) => u.amount.gt(new BN(0)));
    const zeroes = new Array(MERKLE_TREE_DEPTH).fill("0");
    // One request carries every input; the backend answers proofs sorted+deduped
    // by leaf index, so zip them back positionally.
    const idxs = [...new Set(spendable.map((u) => u.index))].sort((a, b) => a - b);
    const deadline = Date.now() + 24 * 250;
    let missingList = [];
    for (let round = 0;; round++) {
        try {
            const snap = await fetchMerkleSnapshot(treeKey, idxs);
            if (snap === null)
                break; // legacy backend — use the per-leaf loop
            if (snap.missing.length === 0 && snap.proofs.length === idxs.length) {
                const byIndex = new Map();
                idxs.forEach((idx, i) => byIndex.set(idx, snap.proofs[i]));
                return {
                    root: snap.root,
                    nextLeafIndex: snap.nextLeafIndex,
                    inputPathElements: inputs.map((u) => u.amount.gt(new BN(0)) ? byIndex.get(u.index).pathElements : zeroes),
                };
            }
            missingList = snap.missing;
        }
        catch {
            // transient 5xx / server torn-read guard — retry inside the window
        }
        if (Date.now() >= deadline)
            break;
        if (missingList.length > 0)
            await kickIndexer();
        await new Promise((r) => setTimeout(r, 250));
    }
    if (missingList.length > 0) {
        throw new Error(`merkle mirror has not indexed input leaf(s) ${missingList.join(", ")} yet — indexer kicked`);
    }
    // Per-leaf fallback (older backends): all served roots must agree, else
    // retry, else give up — the old failure mode this helper exists to avoid.
    for (let round = 0;; round++) {
        let fetched = null;
        try {
            fetched = await Promise.all(spendable.map((u) => fetchMerkleProof(treeKey, u.index)));
        }
        catch {
            fetched = null;
        }
        const real = fetched;
        if (real && real.length > 0 && new Set(real.map((p) => p.root)).size === 1) {
            let k = 0;
            return {
                root: real[0].root,
                nextLeafIndex: real[0].nextLeafIndex,
                inputPathElements: inputs.map((u) => u.amount.gt(new BN(0)) ? real[k++].pathElements : zeroes),
            };
        }
        if (round >= 23) {
            throw new Error("merkle proofs did not converge on one root");
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}
export class PrivacyCashClient {
    signer;
    wasm;
    enc;
    utxoKeypair;
    programId;
    info;
    unlocking = null;
    constructor(signer, programId) {
        this.signer = signer;
        this.programId = programId ?? envProgramId() ?? undefined;
    }
    get publicKey() {
        return this.signer.publicKey;
    }
    get feeRecipient() {
        return new PublicKey(this.info.feeRecipient);
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
    /** Prompt wallet to sign the constant message; derive the note keypair. */
    async unlock() {
        await this.init();
        if (this.utxoKeypair)
            return;
        if (!this.unlocking) {
            this.unlocking = (async () => {
                const sig = await this.signer.signMessage(new TextEncoder().encode(SIGN_MESSAGE));
                const receiveSig = await this.signer.signMessage(new TextEncoder().encode(RECEIVE_SIGN_MESSAGE));
                const enc = new EncryptionService();
                enc.deriveFromSignature(sig, receiveSig);
                this.enc = enc;
                this.utxoKeypair = new Keypair(enc.utxoPrivateKey, this.wasm);
                // One-time migration: move any legacy plaintext notes out of localStorage
                // into the encrypted backend store, then purge them from disk so no
                // spending secret lingers locally. No-op outside the browser.
                for (const n of readLegacyNotes(this.publicKey))
                    upsertNote(this.publicKey, n);
                purgeLegacyStorage(this.publicKey);
                // Recover notes from the indexer scan (decrypted straight into memory).
                await this.syncNotes(SOL_TREE_KEY).catch(() => {
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
            })();
        }
        await this.unlocking;
    }
    isUnlocked() {
        return !!this.utxoKeypair;
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
    persistRunning = null;
    persistAgain = false;
    /**
     * Coalesced, non-blocking backup of the encrypted note set: at most one
     * upload in flight plus one trailing. Payout paths used to await a full
     * re-encrypt + PUT of every note after each relay and each change-note
     * resolve, which sat on the lane's critical path; the notes stay in memory
     * and are recoverable from the chain, so nothing needs to wait on it.
     */
    schedulePersist() {
        if (this.persistRunning) {
            this.persistAgain = true;
            return;
        }
        this.persistRunning = (async () => {
            do {
                this.persistAgain = false;
                await this.persistNotes().catch(() => { });
            } while (this.persistAgain);
        })().finally(() => {
            this.persistRunning = null;
        });
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
    /** Unlock + rescan + persist. Powers the UI "Load notes" action. */
    async refreshNotes(opts) {
        await this.unlock();
        const trees = refreshTreeKeys(opts, this.info?.supportedMints);
        let scanned = 0;
        let added = 0;
        let spent = 0;
        for (const treeKey of trees) {
            const r = await this.syncNotes(treeKey, opts?.fromScratch ?? false).catch(() => ({
                scanned: 0,
                added: 0,
                spent: 0,
            }));
            scanned += r.scanned;
            added += r.added;
            spent += r.spent;
        }
        if (shouldRecheckSpent(opts, this.lastSpentRecheckAt, Date.now())) {
            this.lastSpentRecheckAt = Date.now();
            // The incremental scan only re-checks nullifiers for leaves it just
            // decrypted, so a note spent on-chain by a cancelled run's landed-but-
            // unadjudicated payout would stay spendable locally forever — the
            // phantom balance that under-sized the next run's deposit. One batch
            // call re-checks every unspent note. Ambient refreshes pay this at
            // most once per 15s (deriving N nullifiers is real CPU on big vaults
            // and it starved the provers mid-run); `recheckSpent` forces it for
            // run-start verification; `quick` mid-run polls never pay it.
            // Bounded to the 64 biggest notes: deriving a nullifier per note is
            // real CPU on vaults grown by repeated runs, and a phantom that can
            // under-size a deposit materially is by definition a big one. The
            // engine's mid-run top-up backstops any smaller residue.
            const mine = unspentNotes(this.publicKey)
                .slice()
                .sort((a, b) => Number(b.amount) - Number(a.amount))
                .slice(0, 64);
            if (mine.length > 0) {
                try {
                    const hashes = await this.nullifiersForNotes(mine.map((n) => ({
                        amount: n.amount,
                        blinding: n.blinding,
                        index: n.index,
                        mintAddress: n.mintAddress,
                    })));
                    const flags = await this.spentFlags(hashes);
                    for (let i = 0; i < mine.length; i++) {
                        if (flags[i]) {
                            markNoteSpentByIndex(this.publicKey, mine[i].mintAddress, mine[i].index);
                            spent++;
                        }
                    }
                }
                catch {
                    // spent-status re-check is best-effort; the scan result stands
                }
            }
            // Mirror-image reconciliation: the transfer path burns notes at
            // relay-accept, but a tx that lands and FAILS execution never
            // consumed its nullifiers — those notes stay hidden from every
            // cursor-forward scan (it only visits new leaves), the balance
            // silently loses their value, and the next run's top-up re-inflates
            // the treasury. Restore the provably-unspent ones, most recent burns
            // first. A genuinely spent note's nullifier is on the chain, so this
            // can never resurrect a real spend.
            const restoreDue = Boolean(opts?.recheckSpent) ||
                Date.now() - this.lastRestoreRecheckAt > 600_000;
            if (restoreDue) {
                this.lastRestoreRecheckAt = Date.now();
                const burned = loadNotes(this.publicKey)
                    .filter((n) => n.spent && n.index >= 0 && !n.pending)
                    .sort((a, b) => b.index - a.index)
                    .slice(0, 128);
                if (burned.length > 0) {
                    try {
                        const hashes = await this.nullifiersForNotes(burned.map((n) => ({
                            amount: n.amount,
                            blinding: n.blinding,
                            index: n.index,
                            mintAddress: n.mintAddress,
                        })));
                        const flags = await this.spentFlags(hashes);
                        for (let i = 0; i < burned.length; i++) {
                            if (!flags[i])
                                markNoteUnspent(this.publicKey, burned[i].id);
                        }
                    }
                    catch {
                        // restore is best-effort; the scan result stands
                    }
                }
            }
        }
        this.schedulePersist();
        return { scanned, added, spent };
    }
    /**
     * Nullifiers (32-byte hex) for saved notes, derived under the unlocked
     * keypair. A caller that lost track of a broadcast (relay answered but the
     * follow-up threw) polls these to learn whether the spend actually landed
     * before attempting any retry. Notes whose index is only a guess (freshly
     * saved change notes) yield a wrong nullifier — those are simply never
     * reported spent, which is the safe direction.
     */
    async nullifiersForNotes(notes) {
        await this.unlock();
        const out = [];
        for (const n of notes) {
            const utxo = new Utxo({
                wasm: this.wasm,
                amount: n.amount,
                blinding: n.blinding,
                keypair: this.utxoKeypair,
                index: n.index,
                ...(n.mintAddress ? { mintAddress: n.mintAddress } : {}),
            });
            out.push(fieldToHex32(await utxo.getNullifier()));
        }
        return out;
    }
    /**
     * Spent flags through one path: the batch endpoint (which retries
     * in-place). The per-hex fallback is capped — it used to fan out per
     * leaf, so one saturated window produced hundreds of singular calls that
     * deepened the saturation; past the cap this throws and the caller skips
     * the pass instead.
     */
    async spentFlags(hashes) {
        try {
            return await nullifiersSpent(hashes);
        }
        catch (e) {
            if (hashes.length > 16)
                throw e;
            return Promise.all(hashes.map((h) => isNullifierSpent(h)));
        }
    }
    /**
     * Adjudication for a transfer that threw after the relay accepted it: look
     * up the named notes (by blinding, across spent AND unspent storage) and
     * return the spending tx signature if any of their nullifiers is already
     * recorded. Resolves in one batch call when the mirror has caught up;
     * callers poll with a short interval until it returns non-null or they
     * give up. Notes whose stored index is a guess (pending change notes)
     * hash to a nullifier that can never match — the safe direction.
     */
    async signatureIfSpent(blindings) {
        await this.unlock();
        const picked = loadNotes(this.publicKey).filter((n) => blindings.includes(n.blinding));
        if (picked.length === 0)
            return null;
        const hashes = await this.nullifiersForNotes(picked.map((n) => ({
            amount: n.amount,
            blinding: n.blinding,
            index: n.index,
            mintAddress: n.mintAddress,
        })));
        const flags = await this.spentFlags(hashes);
        for (let i = 0; i < hashes.length; i++) {
            if (!flags[i])
                continue;
            const info = await nullifierInfo(hashes[i]).catch(() => null);
            return info?.signature ?? null;
        }
        return null;
    }
    /**
     * Chain-truth restore for notes burned at relay-accept whose tx later
     * failed execution: a nullifier absent from the chain means the note was
     * never consumed, so it re-enters the spendable set. Notes whose stored
     * index is a guess (pending) hash to a nullifier that can never match —
     * they are skipped rather than restored on a false negative.
     */
    async markNotesUnspent(blindings) {
        if (!this.publicKey || blindings.length === 0)
            return 0;
        await this.unlock();
        const picked = loadNotes(this.publicKey).filter((n) => blindings.includes(n.blinding) &&
            n.spent &&
            n.index >= 0 &&
            !n.pending);
        if (picked.length === 0)
            return 0;
        const hashes = await this.nullifiersForNotes(picked.map((n) => ({
            amount: n.amount,
            blinding: n.blinding,
            index: n.index,
            mintAddress: n.mintAddress,
        })));
        const flags = await this.spentFlags(hashes);
        let restored = 0;
        picked.forEach((n, i) => {
            if (!flags[i]) {
                markNoteUnspent(this.publicKey, n.id);
                restored++;
            }
        });
        return restored;
    }
    /**
     * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
     * and mark spent via nullifier checks. Single-flight: a scan mutates the
     * note store, and a second scan running mid-transfer made pinned notes
     * vanish from the spendable set (the third 100-run failed 9 rows this
     * way) — concurrent callers now queue behind the running scan.
     */
    syncQueue = Promise.resolve();
    // Completion time of the last sync per tree, plus the pre-spend sync
    // guard: every parallel lane used to queue behind the single-flight sync
    // before building its tx (12 lanes × scan time ≈ the measured 6s prep per
    // payout). One sync per 1.5s window is fresh enough — the pin check still
    // validates against the live set, and the NULLIFIER_SPENT error paths
    // still force a fromScratch rescan.
    lastSyncDoneAt = new Map();
    // The 15s gate for refreshNotes' spent-status re-check (see refreshNotes).
    lastSpentRecheckAt = 0;
    // Throttle for refreshNotes' reverse reconciliation (wrongly-burned note
    // restore). Forced at every run start (`recheckSpent`); ambient refreshes
    // pay it at most once per 10 minutes.
    lastRestoreRecheckAt = 0;
    async syncForSpend(treeKey) {
        if (Date.now() - (this.lastSyncDoneAt.get(treeKey) ?? 0) > 1_500) {
            await this.syncNotes(treeKey).catch(() => { });
        }
    }
    async syncNotes(treeKey, fromScratch = false) {
        const run = this.syncQueue.then(() => this.syncNotesLocked(treeKey, fromScratch));
        this.syncQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    async syncNotesLocked(treeKey, fromScratch = false) {
        await this.unlock();
        const enc = this.enc;
        const wasm = this.wasm;
        const wallet = this.publicKey;
        // Keep a small reorder window below the cursor: concurrent transactions
        // can index out of order, so a leaf can appear in the indexer AFTER the
        // cursor moved past it — the cursor would then skip it forever and the
        // money in that note would go invisible (the 100-run stranded ~10M
        // lamports of change notes this way). Re-scanning 32 leaves per pass is
        // cheap; upserts are idempotent by leaf index.
        const SYNC_OVERLAP = 32;
        let start = fromScratch ? 0 : Math.max(0, getSyncOffset(wallet, treeKey) - SYNC_OVERLAP);
        let scanned = 0;
        let added = 0;
        let spent = 0;
        let lastScannedTo = -1;
        let pass = 0;
        for (;;) {
            if (++pass > 128)
                break; // bounded against a misbehaving server
            const page = await fetchUtxoRange(treeKey, start, start + RANGE_PAGE);
            if (pass === 1 && !fromScratch && page.utxos.length === 0 && page.nextIndex < start) {
                // stored offset beyond the tree: the indexer was reset (devnet or D1
                // wipe) — rescan from zero instead of seeing an empty vault
                start = 0;
                continue;
            }
            // Decrypt in parallel CPU-only chunks (no backend round trips), check
            // spent status for the whole page in one batch call, then apply. The
            // per-note lookup version paid a round trip per note — that plus the
            // read-path lazy sync was the multi-minute unlock.
            const CHUNK = 32;
            const found = [];
            for (let i = 0; i < page.utxos.length; i += CHUNK) {
                await Promise.all(page.utxos.slice(i, i + CHUNK).map(async (row) => {
                    scanned++;
                    try {
                        const bytes = Buffer.from(row.encryptedOutputHex, "hex");
                        const utxo = await enc.decryptUtxo(bytes, wasm);
                        if (utxo.amount.isZero())
                            return;
                        // Prefer leaf index from the indexer (authoritative).
                        utxo.index = row.leafIndex;
                        const nullifier = await utxo.getNullifier();
                        found.push({ row, utxo, nullifierHex: fieldToHex32(nullifier) });
                    }
                    catch {
                        return; // not ours / garbage
                    }
                }));
            }
            // Batch endpoint with in-place retries; the per-hex fallback is
            // capped at 16 by spentFlags so a saturated window can't storm the
            // singular route with hundreds of calls.
            const spentFlags = await this.spentFlags(found.map((f) => f.nullifierHex));
            for (let i = 0; i < found.length; i++) {
                const { row, utxo } = found[i];
                if (spentFlags[i]) {
                    markNoteSpentByIndex(wallet, utxo.mintAddress, utxo.index);
                    spent++;
                    continue;
                }
                const before = unspentNotes(wallet).some((n) => n.mintAddress === utxo.mintAddress && n.index === utxo.index);
                removeStaleNote(wallet, utxo.mintAddress, utxo.amount.toString(), utxo.blinding.toString(), utxo.index);
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
            // Advance the cursor to the highest leaf actually returned (+1), never
            // to the tree tip: leaves appended mid-scan sit below the tip and are
            // picked up by the next pass instead of being skipped forever.
            const scannedTo = page.utxos.length
                ? page.utxos[page.utxos.length - 1].leafIndex + 1
                : start;
            setSyncOffset(wallet, treeKey, scannedTo);
            const caughtUp = !page.hasMore && page.nextIndex <= scannedTo;
            if (caughtUp)
                break;
            // climb with the reorder window still open
            const nextStart = Math.max(0, scannedTo - SYNC_OVERLAP);
            const progressed = scannedTo > lastScannedTo || nextStart > start;
            if (!progressed)
                break;
            lastScannedTo = scannedTo;
            start = nextStart;
        }
        this.lastSyncDoneAt.set(treeKey, Date.now());
        return { scanned, added, spent };
    }
    /**
     * Recover the true leaf index of a just-landed output note (a deposit, or
     * the change of a transfer). The pre-send `nextLeafIndex` is only a guess:
     * concurrent transactions can append ahead of ours before it confirms.
     * Decrypt the window around the guess and match the note's blinding factor.
     * Returns -1 if not found within the deadline — callers must then save the
     * note as `pending` (never spendable at the guessed index; syncNotes heals
     * it authoritatively on the next scan).
     */
    async locateNoteLeaf(treeKey, guessIndex, note) {
        const deadline = Date.now() + 60_000;
        const start = Math.max(0, guessIndex - 2);
        let end = start + 16;
        while (Date.now() < deadline) {
            const page = await fetchUtxoRange(treeKey, start, end).catch(() => null);
            if (page) {
                for (const row of page.utxos) {
                    try {
                        const utxo = await this.enc.decryptUtxo(Buffer.from(row.encryptedOutputHex, "hex"), this.wasm);
                        if (utxo.blinding.eq(note.blinding))
                            return row.leafIndex;
                    }
                    catch {
                        // not our note
                    }
                }
            }
            end += 16;
            await new Promise((r) => setTimeout(r, 400));
        }
        return -1;
    }
    async depositSOL(amountLamports, opts) {
        await this.unlock();
        const treeKey = SOL_TREE_KEY;
        const onChain = await fetchTreeState(treeKey);
        const root = onChain.root;
        const nextLeafIndex = onChain.nextLeafIndex;
        const extAmount = new BN(amountLamports);
        const fee = new BN(DEPOSIT_FEE);
        const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0");
        // Unsplit: output 0 takes the whole total and output 1 is the empty dummy
        // — amounts identical to the pre-split behavior.
        const { half, rem } = opts?.split === true
            ? splitDepositAmounts(extAmount, fee)
            : { half: extAmount.sub(fee), rem: new BN(0) };
        const inputs = [
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair }),
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair }),
        ];
        const outputs = [
            new Utxo({
                wasm: this.wasm,
                amount: half.toString(),
                keypair: this.utxoKeypair,
                index: nextLeafIndex,
                mintAddress: WRAPPED_SOL_MINT,
            }),
            new Utxo({
                wasm: this.wasm,
                amount: rem.toString(),
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
        // Persist note immediately — deposit already settled; indexer wait is
        // best-effort. Pending: index is the pre-send guess, not spendable until
        // located/scanned.
        saveNote(this.publicKey, {
            id: newNoteId(),
            amount: outputs[0].amount.toString(),
            blinding: outputs[0].blinding.toString(),
            index: nextLeafIndex,
            mintAddress: WRAPPED_SOL_MINT,
            spent: false,
            createdAt: Date.now(),
            depositTx: signature,
            pending: true,
        });
        if (rem.gtn(0)) {
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[1].amount.toString(),
                blinding: outputs[1].blinding.toString(),
                index: nextLeafIndex + 1,
                mintAddress: WRAPPED_SOL_MINT,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
                pending: true,
            });
        }
        await this.persistNotes().catch(() => { });
        await this.waitForLeaves(treeKey, nextLeafIndex + 1);
        const leafIndex = await this.locateNoteLeaf(treeKey, nextLeafIndex, outputs[0]);
        // Un-pend on every confirmed locate, even when the pre-send guess was
        // exact: the note is stored pending and unspentNotes holds pending notes
        // out, so skipping the upsert would hide the deposit until some later
        // scan happens to rescue it.
        if (leafIndex >= 0) {
            removeStaleNote(this.publicKey, WRAPPED_SOL_MINT, outputs[0].amount.toString(), outputs[0].blinding.toString(), nextLeafIndex);
            upsertNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[0].amount.toString(),
                blinding: outputs[0].blinding.toString(),
                index: leafIndex,
                mintAddress: WRAPPED_SOL_MINT,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
            });
            // The two outputs of one deposit land as adjacent leaves of the same
            // transact (append_many), so the second note sits at leafIndex + 1.
            if (rem.gtn(0)) {
                removeStaleNote(this.publicKey, WRAPPED_SOL_MINT, outputs[1].amount.toString(), outputs[1].blinding.toString(), nextLeafIndex + 1);
                upsertNote(this.publicKey, {
                    id: newNoteId(),
                    amount: outputs[1].amount.toString(),
                    blinding: outputs[1].blinding.toString(),
                    index: leafIndex + 1,
                    mintAddress: WRAPPED_SOL_MINT,
                    spent: false,
                    createdAt: Date.now(),
                    depositTx: signature,
                });
            }
            await this.persistNotes().catch(() => { });
        }
        return {
            signature,
            amountLamports,
            leafIndex,
            nullifiers,
            notes: rem.gtn(0)
                ? [
                    {
                        amount: outputs[0].amount.toString(),
                        blinding: outputs[0].blinding.toString(),
                        leafIndex,
                    },
                    {
                        amount: outputs[1].amount.toString(),
                        blinding: outputs[1].blinding.toString(),
                        leafIndex: leafIndex >= 0 ? leafIndex + 1 : -1,
                    },
                ]
                : undefined,
        };
    }
    async withdrawSOL(grossLamports, recipient, opts) {
        await this.unlock();
        await this.syncForSpend(SOL_TREE_KEY);
        try {
            return await this.withdrawInternal({
                treeKey: SOL_TREE_KEY,
                mintAddress: WRAPPED_SOL_MINT,
                grossLamports,
                recipient: toPubkey(recipient),
                isSpl: false,
                relay: opts?.relay,
                inputNotes: opts?.inputNotes,
            });
        }
        catch (e) {
            // A spent nullifier means the local note set is stale (the note was
            // spent elsewhere); rebuild it from scratch so the next attempt
            // selects fresh inputs.
            if (String(e).includes("NULLIFIER_SPENT")) {
                await this.syncNotes(SOL_TREE_KEY, true).catch(() => { });
            }
            throw e;
        }
    }
    /**
     * Shielded transfer: pay `netLamports` as a note only the recipient can spend.
     * ext=0 (no public SOL moves); the relayer fee comes out of the sender's notes.
     */
    async transferNoteSOL(recipient, netLamports, opts) {
        await this.unlock();
        await this.syncForSpend(SOL_TREE_KEY);
        return this.transferNoteInternal({
            treeKey: SOL_TREE_KEY,
            mintAddress: WRAPPED_SOL_MINT,
            recipient: toPubkey(recipient),
            netLamports,
            isSpl: false,
            relay: opts?.relay,
            onSubmitted: opts?.onSubmitted,
            inputNote: opts?.inputNote,
            inputNotes: opts?.inputNotes,
        });
    }
    /** SPL twin of transferNoteSOL on a registered mint's tree. */
    async transferNoteSPL(mint, recipient, netRaw, opts) {
        await this.unlock();
        const mintPk = toPubkey(mint);
        await this.syncForSpend(mintPk.toBase58());
        return this.transferNoteInternal({
            treeKey: mintPk.toBase58(),
            mintAddress: mintPk.toBase58(),
            recipient: toPubkey(recipient),
            netLamports: netRaw,
            isSpl: true,
            mint: mintPk,
            relay: opts?.relay,
            onSubmitted: opts?.onSubmitted,
            inputNote: opts?.inputNote,
            inputNotes: opts?.inputNotes,
        });
    }
    async depositSPL(mint, amountRaw, opts) {
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
        // Unsplit: output 0 takes the whole total and output 1 is the empty dummy
        // — amounts identical to the pre-split behavior.
        const { half, rem } = opts?.split === true
            ? splitDepositAmounts(extAmount, fee)
            : { half: extAmount.sub(fee), rem: new BN(0) };
        const inputs = [
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair, mintAddress: mintStr }),
            new Utxo({ wasm: this.wasm, keypair: this.utxoKeypair, mintAddress: mintStr }),
        ];
        const outputs = [
            new Utxo({
                wasm: this.wasm,
                amount: half.toString(),
                keypair: this.utxoKeypair,
                index: nextLeafIndex,
                mintAddress: mintStr,
            }),
            new Utxo({
                wasm: this.wasm,
                amount: rem.toString(),
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
            pending: true,
        });
        if (rem.gtn(0)) {
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[1].amount.toString(),
                blinding: outputs[1].blinding.toString(),
                index: nextLeafIndex + 1,
                mintAddress: mintStr,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
                pending: true,
            });
        }
        await this.persistNotes().catch(() => { });
        await this.waitForLeaves(treeKey, nextLeafIndex + 1);
        const leafIndex = await this.locateNoteLeaf(treeKey, nextLeafIndex, outputs[0]);
        // Un-pend on every confirmed locate, even when the pre-send guess was
        // exact: the note is stored pending and unspentNotes holds pending notes
        // out, so skipping the upsert would hide the deposit until some later
        // scan happens to rescue it.
        if (leafIndex >= 0) {
            removeStaleNote(this.publicKey, mintStr, outputs[0].amount.toString(), outputs[0].blinding.toString(), nextLeafIndex);
            upsertNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[0].amount.toString(),
                blinding: outputs[0].blinding.toString(),
                index: leafIndex,
                mintAddress: mintStr,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
            });
            // The two outputs of one deposit land as adjacent leaves of the same
            // transact (append_many), so the second note sits at leafIndex + 1.
            if (rem.gtn(0)) {
                removeStaleNote(this.publicKey, mintStr, outputs[1].amount.toString(), outputs[1].blinding.toString(), nextLeafIndex + 1);
                upsertNote(this.publicKey, {
                    id: newNoteId(),
                    amount: outputs[1].amount.toString(),
                    blinding: outputs[1].blinding.toString(),
                    index: leafIndex + 1,
                    mintAddress: mintStr,
                    spent: false,
                    createdAt: Date.now(),
                    depositTx: signature,
                });
            }
            await this.persistNotes().catch(() => { });
        }
        return {
            signature,
            amountLamports: Number(amountRaw),
            leafIndex,
            nullifiers,
            notes: rem.gtn(0)
                ? [
                    {
                        amount: outputs[0].amount.toString(),
                        blinding: outputs[0].blinding.toString(),
                        leafIndex,
                    },
                    {
                        amount: outputs[1].amount.toString(),
                        blinding: outputs[1].blinding.toString(),
                        leafIndex: leafIndex >= 0 ? leafIndex + 1 : -1,
                    },
                ]
                : undefined,
        };
    }
    async withdrawSPL(mint, grossRaw, recipient, opts) {
        await this.unlock();
        const mintPk = toPubkey(mint);
        const mintStr = mintPk.toBase58();
        await this.syncForSpend(mintStr);
        try {
            return await this.withdrawInternal({
                treeKey: mintStr,
                mintAddress: mintStr,
                grossLamports: Number(grossRaw),
                recipient: toPubkey(recipient),
                isSpl: true,
                mint: mintPk,
                relay: opts?.relay,
                inputNotes: opts?.inputNotes,
            });
        }
        catch (e) {
            // Same stale-note-set recovery as withdrawSOL.
            if (String(e).includes("NULLIFIER_SPENT")) {
                await this.syncNotes(mintStr, true).catch(() => { });
            }
            throw e;
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
        let prev = -1;
        while (Date.now() < deadline) {
            try {
                const st = await fetchTreeState(treeKey);
                if (st.nextLeafIndex > minLeafIndex)
                    return;
                if (st.nextLeafIndex === prev) {
                    // The mirror is lazy (the backend cron walks the chain ~once a
                    // minute): a fresh deposit would idle here for up to a minute —
                    // the measured 46s "Sign & deposit" on every run. Ask the indexer
                    // to sync now; the backend throttle bounds repeat kicks.
                    await fetch(getBackendUrl() + "/api/indexer/kick", { method: "POST" }).catch(() => { });
                }
                prev = st.nextLeafIndex;
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
     * Private transfer: spend a private note to pay another address. Mechanically a
     * withdraw to `recipient` — your deposit stays unlinked (proven via ZK), and the
     * recipient receives public SOL at their address. Honors the same { relay } option
     * as withdraw (default true = gasless relayer-signed).
     */
    async transferSOL(amountLamports, recipient, opts) {
        return this.withdrawSOL(amountLamports, recipient, opts);
    }
    /**
     * Private SPL transfer: spend a private SPL note to pay another address (their
     * ATA is created idempotently). Same mechanics/privacy as transferSOL.
     */
    async transferSPL(mint, amountRaw, recipient, opts) {
        return this.withdrawSPL(mint, amountRaw, recipient, opts);
    }
    /**
     * Private send to a PUBLIC address (Mode A): deposit fresh from the user, then
     * withdraw-to-recipient gaslessly via the relayer (relay=true). The user signs +
     * pays the deposit; the relayer signs the withdraw. Recipient gets public SOL/SPL
     * (amount − withdrawFee) at their address; the sender's deposit is unlinkable to
     * it via ZK. (deposit can never be gasless — the signer is who puts funds in.)
     */
    async sendPrivateSOL(amountLamports, recipient, opts) {
        await this.unlock();
        const dep = await this.depositSOL(amountLamports);
        await this.waitForNoteIndexed(SOL_TREE_KEY, dep.leafIndex);
        return this.withdrawSOL(amountLamports, recipient, { relay: true, ...opts });
    }
    async sendPrivateSPL(mint, amountRaw, recipient, opts) {
        const mintStr = (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBase58();
        await this.unlock();
        const dep = await this.depositSPL(mint, amountRaw);
        await this.waitForNoteIndexed(mintStr, dep.leafIndex);
        return this.withdrawSPL(mint, amountRaw, recipient, { relay: true, ...opts });
    }
    /** Poll until the indexer can serve a Merkle proof for `leafIndex` (mirror caught up). */
    async waitForNoteIndexed(treeKey, leafIndex, timeoutMs = 30_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                await fetchMerkleProof(treeKey, leafIndex);
                return;
            }
            catch {
                await new Promise((r) => setTimeout(r, 1000));
            }
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
        let inputNotes;
        if (args.inputNotes?.length) {
            inputNotes = args.inputNotes.map((p) => {
                const pinned = sorted.find((n) => n.blinding === p.blinding);
                if (!pinned)
                    throw new Error("pinned note not found in spendable set");
                return pinned;
            });
            const have = inputNotes.reduce((s, n) => s + BigInt(n.amount), 0n);
            if (have < BigInt(args.grossLamports)) {
                throw new Error(`pinned notes hold ${have}, need ${args.grossLamports}`);
            }
            inputNotes.sort((a, b) => Number(b.amount) - Number(a.amount));
        }
        else {
            inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(args.grossLamports));
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
        const fee = new BN(Math.ceil((gross.toNumber() * feeBps) / 10000));
        const recipientGets = gross.sub(fee);
        const extAmount = recipientGets.neg();
        const change = totalInput.sub(gross);
        // The root and every sibling path must come from the same tree snapshot:
        // concurrent txs append leaves between separate fetches and the circuit
        // asserts the path hashes up to the root.
        const { root, nextLeafIndex, inputPathElements } = await convergedMerkleInputs(args.treeKey, inputs);
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
        const relay = args.relay !== false; // default: gasless relayer-signed withdraw
        let feeRecipientForHash = this.feeRecipient;
        if (args.isSpl && args.mint)
            feeRecipientForHash = this.feeAta(args.mint);
        const commonProof = {
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements,
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            feeRecipientForHash,
            mintAddress: args.mintAddress,
            isSpl: args.isSpl,
        };
        let signature;
        let nullifiers;
        if (relay) {
            // Gasless: backend signs with RELAYER_KEYPAIR. Recipient = wallet (SOL) / recipient ATA (SPL).
            let hashRecipient = args.recipient;
            let relayRecipient = args.recipient.toBase58();
            let recipientOwner;
            let mintStr;
            let altAddress;
            if (args.isSpl && args.mint) {
                const recipientAta = getAssociatedTokenAddressSync(args.mint, args.recipient);
                hashRecipient = recipientAta;
                relayRecipient = recipientAta.toBase58();
                recipientOwner = args.recipient.toBase58();
                mintStr = args.mint.toBase58();
                // The relayer builds a v0 message reusing this ALT so the (otherwise
                // >1232-byte) SPL withdraw compresses under the transaction-size limit.
                const alt = await ensureAlt({
                    signer: this.signer,
                    preferred: envAltAddress(),
                    addresses: splAltAddresses({
                        programId: this.programId,
                        feeRecipient: this.feeRecipient,
                        mint: args.mint,
                    }),
                });
                altAddress = alt.key.toBase58();
            }
            const r = await this.proveAndRelay({ ...commonProof, hashRecipient, relayRecipient, recipientOwner, mint: mintStr, altAddress });
            signature = r.signature;
            nullifiers = r.nullifiers;
        }
        else {
            // Client-signed: wallet signs, backend broadcasts.
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
                    preIxs: [
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, recipientAta, args.recipient, mint),
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, feeAta, this.feeRecipient, mint),
                    ],
                };
            }
            const r = await this.proveAndSend({ ...commonProof, recipient: args.recipient, ...splExtras });
            signature = r.signature;
            nullifiers = r.nullifiers;
        }
        for (const n of inputNotes)
            markNoteSpent(this.publicKey, n.id, signature);
        let changeIndex = -1;
        if (change.gt(new BN(0))) {
            await waitForLeafIndex(args.treeKey, nextLeafIndex).catch(() => { });
            changeIndex = await this.locateNoteLeaf(args.treeKey, nextLeafIndex, outputs[0]).catch(() => -1);
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[0].amount.toString(),
                blinding: outputs[0].blinding.toString(),
                // guess if locate failed — pending keeps it unspendable until the
                // next syncNotes scan confirms the true leaf position
                index: changeIndex >= 0 ? changeIndex : nextLeafIndex,
                mintAddress: args.mintAddress,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
                pending: changeIndex < 0,
            });
        }
        this.schedulePersist();
        return {
            signature,
            recipientLamports: recipientGets.toNumber(),
            feeLamports: fee.toNumber(),
            changeLamports: change.toString(),
            nullifiers,
            // withdrawInternal's changeIndex comes from locateNoteLeaf against the
            // indexed tree, so unlike the transfer path's guess it is authoritative
            changeNote: change.gt(new BN(0)) && changeIndex >= 0
                ? {
                    amount: outputs[0].amount.toString(),
                    blinding: outputs[0].blinding.toString(),
                    index: changeIndex,
                }
                : undefined,
        };
    }
    /**
     * Replace a pending change note's guessed leaf index with the relayer's
     * authoritative one, matched by blinding. Polls the commitment lookup while
     * the tx lands; giving up leaves the note pending (the next syncNotes scan
     * heals it the old way). Index-independent: the commitment is rebuilt from
     * amount + blinding alone.
     */
    async resolveChangeNote(treeKey, mintAddress, change, opts = {}) {
        const mint = mintAddress ?? (treeKey === SOL_TREE_KEY ? WRAPPED_SOL_MINT : undefined);
        if (!mint)
            throw new Error("resolveChangeNote: mintAddress required for non-SOL trees");
        // Field-measured floor: under an 8-lane run the mirror indexes a relay
        // ~5-10s after broadcast (confirm wait + sync pass). An 8s window gave
        // up right before the leaf landed, stranding the note pending until the
        // next full refresh — lanes then starved in bursts. 20s covers the
        // worst healthy lag; giving up still heals via the next syncNotes scan.
        const timeoutMs = opts.timeoutMs ?? 20_000;
        const intervalMs = opts.intervalMs ?? 300;
        const utxo = new Utxo({
            wasm: this.wasm,
            amount: change.amount,
            blinding: change.blinding,
            keypair: this.utxoKeypair,
            mintAddress: mint,
        });
        const commitment = fieldToHex32(utxo.getCommitment());
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const hit = await fetchCommitmentLeaf(commitment, treeKey);
                resolvePendingNote(this.publicKey, {
                    mintAddress: mint,
                    blinding: change.blinding,
                    index: hit.leafIndex,
                });
                this.schedulePersist();
                return true;
            }
            catch {
                // 404 until the sync indexes the leaf — keep polling
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        // A blinding that outlives several windows is a phantom (its tx landed
        // but failed execution — no leaf was ever minted) or a mirror hole.
        // Count the failure and drop the note past the cap instead of polling
        // it forever; a hole that later heals is re-added by any scan.
        return !recordResolveFailure(this.publicKey, mint, change.blinding, RESOLVE_MAX_FAILURES);
    }
    /**
     * Shared shielded-transfer flow (ext=0): output 0 is a note encrypted to the
     * recipient's registered x25519 key and committed to their note pubkey;
     * output 1 is our change note, encrypted to ourselves as usual. The relay
     * request's recipient field is the fee recipient wallet by convention (the
     * backend enforces the equality; nothing is actually paid to it at ext=0).
     */
    async transferNoteInternal(args) {
        // Self-transfers (note consolidation) resolve keys from the locally
        // derived identity — no registry enrollment needed, and the keys are
        // identical to the registered ones since both come from SIGN_MESSAGE.
        const keys = args.recipient.equals(this.publicKey)
            ? {
                notePubkey: this.utxoKeypair.pubkey.toString(),
                encPubkey: Buffer.from(this.enc.getReceivePublicKey()).toString("hex"),
            }
            : await fetchRecipientKeys(args.recipient);
        if (!keys) {
            throw new Error(`recipient ${args.recipient.toBase58()} has not enabled private receiving`);
        }
        const feeBps = this.info.withdrawalFeeRateBps;
        const wasm = this.wasm;
        const utxoKeypair = this.utxoKeypair;
        // ext=0 SOL relays must clear the relayer's fee floor; SPL fees are token
        // raw units, so the lamports floor never applies to them.
        const feeFloor = args.isSpl ? 0 : (this.info.minTransferFee ?? 0);
        const fee = new BN(Math.max(Math.ceil((args.netLamports * feeBps) / 10000), feeFloor));
        const gross = new BN(args.netLamports).add(fee);
        const sorted = unspentNotes(this.publicKey)
            .filter((n) => n.mintAddress === args.mintAddress)
            .sort((a, b) => Number(b.amount) - Number(a.amount));
        if (sorted.length === 0)
            throw new Error("no spendable notes");
        // Pinning: callers running parallel pay chains on one wallet pass the
        // exact note to spend. The entry syncNotes rebuilds the shared note set
        // from the indexer, so without a pin every concurrent caller converges on
        // the same largest note and they collide at the relayer.
        let inputNotes;
        const pinned = args.inputNotes ?? (args.inputNote ? [args.inputNote] : []);
        if (pinned.length > 0) {
            inputNotes = pinned.map((p) => {
                const found = sorted.find((n) => n.blinding === p.blinding);
                if (!found)
                    throw new Error("pinned note not found in spendable set");
                return found;
            });
            const have = inputNotes.reduce((s, n) => s + BigInt(n.amount), 0n);
            if (have < BigInt(gross.toString())) {
                throw new Error(`pinned notes hold ${have}, need ${gross.toString()}`);
            }
            inputNotes.sort((a, b) => Number(b.amount) - Number(a.amount));
        }
        else {
            inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(gross.toString()));
            if (inputNotes.length === 0) {
                const a = sorted[0];
                const need = gross.sub(new BN(a.amount));
                const b = sorted.slice(1).find((n) => new BN(n.amount).gte(need));
                if (!b) {
                    throw new Error(`insufficient private balance: have ${a.amount}, need ${gross.toString()}`);
                }
                inputNotes = [a, b];
            }
            else {
                inputNotes = [inputNotes[0]];
            }
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
        if (gross.gt(totalInput)) {
            throw new Error(`insufficient private balance: have ${totalInput.toString()}, need ${gross.toString()}`);
        }
        const net = new BN(args.netLamports);
        const change = totalInput.sub(gross);
        const extAmount = new BN(0);
        // The root and every sibling path must come from the same tree snapshot:
        // concurrent txs append leaves between separate fetches and the circuit
        // asserts the path hashes up to the root.
        const { root, nextLeafIndex, inputPathElements } = await convergedMerkleInputs(args.treeKey, inputs);
        const outputs = [
            new Utxo({
                wasm,
                amount: net.toString(),
                pubkey: keys.notePubkey,
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
        const enc1 = await encryptUtxoTo(Buffer.from(keys.encPubkey, "hex"), outputs[0]);
        const enc2 = await this.enc.encryptUtxo(outputs[1]);
        if (args.onSubmitted) {
            const pendingNullifiers = await Promise.all(inputs.filter((u) => u.amount.gt(new BN(0))).map((x) => x.getNullifier()));
            await args.onSubmitted({
                nullifiers: pendingNullifiers,
                changeBlinding: change.gt(new BN(0)) ? outputs[1].blinding.toString() : undefined,
                changeAmount: change.gt(new BN(0)) ? outputs[1].amount.toString() : undefined,
            });
        }
        const relay = args.relay !== false;
        let feeRecipientForHash = this.feeRecipient;
        if (args.isSpl && args.mint)
            feeRecipientForHash = this.feeAta(args.mint);
        const hashRecipient = this.feeRecipient;
        const commonProof = {
            root,
            inputs,
            outputs,
            encryptedOutput1: enc1,
            encryptedOutput2: enc2,
            inputPathElements,
            inputPathIndices: inputs.map((u) => u.index),
            extAmount,
            fee,
            feeRecipientForHash,
            mintAddress: args.mintAddress,
            isSpl: args.isSpl,
        };
        let signature;
        let nullifiers;
        if (relay) {
            let recipientOwner;
            let mintStr;
            let altAddress;
            if (args.isSpl && args.mint) {
                recipientOwner = this.feeRecipient.toBase58();
                mintStr = args.mint.toBase58();
                const alt = await ensureAlt({
                    signer: this.signer,
                    preferred: envAltAddress(),
                    addresses: splAltAddresses({
                        programId: this.programId,
                        feeRecipient: this.feeRecipient,
                        mint: args.mint,
                    }),
                });
                altAddress = alt.key.toBase58();
            }
            const r = await this.proveAndRelay({
                ...commonProof,
                hashRecipient,
                relayRecipient: this.feeRecipient.toBase58(),
                recipientOwner,
                mint: mintStr,
                altAddress,
            });
            signature = r.signature;
            nullifiers = r.nullifiers;
        }
        else {
            let splExtras;
            if (args.isSpl && args.mint) {
                const mint = args.mint;
                const signerAta = getAssociatedTokenAddressSync(mint, this.publicKey);
                const feeAta = this.feeAta(mint);
                splExtras = {
                    mint,
                    signerTokenAccount: signerAta,
                    // ext=0 never touches the recipient token account; the fee recipient
                    // wallet is only hashed into ext_data, mirroring the relayed path.
                    recipientTokenAccount: this.feeRecipient,
                    feeRecipientAta: feeAta,
                    preIxs: [
                        createAssociatedTokenAccountIdempotentInstruction(this.publicKey, feeAta, this.feeRecipient, mint),
                    ],
                };
            }
            const r = await this.proveAndSend({
                ...commonProof,
                recipient: this.feeRecipient,
                ...splExtras,
            });
            signature = r.signature;
            nullifiers = r.nullifiers;
        }
        for (const n of inputNotes)
            markNoteSpent(this.publicKey, n.id, signature);
        // Save the change note immediately with the guessed index and return —
        // the next sync pass heals the authoritative leaf position (removeStaleNote
        // drops the guessed-index copy, the indexed one is upserted unpending).
        // Blocking here on waitForLeafIndex + locateNoteLeaf held each payout lane
        // 5-10s after the relay had already responded (every poll paying a backend
        // round trip) while other lanes were still proving — that wait, not the
        // proof, was the throughput ceiling of the 100-employee runs. A pending
        // note is excluded from the spendable set, so nothing ever spends it at
        // the guessed index.
        let changeIndex = nextLeafIndex + 1;
        if (change.gt(new BN(0))) {
            saveNote(this.publicKey, {
                id: newNoteId(),
                amount: outputs[1].amount.toString(),
                blinding: outputs[1].blinding.toString(),
                index: changeIndex,
                mintAddress: args.mintAddress,
                spent: false,
                createdAt: Date.now(),
                depositTx: signature,
                pending: true,
            });
        }
        this.schedulePersist();
        return {
            signature,
            recipientLamports: net.toNumber(),
            feeLamports: fee.toNumber(),
            changeLamports: change.toString(),
            nullifiers,
            leafIndex: change.gt(new BN(0)) ? changeIndex - 1 : nextLeafIndex,
            commitment: fieldToHex32(outputs[0].getCommitment()),
            changeNote: change.gt(new BN(0))
                ? {
                    amount: outputs[1].amount.toString(),
                    blinding: outputs[1].blinding.toString(),
                    index: changeIndex,
                }
                : undefined,
        };
    }
    /** Prove + POST to relayer (backend signs with RELAYER_KEYPAIR). No wallet tx. */
    async proveAndRelay(args) {
        const inputNullifiers = await Promise.all(args.inputs.map((x) => x.getNullifier()));
        const outputCommitments = args.outputs.map((x) => x.getCommitment());
        const extDataHash = getExtDataHash({
            recipient: args.hashRecipient,
            extAmount: args.extAmount,
            encryptedOutput1: args.encryptedOutput1,
            encryptedOutput2: args.encryptedOutput2,
            fee: args.fee,
            feeRecipient: args.feeRecipientForHash,
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
            outPubkey: args.outputs.map((x) => x.pubkey),
            mintAddress: getMintAddressField(args.mintAddress),
        };
        const { proof, publicSignals } = await prove(circuitInput);
        const proofBytes = parseProofToBytesArray(proof);
        const pub = parseToBytesArray(publicSignals);
        const nullifierHexes = [pub[3], pub[4]].map((b) => bytesToHex(b));
        let signature;
        try {
            signature = await relayWithdraw({
                kind: args.isSpl ? "spl" : "sol",
                proofA: proofBytes.proofA,
                proofB: proofBytes.proofB,
                proofC: proofBytes.proofC,
                root: pub[0],
                publicAmount: pub[1],
                extDataHash: pub[2],
                inputNullifiers: [pub[3], pub[4]],
                outputCommitments: [pub[5], pub[6]],
                extAmount: args.extAmount.toNumber(),
                fee: args.fee.toNumber(),
                encryptedOutput1: args.encryptedOutput1,
                encryptedOutput2: args.encryptedOutput2,
                recipient: args.relayRecipient,
                mint: args.mint,
                recipientOwner: args.recipientOwner,
                altAddress: args.altAddress,
            });
        }
        catch (e) {
            // The relayer may have broadcast before this request failed; a spent
            // input nullifier means the payout landed — recover its signature
            // instead of throwing the caller into a retry that would double-pay.
            for (const nf of nullifierHexes) {
                const info = await nullifierInfo(nf).catch(() => null);
                if (info?.spent && info.signature) {
                    return { signature: info.signature, nullifiers: nullifierHexes };
                }
            }
            throw e;
        }
        return { signature, nullifiers: nullifierHexes };
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
            outPubkey: args.outputs.map((x) => x.pubkey),
            mintAddress: getMintAddressField(args.mintAddress),
        };
        const { proof, publicSignals } = await prove(circuitInput);
        const proofBytes = parseProofToBytesArray(proof);
        const pub = parseToBytesArray(publicSignals);
        const proofSubmit = {
            proofA: proofBytes.proofA,
            proofB: proofBytes.proofB,
            proofC: proofBytes.proofC,
            root: pub[0],
            publicAmount: pub[1],
            extDataHash: pub[2],
            inputNullifiers: [pub[3], pub[4]],
            outputCommitments: [pub[5], pub[6]],
        };
        const nullifierHexes = [pub[3], pub[4]].map((b) => bytesToHex(b));
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
