import { describe, it, expect, beforeEach } from "bun:test"
import type { PublicKey } from "@solana/web3.js"

import {
  loadNotes,
  saveNote,
  upsertNote,
  markNoteSpent,
  markNoteSpentByIndex,
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

function note(partial: Partial<Note> & { index: number }): Note {
  return {
    id: newNoteId(),
    amount: "1000",
    blinding: "12345",
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
