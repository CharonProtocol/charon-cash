import { RECEIVE_SIGN_MESSAGE, SIGN_MESSAGE } from "./constants"
import type { Signer } from "./client"

/**
 * Wrap a wallet signer so the two unlock signatures (note keys + receive key)
 * are kept for this browser tab (sessionStorage: gone when the tab closes): a
 * page reload unlocks without prompting again. Every other message (registry,
 * backup-key link) is always signed fresh. Outside a browser it is a no-op.
 */
export function rememberUnlockSigner(signer: Signer): Signer {
  const kindOf = (m: Uint8Array) => {
    const text = new TextDecoder().decode(m)
    return text === SIGN_MESSAGE ? "notes" : text === RECEIVE_SIGN_MESSAGE ? "receive" : null
  }
  return {
    ...signer,
    signMessage: async (message: Uint8Array) => {
      const kind = kindOf(message)
      if (!kind || typeof sessionStorage === "undefined") return signer.signMessage(message)
      const key = `charon:unlock:${kind}:${signer.publicKey.toBase58()}`
      try {
        const hit = sessionStorage.getItem(key)
        if (hit) return Uint8Array.from(atob(hit), (c) => c.charCodeAt(0))
      } catch {
        // storage blocked: sign as usual
      }
      const sig = await signer.signMessage(message)
      try {
        sessionStorage.setItem(key, btoa(String.fromCharCode(...sig)))
      } catch {
        // private mode / quota: the next load signs again
      }
      return sig
    },
  }
}
