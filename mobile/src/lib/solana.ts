// Devnet RPC helpers for the connected wallet's PUBLIC (unshielded) balances.
// The bridge/SDK only ever sees shielded notes, so the wallet's spendable SOL and
// SPL token balances are read here directly from an RPC. Kept tiny: two POSTs.

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

/**
 * Wallet's public SPL token balance (raw units, e.g. 6-decimals for USDC) for the
 * given mint. Uses getTokenAccountsByOwner; returns 0 if there is no ATA.
 */
export async function fetchSplBalance(
  cluster: string,
  address: string,
  mint: string,
): Promise<{ raw: number; decimals: number }> {
  try {
    const r = await post(cluster, "getTokenAccountsByOwner", [
      address,
      { mint },
      { encoding: "jsonParsed" },
    ]);
    const acc = (r?.value ?? [])[0];
    const raw = Number(acc?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
    const decimals = Number(acc?.account?.data?.parsed?.info?.tokenAmount?.decimals ?? 0);
    return { raw, decimals };
  } catch {
    return { raw: 0, decimals: 0 };
  }
}

/** Mint decimals (0 if the mint doesn't exist / RPC error). Needed to convert a
 *  human SPL amount <-> raw units for deposit/transfer. */
export async function fetchMintDecimals(cluster: string, mint: string): Promise<number> {
  try {
    const r = await post(cluster, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const d = Number(r?.value?.data?.parsed?.info?.decimals ?? 0);
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}
