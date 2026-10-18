import { useCallback, useEffect, useRef, useState } from "react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey } from "@solana/web3.js"
import {
  PrivacyCashClient,
  fetchRecipientKeys,
  fetchRelayerInfo,
  publishRecipientKeys,
  rememberUnlockSigner,
  totalBalance,
  unspentNotes,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

import { assetMint, tokenAssets } from "@/lib/assets"
import { cacheClient, getCachedClient } from "@/lib/clientCache"
import type { Asset } from "@/lib/types"

export function useEmployeeClient() {
  const { publicKey, signMessage, signTransaction } = useWallet()
  const { connection } = useConnection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)
  const [registered, setRegistered] = useState<boolean | null>(null)
  /** per mint (SOL under WRAPPED_SOL_MINT): private notes and public wallet */
  const [noteRaw, setNoteRaw] = useState<Map<string, bigint> | null>(null)
  const [walletRaw, setWalletRaw] = useState<Map<string, bigint> | null>(null)
  /** token pools the relayer runs (USDC, ...), beside SOL */
  const [tokens, setTokens] = useState<Asset[]>([])
  const tokensRef = useRef<Asset[]>([])
  const [bps, setBps] = useState<number | null>(null)
  const [minFee, setMinFee] = useState(0)
  const clientRef = useRef<PrivacyCashClient | null>(null)
  const signerRef = useRef<ReturnType<typeof rememberUnlockSigner> | null>(null)
  // The note list below memoizes on `notes` identity, so every store fill
  // must bump this counter — otherwise the claimable stat updates while the
  // ledger keeps showing "No private notes yet" (they read the same store).
  const [notesVersion, setNotesVersion] = useState(0)

  const connected = !!(publicKey && signMessage && signTransaction)

  const rescan = useCallback(
    async (c?: PrivacyCashClient) => {
      const cl = c ?? clientRef.current
      if (!cl || !publicKey) return
      await cl.refreshNotes()
      const mints = [WRAPPED_SOL_MINT, ...tokensRef.current.map(assetMint)]
      setNoteRaw(new Map(mints.map((m) => [m, totalBalance(publicKey, m)])))
      setNotesVersion((v) => v + 1)
      const wallet = new Map<string, bigint>()
      try {
        wallet.set(WRAPPED_SOL_MINT, BigInt(await connection.getBalance(publicKey)))
      } catch {
        /* RPC hiccup: the SOL stat shows "-" until the next scan */
      }
      for (const t of tokensRef.current) {
        const ata = getAssociatedTokenAddressSync(new PublicKey(assetMint(t)), publicKey)
        // no token account yet = nothing claimed to this wallet yet
        wallet.set(assetMint(t), await connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n))
      }
      setWalletRaw(wallet)
    },
    [publicKey, connection],
  )

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return
    let cancelled = false
    // unlock signatures kept for this tab: a reload doesn't prompt again
    const signer = rememberUnlockSigner({ publicKey, signMessage, signTransaction })
    signerRef.current = signer
    const c = new PrivacyCashClient(signer)
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
        tokensRef.current = tokenAssets(info)
        setTokens(tokensRef.current)
        if (keys) {
          const cached = getCachedClient(publicKey.toBase58())
          if (cached) {
            // Unlocked earlier this session (route switch): reuse, no popup.
            clientRef.current = cached
            setClient(cached)
            await rescan(cached)
          } else {
            await c.init()
            await c.unlock()
            cacheClient(publicKey.toBase58(), c)
            await rescan(c)
          }
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

  /**
   * One-time enrollment: unlock (the two key signatures, also used to claim),
   * then publish the keys it derived (one registry signature). No reload.
   */
  const enable = useCallback(async () => {
    const c = clientRef.current
    if (!c || !publicKey || !signerRef.current) return
    await c.init()
    await c.unlock()
    await publishRecipientKeys(signerRef.current, c.receiveKeys(), c.backupKey())
    cacheClient(publicKey.toBase58(), c)
    setRegistered(true)
    await rescan(c)
  }, [publicKey, rescan])

  const notes = useCallback((asset: Asset) => {
    if (!publicKey) return []
    return unspentNotes(publicKey).filter((n) => n.mintAddress === assetMint(asset))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, notesVersion])

  return {
    connected,
    client,
    busy,
    error,
    registered,
    enable,
    noteRawOf: (asset: Asset) => noteRaw?.get(assetMint(asset)) ?? null,
    walletRawOf: (asset: Asset) => walletRaw?.get(assetMint(asset)) ?? null,
    tokens,
    bps,
    minFee,
    rescan: () => rescan(),
    notes,
  }
}
