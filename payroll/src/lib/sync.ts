import { useCallback, useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"

import { config } from "./config"
import {
  adoptRuns,
  adoptTeam,
  exportRunsDoc,
  exportTeamDoc,
  HISTORY_EVENT,
  TEAM_EVENT,
} from "./store"

// Employer UI-state sync against the relayer DB: one signed JSON doc per
// (wallet, key). "history" is the run ledger, "team" the manually added
// roster. localStorage stays the read path and offline cache — this layer
// pulls on connect, merges the union into it, and pushes changes back so a
// second browser (or a reload after a wipe) lands on the same data.

export type SyncState = "idle" | "syncing" | "synced" | "offline"

let syncState: SyncState = "idle"
const syncListeners = new Set<() => void>()

function setSyncState(next: SyncState): void {
  if (syncState === next) return
  syncState = next
  for (const fn of syncListeners) fn()
}

/** Subscribe to the app-wide sync badge state. */
export function useSyncState(): SyncState {
  const [state, setState] = useState(syncState)
  useEffect(() => {
    const fn = () => setState(syncState)
    syncListeners.add(fn)
    return () => {
      syncListeners.delete(fn)
    }
  }, [])
  return state
}

function toB64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

async function pullUiDoc(key: string, wallet: string): Promise<unknown | null> {
  const res = await fetch(`${config.get().backendUrl}/api/ui/${key}/${wallet}`)
  if (!res.ok) return null
  const j = (await res.json()) as { doc?: string }
  if (!j.doc) return null
  try {
    return JSON.parse(j.doc)
  } catch {
    return null
  }
}

async function pushUiDoc(
  key: string,
  wallet: string,
  doc: unknown,
  signMessage: (m: Uint8Array) => Promise<Uint8Array>,
): Promise<boolean> {
  const ts = Date.now()
  const message = new TextEncoder().encode(`charon-ui-v1\n${wallet}\n${key}\n${ts}`)
  const signature = await signMessage(message)
  const res = await fetch(`${config.get().backendUrl}/api/ui/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, ts, doc: JSON.stringify(doc), signature: toB64(signature) }),
  })
  return res.ok
}

/**
 * Two-way sync of the employer docs for the connected wallet. Pulls once per
 * connection, then pushes (debounced) whenever either doc changes locally.
 * Failures degrade silently to the local-only app; the badge reflects it.
 */
export function useUiSync(): void {
  const { publicKey, signMessage } = useWallet()
  const wallet = publicKey?.toBase58() ?? null

  const pushBoth = useCallback(
    async (sign: (m: Uint8Array) => Promise<Uint8Array>, w: string) => {
      setSyncState("syncing")
      try {
        const results = await Promise.all([
          pushUiDoc("history", w, exportRunsDoc(), sign),
          pushUiDoc("team", w, exportTeamDoc(), sign),
        ])
        setSyncState(results.every(Boolean) ? "synced" : "offline")
      } catch {
        setSyncState("offline")
      }
    },
    [],
  )

  useEffect(() => {
    if (!wallet || !signMessage) {
      setSyncState("idle")
      return
    }
    const sign = signMessage
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!cancelled) void pushBoth(sign, wallet)
      }, 1500)
    }
    const onHistory = () => schedule()
    const onTeam = () => schedule()

    void (async () => {
      setSyncState("syncing")
      try {
        const [remoteRuns, remoteTeam] = await Promise.all([
          pullUiDoc("history", wallet),
          pullUiDoc("team", wallet),
        ])
        if (cancelled) return
        const changedRuns = adoptRuns(remoteRuns)
        const changedTeam = adoptTeam(remoteTeam)
        if (changedRuns || changedTeam) schedule()
        else setSyncState("synced")
      } catch {
        if (!cancelled) setSyncState("offline")
      }
    })()

    window.addEventListener(HISTORY_EVENT, onHistory)
    window.addEventListener(TEAM_EVENT, onTeam)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener(HISTORY_EVENT, onHistory)
      window.removeEventListener(TEAM_EVENT, onTeam)
    }
  }, [wallet, signMessage, pushBoth])
}
