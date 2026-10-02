import { WRAPPED_SOL_MINT } from "./constants";
/** Page-wide note cache, keyed by wallet base58. Wiped on reload by design. */
const NOTES = new Map();
/** Per-session indexer scan cursor, keyed by `${wallet}:${treeKey}`. */
const OFFSETS = new Map();
const NOTES_LEGACY_PREFIX = "privacy-cash:notes:";
const OFFSET_LEGACY_PREFIX = "privacy-cash:sync-offset:";
function wk(wallet) {
    return wallet.toBase58();
}
function ok(wallet, treeKey) {
    return `${wallet.toBase58()}:${treeKey}`;
}
export function loadNotes(wallet) {
    return NOTES.get(wk(wallet)) ?? [];
}
function persist(wallet, notes) {
    NOTES.set(wk(wallet), notes);
}
export function saveNote(wallet, note) {
    upsertNote(wallet, note);
}
/** Insert or replace by (mintAddress, index). Preserves existing id/createdAt. */
export function upsertNote(wallet, note) {
    const notes = loadNotes(wallet);
    const i = notes.findIndex((n) => n.mintAddress === note.mintAddress && n.index === note.index);
    if (i >= 0) {
        notes[i] = {
            ...notes[i],
            ...note,
            id: notes[i].id,
            createdAt: notes[i].createdAt,
            // explicit (not spread): an authoritative upsert without `pending`
            // must clear a stale pending flag left by the pre-send save
            pending: note.pending,
        };
    }
    else {
        notes.push(note);
    }
    persist(wallet, notes);
}
export function markNoteSpent(wallet, noteId, spendTx) {
    const notes = loadNotes(wallet).map((n) => n.id === noteId ? { ...n, spent: true, spendTx } : n);
    persist(wallet, notes);
}
export function markNoteSpentByIndex(wallet, mintAddress, index, spendTx) {
    const notes = loadNotes(wallet).map((n) => n.mintAddress === mintAddress && n.index === index
        ? { ...n, spent: true, spendTx: spendTx ?? n.spendTx }
        : n);
    persist(wallet, notes);
}
export function unspentNotes(wallet) {
    // pending = index still a guess; spending one makes the circuit's root
    // check fail (ForceEqualIfEnabled), so hold it out until located/scanned
    return loadNotes(wallet).filter((n) => !n.spent && !n.pending && n.index >= 0);
}
export function totalBalance(wallet, mintAddress = WRAPPED_SOL_MINT) {
    return unspentNotes(wallet)
        .filter((n) => n.mintAddress === mintAddress)
        .reduce((sum, n) => sum + BigInt(n.amount), 0n);
}
export function exportNotes(wallet) {
    return JSON.stringify(loadNotes(wallet), null, 2);
}
export function importNotes(wallet, json, replace = false) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed))
        throw new Error("notes JSON must be an array");
    const notes = replace ? parsed : [...loadNotes(wallet), ...parsed];
    persist(wallet, notes);
    return parsed.length;
}
export function clearNotes(wallet) {
    NOTES.delete(wk(wallet));
    const prefix = `${wk(wallet)}:`;
    for (const k of [...OFFSETS.keys()]) {
        if (k.startsWith(prefix))
            OFFSETS.delete(k);
    }
}
/**
 * Drop any unspent note that duplicates (mint, amount, blinding) at a DIFFERENT
 * index. A note's commitment is Poseidon(amount, pubkey, blinding, mint), so a
 * given UTXO lives at exactly one leaf index; any other index for the same
 * (amount, blinding, mint) is a stale label left by a relayer-mirror rebuild.
 * Called from syncNotes before upserting the authoritative copy.
 */
export function removeStaleNote(wallet, mintAddress, amount, blinding, keepIndex) {
    const notes = loadNotes(wallet);
    const filtered = notes.filter((n) => !(!n.spent &&
        n.mintAddress === mintAddress &&
        n.amount === amount &&
        n.blinding === blinding &&
        n.index !== keepIndex));
    if (filtered.length !== notes.length)
        persist(wallet, filtered);
}
export function getSyncOffset(wallet, treeKey) {
    const k = ok(wallet, treeKey);
    const mem = OFFSETS.get(k);
    if (mem !== undefined)
        return mem;
    // Persisted across reloads: a fresh page no longer re-scans the whole tree
    // (the 580-leaf unlock scan took over a minute). syncNotes guards against
    // a stored offset beyond the tree in case the indexer was reset.
    try {
        const raw = localStorage.getItem(OFFSET_LEGACY_PREFIX + k);
        if (raw !== null) {
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) {
                OFFSETS.set(k, n);
                return n;
            }
        }
    }
    catch {
        /* storage unavailable — in-memory only */
    }
    return 0;
}
export function setSyncOffset(wallet, treeKey, offset) {
    const k = ok(wallet, treeKey);
    OFFSETS.set(k, offset);
    try {
        localStorage.setItem(OFFSET_LEGACY_PREFIX + k, String(offset));
    }
    catch {
        /* storage unavailable — in-memory only */
    }
}
export function resetSyncOffset(wallet, treeKey) {
    const k = ok(wallet, treeKey);
    OFFSETS.delete(k);
    try {
        localStorage.removeItem(OFFSET_LEGACY_PREFIX + k);
    }
    catch {
        /* storage unavailable */
    }
}
/**
 * Read any pre-migration plaintext notes left in localStorage by older builds.
 * Returns [] outside the browser or if none exist. Used once on unlock to
 * migrate them into the encrypted backend blob, after which the legacy key is
 * purged by `purgeLegacyStorage`.
 */
export function readLegacyNotes(wallet) {
    if (typeof localStorage === "undefined")
        return [];
    try {
        const raw = localStorage.getItem(NOTES_LEGACY_PREFIX + wk(wallet));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/**
 * Remove the legacy plaintext notes key for this wallet. Idempotent; safe to
 * call on every unlock. The sync offset is deliberately NOT purged: it is a
 * plain integer cursor with no secret material, and deleting it here forced a
 * full-tree rescan on every unlock (the multi-minute unlock). A stale offset
 * is handled by syncNotes's indexer-reset guard instead.
 */
export function purgeLegacyStorage(wallet) {
    if (typeof localStorage === "undefined")
        return;
    const w = wk(wallet);
    try {
        localStorage.removeItem(NOTES_LEGACY_PREFIX + w);
    }
    catch {
        /* localStorage may be unavailable (private mode); nothing to purge */
    }
}
export function newNoteId() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
