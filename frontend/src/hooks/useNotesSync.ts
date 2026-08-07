import { useEffect, useRef } from "react"

import { usePrivacyCash } from "./usePrivacyCash"

/**
 * With DB-only note storage, decrypted notes are never persisted to the browser.
 * Viewing them requires the wallet key, so loading is a deliberate user action:
 * the "Load notes" button (or any deposit/withdraw), which unlocks (one
 * signature), pulls the encrypted backend blob into memory, and re-scans the
 * indexer. We intentionally do NOT auto-prompt a signature on wallet connect.
 */
export function useNotesSync() {
  const { client, connected } = usePrivacyCash()
  const restoredFor = useRef<string | null>(null)

  useEffect(() => {
    if (!client || !connected) return
    const pk = client.publicKey.toBase58()
    if (restoredFor.current === pk) return
    restoredFor.current = pk
    // No auto-restore: a signature prompt on connect is poor UX, and notes are
    // only needed when the user actually acts (deposit/withdraw) or clicks
    // "Load notes" in the vault — both of which unlock and seed memory.
  }, [client, connected])
}
