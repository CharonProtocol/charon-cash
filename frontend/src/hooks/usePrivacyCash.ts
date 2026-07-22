import { useMemo } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"

import { PrivacyCashClient } from "@privacy-cash/client"

export function usePrivacyCash() {
  const { connection } = useConnection()
  const { publicKey, signMessage, signTransaction } = useWallet()

  const connected = !!(publicKey && signMessage && signTransaction)

  const client = useMemo(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return null
    return new PrivacyCashClient(connection, {
      publicKey,
      signMessage,
      signTransaction,
    })
  }, [connected, publicKey, signMessage, signTransaction, connection])

  return { client, connected, publicKey, connection }
}
