/**
 * Encrypted note blob sync with the backend.
 *
 * The note set (which includes each note's blinding factor — the spending
 * secret) is encrypted client-side with the wallet-signature-derived AES-GCM
 * key (see `EncryptionService`). Only the resulting ciphertext is sent to the
 * backend, which stores it as an opaque blob keyed by wallet pubkey. The server
 * can never read the notes. This gives fetchable/backup-able notes across
 * devices without weakening the privacy model.
 */
import type { PublicKey } from "@solana/web3.js"

import { backendUrl } from "./constants"
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

/** Read local notes, encrypt, and PUT the blob to the backend (upsert). */
export async function pushEncryptedNotes(
  wallet: PublicKey,
  enc: EncryptionService,
): Promise<void> {
  const ciphertext = await encryptNotesBlob(enc, loadNotes(wallet))
  const res = await fetch(`${backendUrl()}/api/notes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.toBase58(), ciphertext }),
  })
  if (!res.ok) throw new Error(`notes backup failed: HTTP ${res.status}`)
}

/**
 * GET the encrypted blob, decrypt it, and upsert into local storage.
 * Returns the merged local note set. 404 (no backup yet) → empty, no throw.
 */
export async function pullEncryptedNotes(
  wallet: PublicKey,
  enc: EncryptionService,
): Promise<Note[]> {
  const res = await fetch(`${backendUrl()}/api/notes/${wallet.toBase58()}`)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`notes restore failed: HTTP ${res.status}`)
  const data = (await res.json()) as { ciphertext: string }
  const notes = await decryptNotesBlob(enc, data.ciphertext)
  for (const n of notes) upsertNote(wallet, n)
  return loadNotes(wallet)
}
