import { CLUSTER, RPC_URL } from './config';

/** Explorer link for a transaction on the configured cluster. */
export function explorerTxUrl(signature: string): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  if (CLUSTER === 'localnet') return `${base}?${new URLSearchParams({ cluster: 'custom', customUrl: RPC_URL })}`;
  if (CLUSTER === 'mainnet-beta' || CLUSTER === 'mainnet') return base;
  return `${base}?cluster=${encodeURIComponent(CLUSTER)}`;
}
