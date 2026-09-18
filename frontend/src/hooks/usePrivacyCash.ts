import { useMemo } from "react"
import { useWallet } from "@solana/wallet-adapter-react"

import { PrivacyCashClient } from "privacy-cash-sdk"

export function usePrivacyCash() {
  const { publicKey, signMessage, signTransaction, signIn } = useWallet()

  const connected = !!(publicKey && signTransaction && signIn)

  const client = useMemo(() => {
    if (!publicKey || !signTransaction || !signIn) return null
    return new PrivacyCashClient({
      publicKey,
      signMessage:
        signMessage ??
        (async () => {
          throw new Error("signMessage is not used for unlock; Sign In With Solana is required")
        }),
      signTransaction,
      signIn: async (input) => {
        const out = await signIn(input)
        return {
          signature: Uint8Array.from(out.signature),
          signedMessage: Uint8Array.from(out.signedMessage),
        }
      },
    })
  }, [publicKey, signMessage, signTransaction, signIn])

  return { client, connected, publicKey }
}
