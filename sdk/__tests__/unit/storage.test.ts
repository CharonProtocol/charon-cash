import "fake-indexeddb/auto";

import { describe, beforeAll, test, expect } from "bun:test";
import { StorageService, StoredUtxoSchema } from "../../src/storage";
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
    await storage.saveUtxo(alice, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveUtxoBatch(alice, batchOfNotes);
    const notes = await storage.loadUtxoBatch(alice);

    expect(notes).toHaveLength(11);
  });
  test("Insertion for Bob's wallet is successfull, Single Note , BatchNotes", async () => {
    let newNote = randomBytes(32);
    await storage.saveUtxo(bob, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveUtxoBatch(bob, batchOfNotes);
    const notes = await storage.loadUtxoBatch(bob);

    expect(notes).toHaveLength(11);
  });
  test("Insertion for Charlie's wallet is successfull, Single Note , BatchNotes", async () => {
    let newNote = randomBytes(32);
    await storage.saveUtxo(charlie, newNote);

    let batchOfNotes: Uint8Array[] = [];

    for (let i = 0; i < 10; i++) {
      batchOfNotes.push(randomBytes(32));
    }

    await storage.saveUtxoBatch(charlie, batchOfNotes);
    const notes = await storage.loadUtxoBatch(charlie);

    expect(notes).toHaveLength(11);
  });

  test("Alice is only able to retreive notes belonging to them", async () => {
    let notes: StoredUtxoSchema[] = await storage.loadUtxoBatch(alice);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(alice);
    }
  });
  test("Bob is only able to retreive notes belonging to them", async () => {
    let notes: StoredUtxoSchema[] = await storage.loadUtxoBatch(bob);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(bob);
    }
  });
  test("Charlie is only able to retreive notes belonging to them", async () => {
    let notes: StoredUtxoSchema[] = await storage.loadUtxoBatch(charlie);

    expect(notes).toHaveLength(11);

    for (const note of notes) {
      expect(note.walletPubkey).toBe(charlie);
    }
  });

  test("User can load notes from id 5 & above ", async () => {
    let notes: StoredUtxoSchema[] = await storage.loadUtxosFrom(alice, 5);

    expect(notes).toHaveLength(6);

    let expectedNoteId = 6;
    for (const note of notes) {
      expect(note.walletPubkey).toBe(alice);
      expect(note.id).toBe(expectedNoteId++);
    }
  });
  test("User can load notes pair of notes ", async () => {
    // 12 belong to
    let notes: StoredUtxoSchema[] = await storage.loadPairOfUtxo(12, 13);

    expect(notes).toHaveLength(2);

    let expectedNoteId = 12;
    for (const note of notes) {
      expect(note.walletPubkey).toBe(bob);
      expect(note.id).toBe(expectedNoteId++);
    }
  });
  test("User can load notes pair of notes ", async () => {
    // 12 belong to
    let note: StoredUtxoSchema = await storage.loadUtxo(23);

    expect(note.walletPubkey).toBe(charlie);
    expect(note.id).toBe(23);
  });

  test("User can load note index", async () => {
    let index = await storage.getNextUtxoToFetchIndex(alice);

    expect(Number(index.index)).toBe(1);
    expect(index.walletPubkey).toBe(alice);
  });
  test("User can update note index", async () => {
    let save = await storage.updateNextUtxoToFetchIndex(alice, 0);
    let index = await storage.getNextUtxoToFetchIndex(alice);

    expect(Number(index.index)).toBe(0);
    expect(index.walletPubkey).toBe(alice);
  });
  test("User can successfully delete note", async () => {
    let utxos = await storage.loadUtxoBatch(alice);

    let numberOfUtxos = utxos.length;

    let utxoToBeDeleted = utxos[0];

    storage.removeUtxo(utxoToBeDeleted.id!);

    let utxosAfterDeletion = await storage.loadUtxoBatch(alice);

    expect(utxosAfterDeletion.length).toBe(numberOfUtxos - 1);
  });
});
