import { useMemo } from "react"
import { useWallet } from "@solana/wallet-adapter-react"

import { PrivacyCashClient } from "privacy-cash-sdk"

export function usePrivacyCash() {
  const { publicKey, signMessage, signTransaction } = useWallet()

  const connected = !!(publicKey && signMessage && signTransaction)

  const client = useMemo(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return null
    return new PrivacyCashClient({
      publicKey,
      signMessage,
      signTransaction,
    })
  }, [connected, publicKey, signMessage, signTransaction])

  return { client, connected, publicKey }
}
