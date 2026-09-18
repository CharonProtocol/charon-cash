import { WRAPPED_SOL_MINT } from "./constants";
/** Page-wide note cache, keyed by wallet base58. Wiped on reload by design. */
const NOTES = new Map();
/** Per-session indexer scan cursor, keyed by `${wallet}:${treeKey}`. */
const OFFSETS = new Map();
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
    return loadNotes(wallet).filter((n) => !n.spent);
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
}
export function getSyncOffset(wallet, treeKey) {
    return OFFSETS.get(ok(wallet, treeKey)) ?? 0;
}
export function setSyncOffset(wallet, treeKey, offset) {
    OFFSETS.set(ok(wallet, treeKey), offset);
}
export function resetSyncOffset(wallet, treeKey) {
    OFFSETS.delete(ok(wallet, treeKey));
}
export function newNoteId() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
