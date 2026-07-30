import { WRAPPED_SOL_MINT } from "./constants";
function key(wallet) {
    return `privacy-cash:notes:${wallet.toBase58()}`;
}
function syncOffsetKey(wallet, treeKey) {
    return `privacy-cash:sync-offset:${wallet.toBase58()}:${treeKey}`;
}
export function loadNotes(wallet) {
    try {
        const raw = localStorage.getItem(key(wallet));
        return raw ? JSON.parse(raw) : [];
    }
    catch {
        return [];
    }
}
function persist(wallet, notes) {
    localStorage.setItem(key(wallet), JSON.stringify(notes));
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
    localStorage.removeItem(key(wallet));
}
export function getSyncOffset(wallet, treeKey) {
    const v = localStorage.getItem(syncOffsetKey(wallet, treeKey));
    return v ? Number(v) || 0 : 0;
}
export function setSyncOffset(wallet, treeKey, offset) {
    localStorage.setItem(syncOffsetKey(wallet, treeKey), String(offset));
}
export function resetSyncOffset(wallet, treeKey) {
    localStorage.removeItem(syncOffsetKey(wallet, treeKey));
}
export function newNoteId() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
