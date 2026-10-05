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

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function signUiMessage(
  prefix: string,
  wallet: string,
  key: string,
  ts: number,
  signMessage: (m: Uint8Array) => Promise<Uint8Array>,
  docSha256Hex?: string,
): Promise<string> {
  const lines = [prefix, wallet, key, String(ts), ...(docSha256Hex ? [docSha256Hex] : [])]
  const message = new TextEncoder().encode(lines.join("\n"))
  return toB64(await signMessage(message))
}

async function pullUiDoc(
  key: string,
  wallet: string,
  signMessage: (m: Uint8Array) => Promise<Uint8Array>,
): Promise<unknown | null> {
  const ts = Date.now()
  const signature = await signUiMessage("charon-ui-read-v1", wallet, key, ts, signMessage)
  const res = await fetch(`${config.get().backendUrl}/api/ui/${key}/${wallet}?ts=${ts}&signature=${encodeURIComponent(signature)}`)
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
  const docJson = JSON.stringify(doc)
  // the signature binds the doc's sha256 — the backend rejects substitutions
  const docHash = await sha256Hex(new TextEncoder().encode(docJson))
  const signature = await signUiMessage("charon-ui-v1", wallet, key, ts, signMessage, docHash)
  const res = await fetch(`${config.get().backendUrl}/api/ui/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, ts, doc: docJson, signature }),
  })
  return res.ok
}

/**
 * Two-way sync of the employer docs for the connected wallet. Pulls at most
 * once per browser session (sessionStorage flag) so a plain refresh never
 * fires a wallet signature prompt — localStorage is the read path meanwhile.
 * Pushes (debounced, one merged doc = one signature) on local changes only;
 * data just adopted from the remote is already remote, so it never pushes.
 * Failures degrade silently to the local-only app; the badge reflects it.
 */
export function useUiSync(): void {
  const { publicKey, signMessage } = useWallet()
  const wallet = publicKey?.toBase58() ?? null

  const pushBoth = useCallback(
    async (sign: (m: Uint8Array) => Promise<Uint8Array>, w: string) => {
      setSyncState("syncing")
      try {
        const ok = await pushUiDoc(
          "ui",
          w,
          { history: exportRunsDoc(), team: exportTeamDoc() },
          sign,
        )
        setSyncState(ok ? "synced" : "offline")
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
      const flag = `payroll:ui-sync-pulled:${wallet}`
      let pulled = false
      try {
        pulled = sessionStorage.getItem(flag) === "1"
      } catch {
        /* private mode — just pull every time */
      }
      if (pulled) {
        setSyncState("synced")
      } else {
        setSyncState("syncing")
        try {
          const remote = (await pullUiDoc("ui", wallet, sign)) as
            | { history?: unknown; team?: unknown }
            | null
          if (cancelled) return
          if (remote && typeof remote === "object") {
            adoptRuns(remote.history ?? null)
            adoptTeam(remote.team ?? null)
          }
          try {
            sessionStorage.setItem(flag, "1")
          } catch {
            /* ignore */
          }
          setSyncState("synced")
        } catch {
          if (!cancelled) setSyncState("offline")
        }
      }
      // Attached after the pull so adoption writes don't schedule a push —
      // that data came from the remote; pushing it back is a wasted signature.
      if (!cancelled) {
        window.addEventListener(HISTORY_EVENT, onHistory)
        window.addEventListener(TEAM_EVENT, onTeam)
      }
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener(HISTORY_EVENT, onHistory)
      window.removeEventListener(TEAM_EVENT, onTeam)
    }
  }, [wallet, signMessage, pushBoth])
}
