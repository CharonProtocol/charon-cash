import "fake-indexeddb/auto";

import { describe, beforeAll, test, expect } from "bun:test";
import { StorageService, StoredNoteSchema } from "../../src/storage";
import { randomBytes } from "@noble/ciphers/utils.js";
import bs from "bs58";
const localStorageMock = {
  store: new Map<string, string>(),

  getItem(key: string) {
    return this.store.get(key) ?? null;
  },

  setItem(key: string, value: string) {
    this.store.set(key, value);
  },

  removeItem(key: string) {
    this.store.delete(key);
  },

  clear() {
    this.store.clear();
  },

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  },

  get length() {
    return this.store.size;
  },
};

globalThis.localStorage = localStorageMock as Storage;

describe("Storage Service ", () => {
  // Wallet's
  let alice = bs.encode(randomBytes(32));
  let charlie = bs.encode(randomBytes(32));
  let bob = bs.encode(randomBytes(32));

  let storage: StorageService;
  beforeAll(async () => {
    storage = await StorageService.start();
  });

  test("Insertion for Alice's wallet is successfull, Single Note , BatchNotes", async () => {
    let newNote = randomBytes(32);
    await storage.saveNote(alice, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveNoteBatch(alice, batchOfNotes);
    const notes = await storage.loadNotes(alice);

    expect(notes).toHaveLength(11);
  });
  test("Insertion for Bob's wallet is successfull, Single Note , BatchNotes", async () => {
    let newNote = randomBytes(32);
    await storage.saveNote(bob, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveNoteBatch(bob, batchOfNotes);
    const notes = await storage.loadNotes(bob);

    expect(notes).toHaveLength(11);
  });
  test("Insertion for Charlie's wallet is successfull, Single Note , BatchNotes", async () => {
    let newNote = randomBytes(32);
    await storage.saveNote(charlie, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveNoteBatch(charlie, batchOfNotes);
    const notes = await storage.loadNotes(charlie);

    expect(notes).toHaveLength(11);
  });

  test("Alice is only able to retreive notes belonging to them", async () => {
    let notes: StoredNoteSchema[] = await storage.loadNotes(alice);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(alice);
    }
  });
  test("Bob is only able to retreive notes belonging to them", async () => {
    let notes: StoredNoteSchema[] = await storage.loadNotes(bob);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(bob);
    }
  });
  test("Charlie is only able to retreive notes belonging to them", async () => {
    let notes: StoredNoteSchema[] = await storage.loadNotes(charlie);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(charlie);
    }
  });

  test("User can load notes from id 5 & above ", async () => {
    let notes: StoredNoteSchema[] = await storage.loadNotesFrom(alice, 5);

    expect(notes).toHaveLength(6);

    let expectedNoteId = 6;
    for (const note of notes) {
      expect(note.walletPubkey).toBe(alice);
      expect(note.id).toBe(expectedNoteId++);
    }
  });
  test("User can load notes pair of notes ", async () => {
    // 12 belong to
    let notes: StoredNoteSchema[] = await storage.loadPairOfNotes(12, 13);

    expect(notes).toHaveLength(2);

    let expectedNoteId = 12;
    for (const note of notes) {
      expect(note.walletPubkey).toBe(bob);
      expect(note.id).toBe(expectedNoteId++);
    }
  });
  test("User can load notes pair of notes ", async () => {
    // 12 belong to
    let note: StoredNoteSchema = await storage.loadSingleNote(23);

    expect(note.walletPubkey).toBe(charlie);
    expect(note.id).toBe(23);
  });

  test("User can load note index", async () => {
    let index = await storage.getNextNodeToFetchIndex(alice);

    expect(index.index).toBe(0);
    expect(index.walletPubkey).toBe(alice);
  });
  test("User can save note", async () => {
    let save = await storage.updateNextNodeToFetchIndex(alice, 0);
    let index = await storage.getNextNodeToFetchIndex(alice);

    expect(index.index).toBe(0);
    expect(index.walletPubkey).toBe(alice);
  });
});
