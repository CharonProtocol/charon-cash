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

export function newNoteId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
