import type { PrivacyCashClient } from "privacy-cash-sdk"

// Unlocked clients live once per wallet for the whole SPA session. Route
// switches remount the app shells; re-deriving the note keypair needs a
// wallet signature, so without this cache every employer/employee switch
// would re-prompt. Only clients that finished init + unlock get cached.
const cache = new Map<string, PrivacyCashClient>()

export function getCachedClient(wallet: string): PrivacyCashClient | undefined {
  return cache.get(wallet)
}

export function cacheClient(wallet: string, c: PrivacyCashClient): void {
  cache.set(wallet, c)
}
