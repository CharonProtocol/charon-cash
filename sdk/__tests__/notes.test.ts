import { describe, it, expect, beforeEach } from "bun:test"
import type { PublicKey } from "@solana/web3.js"

import {
  loadNotes,
  saveNote,
  upsertNote,
  markNoteSpent,
  markNoteSpentByIndex,
  markNoteUnspent,
  unspentNotes,
  totalBalance,
  exportNotes,
  importNotes,
  clearNotes,
  getSyncOffset,
  setSyncOffset,
  resetSyncOffset,
  newNoteId,
  readLegacyNotes,
  purgeLegacyStorage,
  flagNotesBeyondTree,
  type Note,
} from "../src/notes"
import { EncryptionService } from "../src/crypto"
import { encryptNotesBlob, decryptNotesBlob } from "../src/notestore"

const SOL = "11111111111111111111111111111112"

/**
 * `notes.ts` only calls `wallet.toBase58()`, so a stub is enough and keeps the
 * test free of a runtime `@solana/web3.js` dependency.
 */
function wallet(id: string): PublicKey {
  return { toBase58: () => id } as unknown as PublicKey
}

let blindingSeq = 0
function note(partial: Partial<Note> & { index: number }): Note {
  return {
    id: newNoteId(),
    amount: "1000",
    // every real note has its own random blinding (the store keys on it)
    blinding: `b${++blindingSeq}`,
    mintAddress: SOL,
    spent: false,
    createdAt: 1,
    ...partial,
  }
}

describe("in-memory note store", () => {
  let w: PublicKey
  beforeEach(() => {
    w = wallet("primary")
    clearNotes(w)
  })

  it("starts empty", () => {
    expect(loadNotes(w)).toEqual([])
    expect(unspentNotes(w)).toEqual([])
  })

  it("inserts and loads notes", () => {
    saveNote(w, note({ index: 0, amount: "100" }))
    saveNote(w, note({ index: 1, amount: "200" }))
    expect(loadNotes(w)).toHaveLength(2)
  })

  it("upserts by (mintAddress, index) without duplicating", () => {
    upsertNote(w, note({ index: 0, amount: "100", blinding: "a" }))
    upsertNote(w, note({ index: 0, amount: "999", blinding: "b" }))
    const notes = loadNotes(w)
    expect(notes).toHaveLength(1)
    expect(notes[0].amount).toBe("999")
    expect(notes[0].blinding).toBe("b")
  })

  it("marks a note spent by id", () => {
    const n = note({ index: 3 })
    saveNote(w, n)
    markNoteSpent(w, n.id, "sig123")
    expect(unspentNotes(w)).toHaveLength(0)
    expect(loadNotes(w)[0].spent).toBe(true)
    expect(loadNotes(w)[0].spendTx).toBe("sig123")
  })

  it("marks a note spent by index", () => {
    saveNote(w, note({ index: 5 }))
    markNoteSpentByIndex(w, SOL, 5, "sig456")
    expect(unspentNotes(w)).toHaveLength(0)
    expect(loadNotes(w)[0].spendTx).toBe("sig456")
  })

  it("un-marks a wrongly spent note by id (failed-on-chain restore)", () => {
    // The transfer path marks notes spent at relay-accept; when the program
    // then rejects the execution the notes are still good and must return
    // to the spendable set with their id and createdAt preserved.
    const n = note({ index: 7, amount: "500" })
    saveNote(w, n)
    markNoteSpent(w, n.id, "sig789")
    expect(unspentNotes(w)).toHaveLength(0)
    markNoteUnspent(w, n.id)
    expect(unspentNotes(w)).toHaveLength(1)
    expect(loadNotes(w)[0].id).toBe(n.id)
    expect(loadNotes(w)[0].spent).toBe(false)
    expect(loadNotes(w)[0].spendTx).toBeUndefined()
  })

  it("un-marking an unknown id is a no-op", () => {
    saveNote(w, note({ index: 1 }))
    markNoteUnspent(w, "no-such-id")
    expect(loadNotes(w)).toHaveLength(1)
    expect(unspentNotes(w)).toHaveLength(1)
  })

  it("totals unspent balance per mint", () => {
    saveNote(w, note({ index: 0, amount: "100" }))
    saveNote(w, note({ index: 1, amount: "250" }))
    saveNote(w, note({ index: 2, amount: "10", spent: true }))
    expect(totalBalance(w, SOL)).toBe(350n)
  })

  it("imports (merge + replace) and exports", () => {
    saveNote(w, note({ index: 0, amount: "1" }))
    const more = [note({ index: 1, amount: "2" })]

    const merged = importNotes(w, JSON.stringify(more))
    expect(merged).toBe(1)
    expect(loadNotes(w)).toHaveLength(2)

    const replaced = importNotes(w, JSON.stringify(more), true)
    expect(replaced).toBe(1)
    expect(loadNotes(w)).toHaveLength(1)

    expect(JSON.parse(exportNotes(w))).toHaveLength(1)
  })

  it("clears notes", () => {
    saveNote(w, note({ index: 0 }))
    clearNotes(w)
    expect(loadNotes(w)).toEqual([])
  })

  it("isolates notes per wallet", () => {
    const w2 = wallet("secondary")
    saveNote(w, note({ index: 0 }))
    saveNote(w2, note({ index: 0 }))
    expect(loadNotes(w)).toHaveLength(1)
    expect(loadNotes(w2)).toHaveLength(1)
    clearNotes(w)
    expect(loadNotes(w)).toEqual([])
    expect(loadNotes(w2)).toHaveLength(1)
  })

  it("manages sync offsets in memory", () => {
    expect(getSyncOffset(w, "sol")).toBe(0)
    setSyncOffset(w, "sol", 42)
    expect(getSyncOffset(w, "sol")).toBe(42)
    resetSyncOffset(w, "sol")
    expect(getSyncOffset(w, "sol")).toBe(0)
  })

  it("purging legacy storage keeps the sync offset (it is not a secret)", () => {
    // unlock() runs purgeLegacyStorage before every sync; deleting the offset
    // there forced a full-tree rescan on every unlock (the multi-minute
    // unlock). Only the plaintext notes key may be purged.
    setSyncOffset(w, "sol", 42)
    purgeLegacyStorage(w)
    expect(getSyncOffset(w, "sol")).toBe(42)
  })

  it("readLegacyNotes is a no-op outside the browser", () => {
    expect(readLegacyNotes(w)).toEqual([])
  })
})

describe("encrypted note blob round-trip", () => {
  it("encrypts then decrypts back to the same note set", async () => {
    const enc = new EncryptionService()
    enc.deriveFromSignature(new Uint8Array(64).fill(9))
    const notes = [note({ index: 0 }), note({ index: 1, amount: "5" })]

    const blob = await encryptNotesBlob(enc, notes)
    const back = await decryptNotesBlob(enc, blob)

    expect(back).toEqual(notes)
  })
})

describe("flagNotesBeyondTree", () => {
  it("holds out confirmed notes past the tree end without deleting, and clears when the tree grows", () => {
    const w = wallet("foreign")
    clearNotes(w)
    upsertNote(w, note({ index: 10, blinding: "a" }))
    upsertNote(w, note({ index: 6505, blinding: "b" })) // another network's note
    upsertNote(w, note({ index: 6600, blinding: "c", pending: true }))
    upsertNote(w, note({ index: 9000, blinding: "d", mintAddress: "OtherMint1111111111111111111111111111111111" }))
    expect(flagNotesBeyondTree(w, SOL, 214)).toBe(1)
    expect(loadNotes(w)).toHaveLength(4) // nothing deleted
    expect(unspentNotes(w).map((n) => n.blinding).sort()).toEqual(["a", "d"])
    expect(flagNotesBeyondTree(w, SOL, 7000)).toBe(0) // tree grew: no longer foreign
    expect(unspentNotes(w).map((n) => n.blinding).sort()).toEqual(["a", "b", "d"])
  })
})

describe("one note, one entry (concurrent lanes guess the same leaf index)", () => {
  const w = wallet("lanes-same-guess")
  beforeEach(() => clearNotes(w))

  it("never merges another lane's pending guess, so no note gets two spendable copies", () => {
    // two lanes proved against the same tree state: both change notes were
    // saved pending at the same guessed index 501
    saveNote(w, note({ index: 501, blinding: "c1", amount: "100", pending: true }))
    saveNote(w, note({ index: 501, blinding: "c2", amount: "200", pending: true }))
    // c1 lands at 501 (scan), c2 at 503
    upsertNote(w, note({ index: 501, blinding: "c1", amount: "100" }))
    upsertNote(w, note({ index: 503, blinding: "c2", amount: "200" }))
    const live = unspentNotes(w)
    expect(live.map((n) => `${n.blinding}@${n.index}`).sort()).toEqual(["c1@501", "c2@503"])
    expect(loadNotes(w)).toHaveLength(2)
  })

  it("keeps a spent note spent when a scan re-upserts it as unspent", () => {
    const n = note({ index: 7, blinding: "x", amount: "5" })
    saveNote(w, n)
    markNoteSpent(w, n.id, "SIG")
    upsertNote(w, note({ index: 7, blinding: "x", amount: "5", spent: false }))
    expect(unspentNotes(w)).toHaveLength(0)
    markNoteUnspent(w, n.id)
    expect(unspentNotes(w)).toHaveLength(1)
  })

  it("lists a note once even if an older store holds two copies", () => {
    saveNote(w, note({ index: 9, blinding: "dup", amount: "5" }))
    saveNote(w, note({ index: 9, blinding: "dup", amount: "5" }))
    expect(unspentNotes(w)).toHaveLength(1)
  })
})

describe("a fresh change note never clobbers the note at its guessed index", () => {
  const w = wallet("guess-collides")
  beforeEach(() => clearNotes(w))

  it("keeps the settled note (and its id) when a pending note guesses the same leaf", () => {
    const real = note({ index: 2319, blinding: "real", amount: "700" })
    saveNote(w, real)
    // another lane's change note, saved at its guessed index = the same leaf
    saveNote(w, note({ index: 2319, blinding: "guess", amount: "300", pending: true }))
    const live = unspentNotes(w)
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(real.id)
    expect(live[0].blinding).toBe("real")
    expect(loadNotes(w)).toHaveLength(2)
  })
})

describe("spent-by-index never hits another note's pending guess", () => {
  const w = wallet("spent-by-index")
  beforeEach(() => clearNotes(w))

  it("marks only the note with that blinding", () => {
    const old = note({ index: 4431, blinding: "old", amount: "5" })
    saveNote(w, old)
    // another lane's fresh change note guessed the same leaf
    saveNote(w, note({ index: 4431, blinding: "change", amount: "9", pending: true }))
    markNoteSpentByIndex(w, SOL, 4431, undefined, "old")
    const change = loadNotes(w).find((n) => n.blinding === "change")!
    expect(change.spent).toBe(false)
    expect(loadNotes(w).find((n) => n.blinding === "old")!.spent).toBe(true)
  })
})
