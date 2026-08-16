/**
 * In-memory note cache for the current page session.
 *
 * Spending secrets (each note's `blinding`) are NEVER persisted to the browser.
 * Decrypted notes live only in this in-memory map while the wallet is unlocked,
 * and are wiped on reload. The authoritative, durable copy is the AES-GCM
 * encrypted blob stored on the backend (`encrypted_notes` table) — the server
 * holds no key. On unlock the client seeds this cache from that blob
 * (`pullEncryptedNotes`) and from the indexer scan (`syncNotes`); every
 * mutation is followed by an encrypted push back to the backend.
 *
 * Recovery safety net: even if the backend blob is lost, `syncNotes` rebuilds
 * the note set by decrypting the indexer's encrypted outputs, so funds are
 * never locked out as long as the wallet can re-sign.
 */
import { PublicKey } from "@solana/web3.js"

import { WRAPPED_SOL_MINT } from "./constants"

export interface Note {
  id: string
  amount: string
  blinding: string
  index: number
  mintAddress: string
  spent: boolean
  createdAt: number
  depositTx?: string
  spendTx?: string
}

/** Page-wide note cache, keyed by wallet base58. Wiped on reload by design. */
const NOTES = new Map<string, Note[]>()

/** Per-session indexer scan cursor, keyed by `${wallet}:${treeKey}`. */
const OFFSETS = new Map<string, number>()

const NOTES_LEGACY_PREFIX = "privacy-cash:notes:"
const OFFSET_LEGACY_PREFIX = "privacy-cash:sync-offset:"

function wk(wallet: PublicKey): string {
  return wallet.toBase58()
}

function ok(wallet: PublicKey, treeKey: string): string {
  return `${wallet.toBase58()}:${treeKey}`
}

export function loadNotes(wallet: PublicKey): Note[] {
  return NOTES.get(wk(wallet)) ?? []
}

function persist(wallet: PublicKey, notes: Note[]): void {
  NOTES.set(wk(wallet), notes)
}

export function saveNote(wallet: PublicKey, note: Note): void {
  upsertNote(wallet, note)
}

/** Insert or replace by (mintAddress, index). Preserves existing id/createdAt. */
export function upsertNote(wallet: PublicKey, note: Note): void {
  const notes = loadNotes(wallet)
  const i = notes.findIndex(
    (n) => n.mintAddress === note.mintAddress && n.index === note.index,
  )
  if (i >= 0) {
    notes[i] = {
      ...notes[i],
      ...note,
      id: notes[i].id,
      createdAt: notes[i].createdAt,
    }
  } else {
    notes.push(note)
  }
  persist(wallet, notes)
}

export function markNoteSpent(
  wallet: PublicKey,
  noteId: string,
  spendTx: string,
): void {
  const notes = loadNotes(wallet).map((n) =>
    n.id === noteId ? { ...n, spent: true, spendTx } : n,
  )
  persist(wallet, notes)
}

export function markNoteSpentByIndex(
  wallet: PublicKey,
  mintAddress: string,
  index: number,
  spendTx?: string,
): void {
  const notes = loadNotes(wallet).map((n) =>
    n.mintAddress === mintAddress && n.index === index
      ? { ...n, spent: true, spendTx: spendTx ?? n.spendTx }
      : n,
  )
  persist(wallet, notes)
}

export function unspentNotes(wallet: PublicKey): Note[] {
  return loadNotes(wallet).filter((n) => !n.spent)
}

export function totalBalance(
  wallet: PublicKey,
  mintAddress = WRAPPED_SOL_MINT,
): bigint {
  return unspentNotes(wallet)
    .filter((n) => n.mintAddress === mintAddress)
    .reduce((sum, n) => sum + BigInt(n.amount), 0n)
}

export function exportNotes(wallet: PublicKey): string {
  return JSON.stringify(loadNotes(wallet), null, 2)
}

export function importNotes(
  wallet: PublicKey,
  json: string,
  replace = false,
): number {
  const parsed = JSON.parse(json) as Note[]
  if (!Array.isArray(parsed)) throw new Error("notes JSON must be an array")
  const notes = replace ? parsed : [...loadNotes(wallet), ...parsed]
  persist(wallet, notes)
  return parsed.length
}

export function clearNotes(wallet: PublicKey): void {
  NOTES.delete(wk(wallet))
  const prefix = `${wk(wallet)}:`
  for (const k of [...OFFSETS.keys()]) {
    if (k.startsWith(prefix)) OFFSETS.delete(k)
  }
}

/**
 * Drop any unspent note that duplicates (mint, amount, blinding) at a DIFFERENT
 * index. A note's commitment is Poseidon(amount, pubkey, blinding, mint), so a
 * given UTXO lives at exactly one leaf index; any other index for the same
 * (amount, blinding, mint) is a stale label left by a relayer-mirror rebuild.
 * Called from syncNotes before upserting the authoritative copy.
 */
export function removeStaleNote(
  wallet: PublicKey,
  mintAddress: string,
  amount: string,
  blinding: string,
  keepIndex: number,
): void {
  const notes = loadNotes(wallet)
  const filtered = notes.filter(
    (n) =>
      !(
        !n.spent &&
        n.mintAddress === mintAddress &&
        n.amount === amount &&
        n.blinding === blinding &&
        n.index !== keepIndex
      ),
  )
  if (filtered.length !== notes.length) persist(wallet, filtered)
}

export function getSyncOffset(wallet: PublicKey, treeKey: string): number {
  return OFFSETS.get(ok(wallet, treeKey)) ?? 0
}

export function setSyncOffset(
  wallet: PublicKey,
  treeKey: string,
  offset: number,
): void {
  OFFSETS.set(ok(wallet, treeKey), offset)
}

export function resetSyncOffset(wallet: PublicKey, treeKey: string): void {
  OFFSETS.delete(ok(wallet, treeKey))
}

/**
 * Read any pre-migration plaintext notes left in localStorage by older builds.
 * Returns [] outside the browser or if none exist. Used once on unlock to
 * migrate them into the encrypted backend blob, after which the legacy key is
 * purged by `purgeLegacyStorage`.
 */
export function readLegacyNotes(wallet: PublicKey): Note[] {
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(NOTES_LEGACY_PREFIX + wk(wallet))
    const parsed = raw ? (JSON.parse(raw) as Note[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Remove every legacy localStorage key for this wallet (plaintext notes + sync
 * offsets). Idempotent; safe to call on every unlock. Ensures no spending
 * secret lingers on disk after the migration to encrypted-DB-only storage.
 */
export function purgeLegacyStorage(wallet: PublicKey): void {
  if (typeof localStorage === "undefined") return
  const w = wk(wallet)
  try {
    localStorage.removeItem(NOTES_LEGACY_PREFIX + w)
    const notesPrefix = NOTES_LEGACY_PREFIX + w
    const offsetPrefix = OFFSET_LEGACY_PREFIX + w + ":"
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k === notesPrefix || k.startsWith(offsetPrefix))) {
        toRemove.push(k)
      }
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {
    /* localStorage may be unavailable (private mode); nothing to purge */
  }
}

export function newNoteId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
