import { useMemo } from "react"
import { useWallet } from "@solana/wallet-adapter-react"

import { PrivacyCashClient, type Signer } from "privacy-cash-sdk"

export function usePrivacyCash() {
  const { publicKey, signMessage, signTransaction } = useWallet()

  const connected = !!(publicKey && signMessage && signTransaction)

  const signer = useMemo<Signer | null>(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return null
    return {
      publicKey,
      signMessage,
      signTransaction,
    }
  }, [connected, publicKey, signMessage, signTransaction])

  const client = useMemo(
    () => (signer ? new PrivacyCashClient(signer) : null),
    [signer],
  )

  return { client, signer, connected, publicKey }
}
