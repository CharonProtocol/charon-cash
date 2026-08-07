import { backendUrl } from "./constants";
import { loadNotes, upsertNote } from "./notes";
/** Encrypt the note set to a hex blob using the wallet-derived key. */
export async function encryptNotesBlob(enc, notes) {
    return (await enc.encrypt(JSON.stringify(notes))).toString("hex");
}
/** Decrypt a hex blob back into notes using the wallet-derived key. */
export async function decryptNotesBlob(enc, hex) {
    const buf = Buffer.from(hex, "hex");
    const plain = (await enc.decrypt(buf)).toString("utf8");
    const parsed = JSON.parse(plain);
    return Array.isArray(parsed) ? parsed : [];
}
/** Read the in-memory note set, encrypt, and PUT the blob to the backend (upsert). */
export async function pushEncryptedNotes(wallet, enc) {
    const ciphertext = await encryptNotesBlob(enc, loadNotes(wallet));
    const res = await fetch(`${backendUrl()}/api/notes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.toBase58(), ciphertext }),
    });
    if (!res.ok)
        throw new Error(`notes backup failed: HTTP ${res.status}`);
}
/**
 * GET the encrypted blob, decrypt it, and upsert into the in-memory cache.
 * Returns the merged in-memory note set. Missing backup (404 or empty) → [].
 */
export async function pullEncryptedNotes(wallet, enc) {
    const res = await fetch(`${backendUrl()}/api/notes/${wallet.toBase58()}`);
    if (res.status === 404)
        return [];
    if (!res.ok)
        throw new Error(`notes restore failed: HTTP ${res.status}`);
    const data = (await res.json());
    if (!data.ciphertext)
        return [];
    const notes = await decryptNotesBlob(enc, data.ciphertext);
    for (const n of notes)
        upsertNote(wallet, n);
    return loadNotes(wallet);
}
