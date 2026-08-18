import { useCallback, useEffect, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import {
  PrivacyCashClient,
  fetchRelayerInfo,
  totalBalance,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

export function usePayrollClient() {
  const { publicKey, signMessage, signTransaction, connect } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vaultSolRaw, setVaultSolRaw] = useState<bigint | null>(null)
  const [bps, setBps] = useState<number | null>(null)
  const clientRef = useRef<PrivacyCashClient | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)

  const connected = !!(publicKey && signMessage && signTransaction)

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return
    const c = new PrivacyCashClient({ publicKey, signMessage, signTransaction })
    clientRef.current = c
    setClient(c)
    setBusy(true)
    setError(null)
    ;(async () => {
      try {
        await c.init()
        const info = await fetchRelayerInfo()
        setBps(info.withdrawalFeeRateBps)
        await c.unlock() // wallet signature popup: derives the note keypair
        await c.refreshNotes()
        setVaultSolRaw(totalBalance(publicKey, WRAPPED_SOL_MINT))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    })()
  }, [connected, publicKey, signMessage, signTransaction])

  const refreshVault = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    await c.refreshNotes()
    setVaultSolRaw(totalBalance(c.publicKey, WRAPPED_SOL_MINT))
  }, [])

  return { client, ready: connected && !!client && !busy, busy, error, vaultSolRaw, bps, connect, refreshVault }
}
