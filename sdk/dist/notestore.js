/**
 * Encrypted note blob sync with the backend — the authoritative note store.
 *
 * Notes (including each note's blinding factor — the spending secret) are NEVER
 * persisted to the browser. The wallet-signature-derived AES-GCM key (see
 * `EncryptionService`) encrypts the in-memory note set into an opaque blob that
 * is PUT to the backend (`encrypted_notes` table) and GET back on unlock. The
 * server stores only ciphertext and holds no key.
 *
 * Flow: the client keeps decrypted notes in an in-memory cache for the session
 * (`notes.ts`). On `unlock()` it seeds that cache by GET-ing + decrypting the
 * blob (`pullEncryptedNotes`) and by scanning the indexer (`syncNotes`); after
 * every mutation it PUTs a fresh ciphertext (`pushEncryptedNotes`). Reload wipes
 * the cache; the blob survives. Even without the blob, `syncNotes` rebuilds the
 * notes from the indexer's encrypted outputs, so funds are never locked out.
 */
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { getBackendUrl } from "./merkle";
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
const hex = (b) => Buffer.from(b).toString("hex");
/** What the backup key signs for one upload: wallet, time, and the blob's hash. */
export function noteBackupMessage(wallet, ts, ciphertext) {
    const blobHash = hex(sha256(new TextEncoder().encode(ciphertext)));
    return new TextEncoder().encode(["charon-notes-v1", wallet, String(ts), blobHash].join("\n"));
}
/** What the wallet signs once to link its backup key. */
export function noteKeyLinkMessage(wallet, backupKey) {
    return new TextEncoder().encode(["charon-notes-key-v1", wallet, backupKey].join("\n"));
}
/**
 * Read the in-memory note set, encrypt, and PUT the blob to the backend
 * (upsert), signed by the wallet's backup key. The first upload to a backend
 * that has no key for this wallet links it with one wallet signature.
 */
export async function pushEncryptedNotes(wallet, enc, signMessage) {
    // nothing to back up (a brand-new wallet): no upload, so no link prompt
    // before the wallet enrolls (enrolling links the backup key in one signature)
    if (loadNotes(wallet).length === 0)
        return;
    const ciphertext = await encryptNotesBlob(enc, loadNotes(wallet));
    const owner = wallet.toBase58();
    const { secretKey, publicKey } = enc.backupSigningKey();
    const key = new PublicKey(publicKey).toBase58();
    const put = () => {
        const ts = Date.now();
        const signature = Buffer.from(ed25519.sign(noteBackupMessage(owner, ts, ciphertext), secretKey)).toString("base64");
        return fetch(`${getBackendUrl()}/api/notes`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wallet: owner, ciphertext, ts, key, signature }),
        });
    };
    let res = await put();
    if (res.status === 401 && signMessage) {
        const err = (await res.json().catch(() => null));
        if (err?.error?.code === "NOTES_KEY_UNLINKED") {
            const linkSig = Buffer.from(await signMessage(noteKeyLinkMessage(owner, key))).toString("base64");
            const link = await fetch(`${getBackendUrl()}/api/notes/key`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ wallet: owner, key, signature: linkSig }),
            });
            if (!link.ok)
                throw new Error(`notes key link failed: HTTP ${link.status}`);
            res = await put();
        }
    }
    if (!res.ok)
        throw new Error(`notes backup failed: HTTP ${res.status}`);
}
/**
 * GET the encrypted blob, decrypt it, and upsert into the in-memory cache.
 * Returns the merged in-memory note set. Missing backup (404 or empty) → [].
 */
export async function pullEncryptedNotes(wallet, enc) {
    const res = await fetch(`${getBackendUrl()}/api/notes/${wallet.toBase58()}`);
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
