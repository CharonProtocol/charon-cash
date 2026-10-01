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
  const [minTransferFee, setMinTransferFee] = useState(0)
  const clientRef = useRef<PrivacyCashClient | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const [unlockBusy, setUnlockBusy] = useState(false)

  const connected = !!(publicKey && signMessage && signTransaction)

  useEffect(() => {
    // Relayer health is wallet-independent: fetch it on mount so the badge
    // tells the truth before the treasury wallet is connected.
    let cancelled = false
    fetchRelayerInfo()
      .then((info) => {
        if (cancelled) return
        setBps(info.withdrawalFeeRateBps)
        const floor = Math.floor(Number(info.minTransferFee))
        setMinTransferFee(Number.isFinite(floor) && floor > 0 ? floor : 0)
      })
      .catch(() => {
        // badge stays "down"; the wallet effect retries after connect
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return
    // Stale guard: if the wallet re-keyed while init was in flight, the
    // results below belong to a client nobody holds anymore.
    let cancelled = false
    setUnlocked(false)
    setUnlockBusy(false)
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
        // min_transfer_fee is network data heading into BigInt() sinks:
        // coerce garbage to 0 (older backends lack the field; the planner
        // then degrades to bps-only fees) and clamp negatives off.
        const floor = Math.floor(Number(info.minTransferFee))
        setMinTransferFee(Number.isFinite(floor) && floor > 0 ? floor : 0)
        // No signature prompt on connect: unlocking derives the note keypair
        // from a wallet signature, which is a user-surprising popup here.
        // The wallet stays locked until "Unlock vault" (or the first run,
        // which unlocks through the engine).
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

  const unlockNow = useCallback(async () => {
    const c = clientRef.current
    if (!c || unlockBusy || unlocked) return
    setUnlockBusy(true)
    try {
      await c.unlock() // wallet signature popup: derives the note keypair
      await c.refreshNotes()
      setVaultSolRaw(totalBalance(c.publicKey, WRAPPED_SOL_MINT))
      setUnlocked(true)
    } finally {
      setUnlockBusy(false)
    }
  }, [unlockBusy, unlocked])

  const refreshVault = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    if (!unlocked) {
      await unlockNow()
      return
    }
    await c.refreshNotes()
    setVaultSolRaw(totalBalance(c.publicKey, WRAPPED_SOL_MINT))
  }, [unlocked, unlockNow])

  return {
    client,
    ready: connected && !!client && !busy,
    busy,
    error,
    vaultSolRaw,
    bps,
    minTransferFee,
    connect,
    refreshVault,
    unlocked,
    unlockBusy,
    unlockNow,
  }
}
