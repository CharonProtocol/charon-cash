import { describe, expect, mock, test, spyOn, beforeAll, afterAll } from 'bun:test';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { Utxo } from '../../src/model/utxo';
import { WRAPPED_SOL_MINT } from '../../src/constants';
const transact = mock(async () => 'confirmed');
mock.module('../../src/program', () => ({ transactSol: transact }));
const { CharonProtocol } = await import('../../src/client');
let log: ReturnType<typeof spyOn>;
beforeAll(() => { log = spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => log.mockRestore());
function fixture() {
  const lightwasm = { poseidonHashString: () => '1' } as any;
  const notes = [100, 200, 300].map((amount, index) => ({ id: (index + 1) * 10, walletPubkey: 'wallet', encryptedUtxo: new Utxo({ lightWasm: lightwasm, amount }).serialize() }));
  const state = Object.assign(Object.create(CharonProtocol.prototype), {
    signer: { publicKey: new PublicKey('11111111111111111111111111111111') },
    storageService: {
      loadUtxosFrom: async (_wallet: string, from: number) => notes.filter(note => note.id > from),
      loadUtxo: async (id: number) => notes.find(note => note.id === id),
      loadPairOfUtxo: async (a: number, b: number) => [notes.find(note => note.id === a), notes.find(note => note.id === b)],
      removeUtxo: async (id: number) => { notes.splice(notes.findIndex(note => note.id === id), 1); },
    },
    encryptionService: { decrypt: async (data: Uint8Array) => data },
    lightwasm, utxoByMint: new Map(), lastLoadedNote: 0,
  });
  return { client: state as InstanceType<typeof CharonProtocol>, notes };
}
describe('stale balance regression', () => {
  test('sync tracks actual storage IDs without counting notes twice', async () => {
    const { client } = fixture();
    await client.syncUtxos();
    await client.syncUtxos();
    expect(client.lastLoadedNote).toBe(30);
    const summary = client.utxoByMint.get(WRAPPED_SOL_MINT)!;
    expect(summary.totalAmount.toString()).toBe('600');
    expect(summary.maxSingleTxAmount.toString()).toBe('500');
    expect(summary.utxos).toHaveLength(3);
  });
  test('withdrawal refreshes balance and keeps unspent notes', async () => {
    const { client, notes } = fixture();
    await client.withdrawSol(250);
    expect(notes.map(note => note.id)).toEqual([30]);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.toString()).toBe('300');
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.maxSingleTxAmount.toString()).toBe('300');
    await client.withdrawSol(300);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.eq(new BN(0))).toBe(true);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.maxSingleTxAmount.isZero()).toBe(true);
  });
  test('failed transaction preserves spendable notes and balances', async () => {
    const { client, notes } = fixture();
    transact.mockRejectedValueOnce(new Error('rejected'));
    await expect(client.withdrawSol(250)).rejects.toThrow('rejected');
    expect(notes).toHaveLength(3);
    expect(client.utxoByMint.get(WRAPPED_SOL_MINT)!.totalAmount.toString()).toBe('600');
  });
});
