import { useEffect, useRef } from "react"

import { usePrivacyCash } from "./usePrivacyCash"

/**
 * Best-effort restore of the encrypted note blob from the backend into local
 * storage when a wallet connects (or switches). The SDK does the encryption —
 * the backend only ever stores ciphertext, so this never exposes note secrets.
 */
export function useNotesSync() {
  const { client, connected } = usePrivacyCash()
  const restoredFor = useRef<string | null>(null)

  useEffect(() => {
    if (!client || !connected) return
    const pk = client.publicKey.toBase58()
    if (restoredFor.current === pk) return
    restoredFor.current = pk
    client.restoreNotes().catch(() => {
      /* restore is best-effort; local storage is still the primary source */
    })
  }, [client, connected])
}
