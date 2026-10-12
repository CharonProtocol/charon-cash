import { describe, expect, mock, test } from "bun:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { Utxo } from "../../src/model/utxo";
import { WRAPPED_SOL_MINT } from "../../src/constants";

const transact = mock(async () => "confirmed");
mock.module("../../src/program", () => ({
  transactSol: transact,
  transactSpl: transact,
  shieldedTransferSol: transact,
  shieldedTransferSpl: transact,
}));
const { CharonProtocol } = await import("../../src/client");

function fixture() {
  const lightwasm = { poseidonHashString: () => "1" } as any;
  const makeNote = (amount: number, id: number) => ({
    id,
    walletPubkey: "wallet",
    encryptedUtxo: new Utxo({ lightWasm: lightwasm, amount }).serialize(),
  });
  const notes = [100, 200, 300].map((amount, i) => makeNote(amount, (i + 1) * 10));
  const loadAll = mock(async () => [...notes]);
  const state = Object.assign(Object.create(CharonProtocol.prototype), {
    signer: { publicKey: new PublicKey("11111111111111111111111111111111") },
    storageService: {
      loadUtxosFrom: async (_wallet: string, from: number) => notes.filter(note => note.id > from),
      loadUtxoBatch: loadAll,
      loadUtxo: async (id: number) => notes.find(note => note.id === id),
      loadPairOfUtxo: async (a: number, b: number) => [notes.find(note => note.id === a), notes.find(note => note.id === b)],
      removeUtxo: async (id: number) => { notes.splice(notes.findIndex(note => note.id === id), 1); },
    },
    encryptionService: { decrypt: async (data: Uint8Array) => data },
    lightwasm,
    utxoByMint: new Map(),
    lastLoadedNote: 0,
    balanceListeners: new Set(),
    worker: { postMessage: mock(() => {}) },
  });
  return { client: state as InstanceType<typeof CharonProtocol>, notes, loadAll, makeNote };
}

describe("balance sync", () => {
  test("repeated incremental sync does not count notes twice or scan the full store", async () => {
    const { client, loadAll } = fixture();
    await client.syncUtxos();
    await client.syncUtxos();
    expect(loadAll).not.toHaveBeenCalled();
    expect(client.lastLoadedNote).toBe(30);
    const summary = client.utxoByMint.get(WRAPPED_SOL_MINT)!;
    expect(summary.totalAmount.toString()).toBe("600");
    expect(summary.maxSingleTxAmount.toString()).toBe("500");
    expect(summary.utxos).toHaveLength(3);
  });

  test("explicit recovery finds older missing notes alongside new notes", async () => {
    const { client, notes, loadAll, makeNote } = fixture();
    await client.syncUtxos();
    client.utxoByMint.get(WRAPPED_SOL_MINT)!.utxos.shift();
    notes.push(makeNote(400, 40));
    await client.syncUtxos({ recoverMissing: true });
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(client.lastLoadedNote).toBe(40);
    const summary = client.utxoByMint.get(WRAPPED_SOL_MINT)!;
    expect(summary.totalAmount.toString()).toBe("1000");
    expect(summary.utxos).toHaveLength(4);
    await client.syncUtxos();
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(summary.totalAmount.toString()).toBe("1000");
  });

  test("withdrawal refreshes balances and retains unspent notes", async () => {
    const { client, notes, loadAll } = fixture();
    await client.withdrawSol(250);
    expect(notes.map(note => note.id)).toEqual([30]);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.toString()).toBe("300");
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.maxSingleTxAmount.toString()).toBe("300");
    await client.withdrawSol(300);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.eq(new BN(0))).toBe(true);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.maxSingleTxAmount.isZero()).toBe(true);
    expect(loadAll).not.toHaveBeenCalled();
  });

  test("a failed transaction preserves spendable notes and balances", async () => {
    const { client, notes } = fixture();
    transact.mockRejectedValueOnce(new Error("rejected"));
    await expect(client.withdrawSol(250)).rejects.toThrow("rejected");
    expect(notes).toHaveLength(3);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.toString()).toBe("600");
  });
});
