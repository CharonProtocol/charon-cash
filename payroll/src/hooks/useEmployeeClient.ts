import { useCallback, useEffect, useRef, useState } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import {
  PrivacyCashClient,
  fetchRecipientKeys,
  fetchRelayerInfo,
  totalBalance,
  unspentNotes,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

export function useEmployeeClient() {
  const { publicKey, signMessage, signTransaction } = useWallet()
  const { connection } = useConnection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)
  const [registered, setRegistered] = useState<boolean | null>(null)
  const [noteSolRaw, setNoteSolRaw] = useState<bigint | null>(null)
  const [walletSolRaw, setWalletSolRaw] = useState<number | null>(null)
  const [bps, setBps] = useState<number | null>(null)
  const [minFee, setMinFee] = useState(0)
  const clientRef = useRef<PrivacyCashClient | null>(null)

  const connected = !!(publicKey && signMessage && signTransaction)

  const rescan = useCallback(
    async (c?: PrivacyCashClient) => {
      const cl = c ?? clientRef.current
      if (!cl || !publicKey) return
      await cl.refreshNotes()
      setNoteSolRaw(totalBalance(publicKey, WRAPPED_SOL_MINT))
      try {
        setWalletSolRaw(await connection.getBalance(publicKey))
      } catch {
        setWalletSolRaw(null)
      }
    },
    [publicKey, connection],
  )

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return
    let cancelled = false
    const c = new PrivacyCashClient({ publicKey, signMessage, signTransaction })
    clientRef.current = c
    setClient(c)
    setBusy(true)
    setError(null)
    setRegistered(null)
    ;(async () => {
      try {
        const keys = await fetchRecipientKeys(publicKey)
        if (cancelled) return
        setRegistered(!!keys)
        const info = await fetchRelayerInfo()
        if (cancelled) return
        setBps(info.withdrawalFeeRateBps)
        const floor = Math.floor(Number(info.minTransferFee))
        setMinFee(Number.isFinite(floor) && floor > 0 ? floor : 0)
        if (keys) {
          await c.init()
          await c.unlock()
          await rescan(c)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, publicKey, signMessage, signTransaction, rescan])

  const notes = useCallback(() => {
    if (!publicKey) return []
    return unspentNotes(publicKey).filter((n) => n.mintAddress === WRAPPED_SOL_MINT)
  }, [publicKey])

  return {
    connected,
    client,
    busy,
    error,
    registered,
    noteSolRaw,
    walletSolRaw,
    bps,
    minFee,
    rescan: () => rescan(),
    notes,
  }
}
