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
  /**
   * True while `index` is still the pre-send guess: concurrent txs may have
   * appended ahead of ours, so the true leaf position is not confirmed yet.
   * Pending notes are excluded from `unspentNotes` — spending a note at a
   * wrong index makes the circuit's root check (ForceEqualIfEnabled) fail.
   * Cleared by locateNoteLeaf / the next syncNotes scan.
   */
  pending?: boolean
  /**
   * Resolve windows that timed out while this note stayed pending. A note
   * that keeps failing is a phantom change note (its tx landed but failed
   * execution, so no leaf was ever minted) or a mirror hole; past a cap it
   * is dropped instead of polled forever. A hole that later heals is
   * re-added by any scan.
   */
  pendingAttempts?: number
  /**
   * Leaf index at/after the current tree's end (another network's note, or a
   * reset chain): held out of spending, never deleted, and cleared as soon as
   * a sync sees a tree that contains the index.
   */
  foreign?: boolean
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

/**
 * Flag confirmed notes whose leaf lies at or beyond this tree's end as
 * foreign (not spendable) and clear the flag on notes the tree now contains.
 * Nothing is deleted: the tree size comes from the backend, which must not be
 * able to make the wallet forget real notes. Returns how many are flagged.
 */
export function flagNotesBeyondTree(wallet: PublicKey, mintAddress: string, treeSize: number): number {
  let flagged = 0
  for (const n of loadNotes(wallet)) {
    if (n.mintAddress !== mintAddress) continue
    const beyond = !n.pending && n.index >= treeSize
    if (beyond) {
      n.foreign = true
      flagged++
    } else if (n.foreign) {
      delete n.foreign
    }
  }
  return flagged
}

export function saveNote(wallet: PublicKey, note: Note): void {
  upsertNote(wallet, note)
}

/** Insert, or update the same note (by blinding). Preserves existing id/createdAt. */
export function upsertNote(wallet: PublicKey, note: Note): void {
  const notes = loadNotes(wallet)
  // A note is identified by its blinding (random per note). Leaf indexes are
  // only guesses until the tx lands, and concurrent senders guess the SAME
  // next index: matching on index alone overwrote another lane's pending
  // change note, and the store ended up with two spendable copies of one
  // note — two lanes spent it, only one payout could land, and the other row
  // reported the winner's signature (unpaid employees counted as sent).
  const same = (n: Note) => n.mintAddress === note.mintAddress && n.blinding === note.blinding
  let i = notes.findIndex(same)
  // Only an authoritative (indexed) note may replace a different settled note
  // at its leaf, e.g. a stale entry from a reset chain. A pending note's index
  // is a guess: saveNote of a fresh change note used to overwrite whatever
  // real note sat at the guessed index — often one a lane had just reserved —
  // so it vanished, came back from the next scan under a new id, and a second
  // lane spent it again (one employee unpaid, reported with the other's tx).
  if (i < 0 && !note.pending) {
    i = notes.findIndex((n) => n.mintAddress === note.mintAddress && n.index === note.index && !n.pending)
  }
  if (i >= 0) {
    const spent = notes.some((n) => same(n) && n.spent) || note.spent
    notes[i] = {
      ...notes[i],
      ...note,
      id: notes[i].id,
      createdAt: notes[i].createdAt,
      // explicit (not spread): an authoritative upsert without `pending`
      // must clear a stale pending flag left by the pre-send save
      pending: note.pending,
      // spent is sticky: only markNoteUnspent (chain-checked) un-spends
      spent,
    }
    const kept = notes[i]
    persist(wallet, notes.filter((n) => n === kept || !same(n)))
  } else {
    notes.push(note)
    persist(wallet, notes)
  }
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

/**
 * Reverse a premature spend-mark: the transfer path burns notes at
 * relay-accept, but a tx that later fails execution never consumed the
 * nullifier, so the note is still spendable and must re-enter the balance.
 */
export function markNoteUnspent(wallet: PublicKey, noteId: string): void {
  const notes = loadNotes(wallet).map((n) => {
    if (n.id !== noteId) return n
    const { spendTx: _drop, ...rest } = n
    return { ...rest, spent: false }
  })
  persist(wallet, notes)
}

/**
 * Pin a pending note's authoritative leaf index (matched by blinding — the
 * pre-send index is a guess, so it cannot key the lookup) and un-pend it.
 * A note whose blinding is absent (already healed by a sync scan, or spent)
 * is left alone.
 */
export function resolvePendingNote(
  wallet: PublicKey,
  match: { mintAddress: string; blinding: string; index: number },
): void {
  const notes = loadNotes(wallet).map((n) =>
    n.mintAddress === match.mintAddress && n.blinding === match.blinding
      ? { ...n, index: match.index, pending: false, pendingAttempts: 0 }
      : n,
  )
  persist(wallet, notes)
}

/**
 * Count a timed-out resolve window for this pending note. Past
 * `maxAttempts` the note is dropped (it is either a phantom that will never
 * exist or a hole a later scan re-adds) and true is returned so callers
 * stop polling. Notes that resolve successfully reset to zero instead.
 */
export function recordResolveFailure(
  wallet: PublicKey,
  mintAddress: string,
  blinding: string,
  maxAttempts: number,
): boolean {
  const notes = loadNotes(wallet)
  let exceeded = false
  let touched = false
  let next = notes.map((n) => {
    if (n.mintAddress !== mintAddress || n.blinding !== blinding || !n.pending) return n
    touched = true
    const attempts = (n.pendingAttempts ?? 0) + 1
    if (attempts >= maxAttempts) exceeded = true
    return { ...n, pendingAttempts: attempts }
  })
  if (exceeded) {
    next = next.filter(
      (n) =>
        !(
          n.pending &&
          n.mintAddress === mintAddress &&
          n.blinding === blinding
        ),
    )
  }
  if (touched) persist(wallet, next)
  return exceeded
}

export function markNoteSpentByIndex(
  wallet: PublicKey,
  mintAddress: string,
  index: number,
  spendTx?: string,
  blinding?: string,
): void {
  // With a blinding, only that note: an index alone also matched other
  // lanes' pending change notes whose GUESSED index equals this (spent)
  // leaf, and they stayed "spent" after resolving to their real leaf (a lane
  // stalled 30s on its own change, the money stuck until a full recheck).
  const notes = loadNotes(wallet).map((n) =>
    n.mintAddress === mintAddress && n.index === index && (blinding === undefined || n.blinding === blinding)
      ? { ...n, spent: true, spendTx: spendTx ?? n.spendTx }
      : n,
  )
  persist(wallet, notes)
}

export function unspentNotes(wallet: PublicKey): Note[] {
  // pending = index still a guess; spending one makes the circuit's root
  // check fail (ForceEqualIfEnabled), so hold it out until located/scanned
  // foreign = leaf past this chain's tree end: unspendable here
  // one entry per note (blinding): a copy left by an older store version
  // must never become a second spendable note, and a spent copy wins
  const notes = loadNotes(wallet)
  const spentKeys = new Set(notes.filter((n) => n.spent).map((n) => `${n.mintAddress}:${n.blinding}`))
  const seen = new Set<string>()
  return notes.filter((n) => {
    if (n.spent || n.pending || n.foreign || n.index < 0) return false
    const key = `${n.mintAddress}:${n.blinding}`
    if (spentKeys.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  const k = ok(wallet, treeKey)
  const mem = OFFSETS.get(k)
  if (mem !== undefined) return mem
  // Persisted across reloads: a fresh page no longer re-scans the whole tree
  // (the 580-leaf unlock scan took over a minute). syncNotes guards against
  // a stored offset beyond the tree in case the indexer was reset.
  try {
    const raw = localStorage.getItem(OFFSET_LEGACY_PREFIX + k)
    if (raw !== null) {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= 0) {
        OFFSETS.set(k, n)
        return n
      }
    }
  } catch {
    /* storage unavailable — in-memory only */
  }
  return 0
}

export function setSyncOffset(
  wallet: PublicKey,
  treeKey: string,
  offset: number,
): void {
  const k = ok(wallet, treeKey)
  OFFSETS.set(k, offset)
  try {
    localStorage.setItem(OFFSET_LEGACY_PREFIX + k, String(offset))
  } catch {
    /* storage unavailable — in-memory only */
  }
}

export function resetSyncOffset(wallet: PublicKey, treeKey: string): void {
  const k = ok(wallet, treeKey)
  OFFSETS.delete(k)
  try {
    localStorage.removeItem(OFFSET_LEGACY_PREFIX + k)
  } catch {
    /* storage unavailable */
  }
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
 * Remove the legacy plaintext notes key for this wallet. Idempotent; safe to
 * call on every unlock. The sync offset is deliberately NOT purged: it is a
 * plain integer cursor with no secret material, and deleting it here forced a
 * full-tree rescan on every unlock (the multi-minute unlock). A stale offset
 * is handled by syncNotes's indexer-reset guard instead.
 */
export function purgeLegacyStorage(wallet: PublicKey): void {
  if (typeof localStorage === "undefined") return
  const w = wk(wallet)
  try {
    localStorage.removeItem(NOTES_LEGACY_PREFIX + w)
  } catch {
    /* localStorage may be unavailable (private mode); nothing to purge */
  }
}

export function newNoteId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
