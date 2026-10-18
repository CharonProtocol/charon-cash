import { useCallback, useEffect, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import {
  PrivacyCashClient,
  fetchRelayerInfo,
  rememberUnlockSigner,
  totalBalance,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

import { assetMint, tokenAssets } from "@/lib/assets"
import { cacheClient, getCachedClient } from "@/lib/clientCache"
import type { Asset } from "@/lib/types"

function friendly(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  if (msg === "Failed to fetch" || msg.includes("NetworkError") || msg.includes("network")) {
    return "Couldn't reach the relayer or RPC - check the backend URL in Settings and your connection."
  }
  return msg
}

export function usePayrollClient() {
  const { publicKey, signMessage, signTransaction, connect } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** private balance per mint (SOL under WRAPPED_SOL_MINT); null until read */
  const [vaults, setVaults] = useState<Map<string, bigint> | null>(null)
  /** token pools the relayer runs (USDC, ...), beside SOL */
  const [tokens, setTokens] = useState<Asset[]>([])
  const tokensRef = useRef<Asset[]>([])
  const [bps, setBps] = useState<number | null>(null)
  const [minTransferFee, setMinTransferFee] = useState(0)
  const clientRef = useRef<PrivacyCashClient | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const [unlockBusy, setUnlockBusy] = useState(false)

  const connected = !!(publicKey && signMessage && signTransaction)

  const applyInfo = useCallback((info: Awaited<ReturnType<typeof fetchRelayerInfo>>) => {
    setBps(info.withdrawalFeeRateBps)
    // min_transfer_fee is network data heading into BigInt() sinks:
    // coerce garbage to 0 (older backends lack the field; the planner
    // then degrades to bps-only fees) and clamp negatives off.
    const floor = Math.floor(Number(info.minTransferFee))
    setMinTransferFee(Number.isFinite(floor) && floor > 0 ? floor : 0)
    tokensRef.current = tokenAssets(info)
    setTokens(tokensRef.current)
  }, [])

  const readVaults = useCallback((c: PrivacyCashClient) => {
    if (!c.publicKey) return
    const m = new Map<string, bigint>([[WRAPPED_SOL_MINT, totalBalance(c.publicKey, WRAPPED_SOL_MINT)]])
    for (const t of tokensRef.current) m.set(assetMint(t), totalBalance(c.publicKey, assetMint(t)))
    setVaults(m)
  }, [])

  useEffect(() => {
    // Relayer health is wallet-independent: fetch it on mount so the badge
    // tells the truth before the treasury wallet is connected.
    let cancelled = false
    fetchRelayerInfo()
      .then((info) => {
        if (!cancelled) applyInfo(info)
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
    const wallet = publicKey.toBase58()
    const cached = getCachedClient(wallet)
    if (cached) {
      // Already init'd + unlocked earlier in this session (route switch):
      // reuse it, no signature prompt, just refresh the vault quietly.
      clientRef.current = cached
      setClient(cached)
      setUnlocked(true)
      setUnlockBusy(false)
      setBusy(false)
      readVaults(cached)
      return
    }
    setUnlocked(false)
    setUnlockBusy(false)
    // unlock signatures kept for this tab: a reload doesn't prompt again
    const c = new PrivacyCashClient(rememberUnlockSigner({ publicKey, signMessage, signTransaction }))
    clientRef.current = c
    setClient(c)
    setBusy(true)
    setError(null)
    ;(async () => {
      try {
        await c.init()
        const info = await fetchRelayerInfo()
        if (cancelled) return
        applyInfo(info)
        // No signature prompt on connect: unlocking derives the note keypair
        // from a wallet signature, which is a user-surprising popup here.
        // The wallet stays locked until "Unlock vault" (or the first run,
        // which unlocks through the engine).
      } catch (e) {
        if (!cancelled) setError(friendly(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, publicKey, signMessage, signTransaction, applyInfo, readVaults])

  const unlockNow = useCallback(async () => {
    const c = clientRef.current
    if (!c || unlockBusy || unlocked) return
    setUnlockBusy(true)
    try {
      await c.unlock() // wallet signature popup: derives the note keypair
      await c.refreshNotes()
      readVaults(c)
      setUnlocked(true)
      if (c.publicKey) cacheClient(c.publicKey.toBase58(), c)
    } catch (e) {
      // Without this the rejection is unhandled: the button just silently
      // does nothing on a rejected signature or a failed notes refresh.
      toast.error(`Vault unlock failed: ${friendly(e)}`)
    } finally {
      setUnlockBusy(false)
    }
  }, [unlockBusy, unlocked, readVaults])

  const refreshVault = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    if (!unlocked) {
      await unlockNow()
      return
    }
    await c.refreshNotes()
    readVaults(c)
  }, [unlocked, unlockNow, readVaults])

  const vaultOf = useCallback(
    (asset: Asset): bigint | null => vaults?.get(assetMint(asset)) ?? (vaults ? 0n : null),
    [vaults],
  )

  return {
    client,
    ready: connected && !!client && !busy,
    busy,
    error,
    vaultSolRaw: vaults?.get(WRAPPED_SOL_MINT) ?? null,
    vaultOf,
    tokens,
    bps,
    minTransferFee,
    connect,
    refreshVault,
    unlocked,
    unlockBusy,
    unlockNow,
  }
}
