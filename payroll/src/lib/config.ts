import { setBackendUrl } from "privacy-cash-sdk"

export interface PayrollConfig {
  backendUrl: string
  rpcUrl: string
  /** Optional faster RPC (e.g. Helius). Used for confirmations so signature
   *  websockets and status calls skip the public endpoint's rate limits. */
  fastRpcUrl?: string
  /** CPU cores the prover may plan for; unset = what the browser reports.
   *  Privacy browsers fake navigator.hardwareConcurrency (Helium reported 4
   *  and 6 on an 8-core M1, which halved the prover pool). */
  cores?: number
}

// Settings used to persist here: drop that copy so an old saved backend
// can't outlive this build (there is no Settings screen any more).
const RETIRED_KEY = "payroll:settings:v1"
try {
  localStorage.removeItem(RETIRED_KEY)
} catch {
  // storage blocked: nothing to clean
}

/** Fixed at build time: devnet by default, the local stack via
 *  .env.development.local (written by ./run.sh, dev server only). */
const DEFAULTS: PayrollConfig = {
  backendUrl: import.meta.env.VITE_BACKEND_URL || "https://backend.charon.cash",
  rpcUrl: import.meta.env.VITE_SOLANA_RPC_URL || "https://api.devnet.solana.com",
  // Optional faster RPC for confirmations (websocket + status), e.g. a Helius
  // endpoint. Injected at build time via VITE_FAST_RPC_URL in .env.local —
  // never committed, never defaulted here.
  fastRpcUrl: import.meta.env.VITE_FAST_RPC_URL || undefined,
}

/** In-memory overrides for this page only (the headless bench sets them). */
let overrides: Partial<PayrollConfig> = {}

function read(): PayrollConfig {
  return { ...DEFAULTS, ...overrides }
}

export const config = {
  get: read,
  /** Page-only override (not persisted): the headless bench points at its stack. */
  set(patch: Partial<PayrollConfig>): void {
    const next: Partial<PayrollConfig> = { ...overrides }
    if (patch.backendUrl?.trim()) next.backendUrl = patch.backendUrl.trim()
    if (patch.rpcUrl?.trim()) next.rpcUrl = patch.rpcUrl.trim()
    if (patch.fastRpcUrl !== undefined) next.fastRpcUrl = patch.fastRpcUrl.trim() || undefined
    if ("cores" in patch) next.cores = patch.cores && patch.cores > 0 ? Math.min(128, Math.floor(patch.cores)) : undefined
    overrides = next
  },
  /** Cores the prover plans for: an override, else the browser's report. */
  cores(): number {
    return read().cores ?? (navigator.hardwareConcurrency || 4)
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
