import { config } from "@/lib/config"

/**
 * Explorer URLs for the configured cluster: a local simnet gets a
 * custom-cluster link (so demo txs actually resolve), otherwise the cluster
 * comes from VITE_SOLANA_CLUSTER (devnet by default). It can't come from the
 * RPC URL: the app reaches Solana through the backend's /rpc, which names no
 * cluster, so a URL check sent every devnet link to mainnet.
 */
const CLUSTER: string = import.meta.env.VITE_SOLANA_CLUSTER || "devnet"

function clusterParams(): string {
  const rpc = config.get().rpcUrl
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(rpc)) {
    return `cluster=custom&customUrl=${encodeURIComponent(rpc)}`
  }
  if (CLUSTER === "mainnet-beta" || CLUSTER === "mainnet") return ""
  return `cluster=${encodeURIComponent(CLUSTER)}`
}

export function explorerTxUrl(signature: string): string {
  const p = clusterParams()
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${p ? `?${p}` : ""}`
}

export function explorerAddressUrl(address: string): string {
  const p = clusterParams()
  return `https://explorer.solana.com/account/${encodeURIComponent(address)}${p ? `?${p}` : ""}`
}

export function isLocalRpc(): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)/.test(config.get().rpcUrl)
}
