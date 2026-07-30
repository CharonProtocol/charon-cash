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

function key(wallet: PublicKey): string {
  return `privacy-cash:notes:${wallet.toBase58()}`
}

function syncOffsetKey(wallet: PublicKey, treeKey: string): string {
  return `privacy-cash:sync-offset:${wallet.toBase58()}:${treeKey}`
}

export function loadNotes(wallet: PublicKey): Note[] {
  try {
    const raw = localStorage.getItem(key(wallet))
    return raw ? (JSON.parse(raw) as Note[]) : []
  } catch {
    return []
  }
}

function persist(wallet: PublicKey, notes: Note[]): void {
  localStorage.setItem(key(wallet), JSON.stringify(notes))
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
  localStorage.removeItem(key(wallet))
}

export function getSyncOffset(wallet: PublicKey, treeKey: string): number {
  const v = localStorage.getItem(syncOffsetKey(wallet, treeKey))
  return v ? Number(v) || 0 : 0
}

export function setSyncOffset(
  wallet: PublicKey,
  treeKey: string,
  offset: number,
): void {
  localStorage.setItem(syncOffsetKey(wallet, treeKey), String(offset))
}

export function resetSyncOffset(wallet: PublicKey, treeKey: string): void {
  localStorage.removeItem(syncOffsetKey(wallet, treeKey))
}

export function newNoteId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
