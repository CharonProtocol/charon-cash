import { setBackendUrl } from "privacy-cash-sdk"

export interface PayrollConfig {
  backendUrl: string
  rpcUrl: string
}

const KEY = "payroll:settings:v1"

const DEFAULTS: PayrollConfig = {
  backendUrl: "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
  rpcUrl: "https://api.devnet.solana.com",
}

function read(): PayrollConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<PayrollConfig>
    return {
      backendUrl: parsed.backendUrl?.trim() || DEFAULTS.backendUrl,
      rpcUrl: parsed.rpcUrl?.trim() || DEFAULTS.rpcUrl,
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
    localStorage.setItem(KEY, JSON.stringify(next))
  },
  /** Point the SDK at the configured backend. Call once at app boot. */
  apply(): void {
    setBackendUrl(read().backendUrl)
  },
}
