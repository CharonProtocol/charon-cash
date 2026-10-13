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
import type { PublicKey } from "@solana/web3.js"

import { getBackendUrl } from "./merkle"
import { EncryptionService } from "./crypto"
import { loadNotes, upsertNote, type Note } from "./notes"

/** Encrypt the note set to a hex blob using the wallet-derived key. */
export async function encryptNotesBlob(
  enc: EncryptionService,
  notes: Note[],
): Promise<string> {
  return (await enc.encrypt(JSON.stringify(notes))).toString("hex")
}

/** Decrypt a hex blob back into notes using the wallet-derived key. */
export async function decryptNotesBlob(
  enc: EncryptionService,
  hex: string,
): Promise<Note[]> {
  const buf = Buffer.from(hex, "hex")
  const plain = (await enc.decrypt(buf)).toString("utf8")
  const parsed = JSON.parse(plain)
  return Array.isArray(parsed) ? (parsed as Note[]) : []
}

/** Read the in-memory note set, encrypt, and PUT the blob to the backend (upsert). */
export async function pushEncryptedNotes(
  wallet: PublicKey,
  enc: EncryptionService,
): Promise<void> {
  const ciphertext = await encryptNotesBlob(enc, loadNotes(wallet))
  const res = await fetch(`${getBackendUrl()}/api/notes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.toBase58(), ciphertext }),
  })
  if (!res.ok) throw new Error(`notes backup failed: HTTP ${res.status}`)
}

/**
 * GET the encrypted blob, decrypt it, and upsert into the in-memory cache.
 * Returns the merged in-memory note set. Missing backup (404 or empty) → [].
 */
export async function pullEncryptedNotes(
  wallet: PublicKey,
  enc: EncryptionService,
): Promise<Note[]> {
  const res = await fetch(`${getBackendUrl()}/api/notes/${wallet.toBase58()}`)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`notes restore failed: HTTP ${res.status}`)
  const data = (await res.json()) as {
    ciphertext?: string | null
    exists?: boolean
  }
  if (!data.ciphertext) return []
  const notes = await decryptNotesBlob(enc, data.ciphertext)
  for (const n of notes) upsertNote(wallet, n)
  return loadNotes(wallet)
}
