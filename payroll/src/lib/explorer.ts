import { config } from "@/lib/config"

/**
 * Explorer URLs that follow the configured RPC: a local simnet gets a
 * custom-cluster link (so demo txs actually resolve), devnet gets
 * cluster=devnet, anything else is treated as mainnet.
 */
function clusterParams(): string {
  const rpc = config.get().rpcUrl
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(rpc)) {
    return `cluster=custom&customUrl=${encodeURIComponent(rpc)}`
  }
  if (rpc.includes("devnet")) return "cluster=devnet"
  return ""
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
