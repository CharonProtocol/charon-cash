// Devnet RPC helpers for the connected wallet's PUBLIC (unshielded) balance.
// The bridge/SDK only ever sees shielded notes, so the wallet's spendable SOL is
// read here directly from an RPC. Kept tiny: one POST.

const RPC_BY_CLUSTER: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet_beta: "https://api.mainnet-beta.solana.com",
  testnet: "https://api.testnet.solana.com",
};

function rpc(cluster: string): string {
  return RPC_BY_CLUSTER[cluster] ?? RPC_BY_CLUSTER.devnet;
}

async function post(cluster: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpc(cluster), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? "RPC error");
  return j.result;
}

/** Wallet's public SOL balance in lamports (0 on any error / rate limit). */
export async function fetchSolBalance(cluster: string, address: string): Promise<number> {
  try {
    const r = await post(cluster, "getBalance", [address]);
    return typeof r?.value === "number" ? r.value : 0;
  } catch {
    return 0;
  }
}
