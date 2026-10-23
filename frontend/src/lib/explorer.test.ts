import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('./explorer')).explorerTxUrl;
};

describe('explorerTxUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at devnet when the RPC is the backend /rpc (the URL names no cluster)', async () => {
    const url = await load({ VITE_SOLANA_RPC_URL: 'https://backend.charon.cash/rpc' });
    expect(url('SIG')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
  });

  it('follows VITE_SOLANA_CLUSTER, mainnet with no param', async () => {
    const url = await load({ VITE_SOLANA_RPC_URL: 'https://backend.charon.cash/rpc', VITE_SOLANA_CLUSTER: 'mainnet-beta' });
    expect(url('SIG')).toBe('https://explorer.solana.com/tx/SIG');
  });

  it('uses a custom-cluster link for a local chain', async () => {
    const url = await load({ VITE_SOLANA_RPC_URL: 'http://localhost:8899' });
    expect(url('SIG')).toBe('https://explorer.solana.com/tx/SIG?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899');
  });
});
