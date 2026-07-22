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
  const notes = loadNotes(wallet)
  notes.push(note)
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

export function unspentNotes(wallet: PublicKey): Note[] {
  return loadNotes(wallet).filter((n) => !n.spent)
}

export function totalBalance(wallet: PublicKey, mintAddress = WRAPPED_SOL_MINT): bigint {
  return unspentNotes(wallet)
    .filter((n) => n.mintAddress === mintAddress)
    .reduce((sum, n) => sum + BigInt(n.amount), 0n)
}

export function exportNotes(wallet: PublicKey): string {
  return JSON.stringify(loadNotes(wallet), null, 2)
}

export function importNotes(wallet: PublicKey, json: string, replace = false): number {
  const parsed = JSON.parse(json) as Note[]
  if (!Array.isArray(parsed)) throw new Error("notes JSON must be an array")
  const notes = replace ? parsed : [...loadNotes(wallet), ...parsed]
  persist(wallet, notes)
  return parsed.length
}

export function clearNotes(wallet: PublicKey): void {
  localStorage.removeItem(key(wallet))
}

export function newNoteId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
