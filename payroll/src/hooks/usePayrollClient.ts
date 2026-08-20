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
    // Stale guard: if the wallet re-keyed while init was in flight, the
    // results below belong to a client nobody holds anymore.
    let cancelled = false
    const c = new PrivacyCashClient({ publicKey, signMessage, signTransaction })
    clientRef.current = c
    setClient(c)
    setBusy(true)
    setError(null)
    ;(async () => {
      try {
        await c.init()
        const info = await fetchRelayerInfo()
        if (cancelled) return
        setBps(info.withdrawalFeeRateBps)
        await c.unlock() // wallet signature popup: derives the note keypair
        await c.refreshNotes()
        if (cancelled) return
        setVaultSolRaw(totalBalance(publicKey, WRAPPED_SOL_MINT))
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, publicKey, signMessage, signTransaction])

  const refreshVault = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    await c.refreshNotes()
    setVaultSolRaw(totalBalance(c.publicKey, WRAPPED_SOL_MINT))
  }, [])

  return { client, ready: connected && !!client && !busy, busy, error, vaultSolRaw, bps, connect, refreshVault }
}
