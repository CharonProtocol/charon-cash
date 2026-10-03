import { setBackendUrl } from "privacy-cash-sdk"

export interface PayrollConfig {
  backendUrl: string
  rpcUrl: string
  /** Optional faster RPC (e.g. Helius). Used for confirmations so signature
   *  websockets and status calls skip the public endpoint's rate limits. */
  fastRpcUrl?: string
}

const KEY = "payroll:settings:v1"

const DEFAULTS: PayrollConfig = {
  backendUrl: "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
  rpcUrl: "https://api.devnet.solana.com",
  // Optional faster RPC for confirmations (websocket + status), e.g. a Helius
  // endpoint. Injected at build time via VITE_FAST_RPC_URL in .env.local —
  // never committed, never defaulted here.
  fastRpcUrl: import.meta.env.VITE_FAST_RPC_URL || undefined,
}

function read(): PayrollConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<PayrollConfig>
    return {
      backendUrl: parsed.backendUrl?.trim() || DEFAULTS.backendUrl,
      rpcUrl: parsed.rpcUrl?.trim() || DEFAULTS.rpcUrl,
      fastRpcUrl: parsed.fastRpcUrl?.trim() || DEFAULTS.fastRpcUrl,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const config = {
  get: read,
  set(patch: Partial<PayrollConfig>): void {
    const next: PayrollConfig = { ...read() }
    if (patch.backendUrl?.trim()) next.backendUrl = patch.backendUrl.trim()
    if (patch.rpcUrl?.trim()) next.rpcUrl = patch.rpcUrl.trim()
    if (patch.fastRpcUrl !== undefined) next.fastRpcUrl = patch.fastRpcUrl.trim() || undefined
    localStorage.setItem(KEY, JSON.stringify(next))
  },
  /** RPC for latency-sensitive calls (confirm), falling back to the base. */
  confirmRpcUrl(): string {
    const { fastRpcUrl, rpcUrl } = read()
    // The fast RPC is a remote cluster endpoint (e.g. devnet Helius); a
    // local simnet's signatures can never appear there, so confirming
    // against it means every payout idles out without its green tick.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(rpcUrl)
    const url = fastRpcUrl && !local ? fastRpcUrl : rpcUrl
    // The lib derives the websocket host from the endpoint scheme; a wss://
    // Helius URL works for HTTP calls once rewritten to https.
    return url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://")
  },
  /** Point the SDK at the configured backend. Call once at app boot. */
  apply(): void {
    setBackendUrl(read().backendUrl)
  },
}
