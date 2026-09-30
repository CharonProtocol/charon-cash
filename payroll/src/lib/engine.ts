import { Connection, type PublicKey } from "@solana/web3.js"
import { fetchTreeState, solTreeKey, splTreeKey, unspentNotes, WRAPPED_SOL_MINT } from "privacy-cash-sdk"

import { config } from "./config"
import { planRun } from "./fees"
import { saveRun } from "./store"
import type { Asset, EntryStatus, PayrollEntry, RunMode, RunReceipt } from "./types"

export interface RowState {
  address: string
  amountHuman: string
  memo?: string
  status: EntryStatus
  txSignature?: string
  error?: string
  attempts: number
  noteLeafIndex?: number
  noteCommitment?: string
}

export interface RunSnapshot {
  phase: "funding" | "paying" | "settled" | "aborted"
  rows: RowState[]
  depositSig?: string
}

export interface RunRequest {
  fileHash: string
  asset: Asset
  entries: PayrollEntry[]
  bps: number
  vaultRaw: bigint
  /** Defaults to "public" when omitted. */
  mode?: RunMode
  /** Relayer minimum ext=0 SOL fee (lamports); sizes shielded SOL funding. */
  minTransferFee?: number
}

export interface EngineClient {
  init(): Promise<void>
  unlock(): Promise<void>
  refreshNotes(): Promise<unknown>
  depositSOL(lamports: number): Promise<{ signature: string; leafIndex: number }>
  depositSPL(mint: string, raw: number | string): Promise<{ signature: string; leafIndex: number }>
  withdrawSOL(
    lamports: number,
    recipient: string,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string }>
  withdrawSPL(
    mint: string,
    raw: number | string,
    recipient: string,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string }>
  transferNoteSOL(
    recipient: string,
    netLamports: number,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string; leafIndex: number; commitment: string }>
  transferNoteSPL(
    mint: string,
    recipient: string,
    netRaw: number,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string; leafIndex: number; commitment: string }>
  /** Exposed by the SDK client; lets the engine reserve/pin inputs for parallel lanes. */
  readonly publicKey?: PublicKey
}

export interface NoteRef {
  id: string
  amount: string
  blinding: string
}

export interface EngineDeps {
  client: EngineClient
  waitUntilIndexed(treeKey: string, minLeafIndex: number): Promise<void>
  confirmSignature(sig: string): Promise<boolean>
  now(): number
  newId(): string
  sleep(ms: number): Promise<void>
  /**
   * Enables parallel lanes: reads the wallet's spendable notes so rows can
   * reserve distinct inputs and pin them through the SDK. When omitted the
   * run stays sequential (no reservation).
   */
  listNotes?(asset: Asset): NoteRef[]
}

const ATTEMPTS = 3
const LANES = 8
const RESERVE_POLL_MS = 800
const RESERVE_WAIT_CAP_MS = 120_000
const REFRESH_MIN_GAP_MS = 1_500

/** Notes pinned for an in-flight payout; released on failure, dropped on success. */
interface PinnedNotes {
  ids: string[]
  blindings: string[]
}

/**
 * Tracks which notes are free vs pinned by a lane. Reloaded from the wallet's
 * note set after every refresh; pins survive reloads so a lane never loses its
 * reservation mid-payout. Mirrors the SDK's largest-first selection so pinned
 * calls behave exactly like auto-selected ones.
 */
class NoteLedger {
  private free = new Map<string, { id: string; amount: bigint; blinding: string }>()
  private reserved = new Set<string>()
  /** Lanes holding a reservation or mid-transfer; waiters poll while this is > 0. */
  busy = 0

  reload(notes: NoteRef[]): void {
    const seen = new Set<string>()
    for (const n of notes) {
      seen.add(n.id)
      if (!this.reserved.has(n.id)) {
        this.free.set(n.id, { id: n.id, amount: BigInt(n.amount), blinding: n.blinding })
      }
    }
    for (const id of [...this.free.keys()]) {
      if (!seen.has(id)) this.free.delete(id)
    }
    for (const id of [...this.reserved]) {
      if (!seen.has(id)) this.reserved.delete(id)
    }
  }

  /** Largest note covering gross, else the greedy largest + complement pair. */
  tryReserve(gross: bigint): PinnedNotes | null {
    const free = [...this.free.values()].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
    )
    const take = (n: { id: string; blinding: string }) => {
      this.free.delete(n.id)
      this.reserved.add(n.id)
    }
    const single = free.find((n) => n.amount >= gross)
    if (single) {
      take(single)
      return { ids: [single.id], blindings: [single.blinding] }
    }
    const a = free[0]
    if (a) {
      const need = gross - a.amount
      const b = free.slice(1).find((n) => n.amount >= need)
      if (b) {
        take(a)
        take(b)
        return { ids: [a.id, b.id], blindings: [a.blinding, b.blinding] }
      }
    }
    return null
  }

  release(p: PinnedNotes): void {
    for (const id of p.ids) this.reserved.delete(id)
  }

  commitSpent(p: PinnedNotes): void {
    for (const id of p.ids) {
      this.reserved.delete(id)
      this.free.delete(id)
    }
  }
}

export class PayrollEngine {
  private cancelled = false
  private emit: (phase: RunSnapshot["phase"], depositSig?: string) => void = () => {}

  constructor(private deps: EngineDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  async run(req: RunRequest, onUpdate?: (s: RunSnapshot) => void): Promise<RunReceipt> {
    this.cancelled = false
    const decimals = req.asset.kind === "sol" ? 9 : req.asset.decimals
    const plan = planRun(req.entries, decimals, req.bps, req.vaultRaw, {
      mode: req.mode,
      // the floor is SOL-denominated; token raw units never pay it
      minTransferFee: req.asset.kind === "sol" ? req.minTransferFee : 0,
    })
    const rows: RowState[] = req.entries.map((e) => ({
      address: e.address,
      amountHuman: e.amountHuman,
      memo: e.memo,
      status: "queued" as EntryStatus,
      attempts: 0,
    }))
    this.emit = (phase, depositSig) =>
      onUpdate?.({ phase, rows: rows.map((r) => ({ ...r })), depositSig })

    await this.deps.client.init()
    await this.deps.client.unlock()

    let funding: RunReceipt["funding"] = null
    if (plan.shortfall > 0n) {
      this.emit("funding")
      try {
        const lamports = Number(plan.shortfall)
        if (!Number.isSafeInteger(lamports)) throw new Error("shortfall too large")
        const dep =
          req.asset.kind === "sol"
            ? await this.deps.client.depositSOL(lamports)
            : await this.deps.client.depositSPL(req.asset.mint, lamports)
        await this.deps.waitUntilIndexed(treeKeyOf(req.asset), dep.leafIndex)
        await this.deps.client.refreshNotes()
        funding = { depositedRaw: plan.shortfall, txSignature: dep.signature }
        this.emit("funding", dep.signature)
      } catch (e) {
        for (const r of rows) {
          r.status = "failed"
          r.error = `aborted: funding failed — ${(e as Error).message}`
        }
        return this.settle(req, plan.totalNet, rows, funding, "aborted")
      }
    }

    const ledger = this.deps.listNotes ? new NoteLedger() : null
    if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset))

    let lastRefreshAt = 0
    let refreshInFlight: Promise<void> | null = null
    const reloadLedger = (): void => {
      if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset))
    }
    // bring fresh notes (change notes land after each relay) into the ledger,
    // at most one scan in flight and never more often than the gap
    const scheduleRefresh = (): Promise<void> => {
      if (refreshInFlight) return refreshInFlight
      if (this.deps.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) return Promise.resolve()
      lastRefreshAt = this.deps.now()
      refreshInFlight = (async () => {
        try {
          await this.deps.client.refreshNotes()
        } catch {
          /* transient indexer hiccup — the next poll retries */
        }
        reloadLedger()
      })().finally(() => {
        refreshInFlight = null
      })
      return refreshInFlight
    }
    // unthrottled scan for the give-up path below (bounded: at most once per row)
    const refreshNow = async (): Promise<void> => {
      try {
        await this.deps.client.refreshNotes()
      } catch {
        /* keep the stale view; the retry path handles it */
      }
      reloadLedger()
    }

    /**
     * Pin enough free notes for one payout. Waits while other lanes hold the
     * only fitting notes (change notes flow back constantly); when nothing
     * fits and no lane is busy, one forced scan runs before conceding the
     * balance is truly spent.
     */
    const reserveFor = async (gross: bigint): Promise<PinnedNotes | null> => {
      if (!ledger) return null
      const deadline = this.deps.now() + RESERVE_WAIT_CAP_MS
      let scannedFinal = false
      for (;;) {
        const pinned = ledger.tryReserve(gross)
        if (pinned) {
          ledger.busy++
          return pinned
        }
        if (this.cancelled) return null
        if (ledger.busy === 0) {
          // nothing is in flight, so the view is authoritative — scan once
          // unthrottled, then concede
          if (scannedFinal) return null
          scannedFinal = true
          await refreshNow()
          continue
        }
        // other lanes are mid-payout and their change notes are coming; wait
        scannedFinal = false
        if (this.deps.now() > deadline) return null
        void scheduleRefresh()
        await this.deps.sleep(RESERVE_POLL_MS)
      }
    }

    const payOne = async (row: RowState, planRow: (typeof plan.rows)[number]): Promise<void> => {
      const gross = planRow.gross
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (this.cancelled) {
          row.status = "failed"
          row.error = "cancelled"
          return
        }
        row.attempts = attempt
        row.status = "proving"
        this.emit("paying", funding?.txSignature)
        let pinned: PinnedNotes | null = null
        try {
          pinned = await reserveFor(gross)
          if (this.cancelled) {
            if (pinned) {
              ledger?.release(pinned)
              if (ledger) ledger.busy--
            }
            row.status = "failed"
            row.error = "cancelled"
            return
          }
          if (!pinned && ledger) {
            row.status = "failed"
            row.error = `insufficient private balance: no free note covers ${gross.toString()}`
            return
          }
          const pinOpts = pinned
            ? { relay: true as const, inputNotes: pinned.blindings.map((blinding) => ({ blinding })) }
            : { relay: true as const }
          let sig: string
          if (req.mode === "shielded") {
            // Exact net in the note; the SDK takes its fee from the sender's
            // remaining notes, so no gross solve is needed here.
            const net = Number(planRow.net)
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.transferNoteSOL(row.address, net, pinOpts)
                : await this.deps.client.transferNoteSPL(req.asset.mint, row.address, net, pinOpts)
            sig = res.signature
            row.txSignature = res.signature
            row.noteLeafIndex = res.leafIndex
            row.noteCommitment = res.commitment
          } else {
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.withdrawSOL(Number(gross), row.address, pinOpts)
                : await this.deps.client.withdrawSPL(req.asset.mint, Number(gross), row.address, pinOpts)
            sig = res.signature
            row.txSignature = res.signature
          }
          row.error = undefined
          row.status = "relayed"
          this.emit("paying", funding?.txSignature)
          row.status = (await this.deps.confirmSignature(sig)) ? "confirmed" : "confirming"
          this.emit("paying", funding?.txSignature)
          if (pinned && ledger) {
            ledger.commitSpent(pinned)
            ledger.busy--
            pinned = null
          }
          void scheduleRefresh()
          return
        } catch (e) {
          if (pinned && ledger) {
            ledger.release(pinned)
            ledger.busy--
            pinned = null
          }
          row.error = (e as Error).message
          if (attempt === ATTEMPTS) row.status = "failed"
          else await this.deps.sleep(500 * 2 ** (attempt - 1))
        }
      }
    }

    this.emit("paying", funding?.txSignature)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelled) return
        const i = next++
        if (i >= rows.length) return
        await payOne(rows[i], plan.rows[i])
      }
    }
    const laneCount = ledger ? Math.min(LANES, rows.length) : 1
    await Promise.all(Array.from({ length: laneCount }, () => worker()))

    if (this.cancelled) {
      for (const r of rows) {
        if (r.status === "queued") {
          r.status = "failed"
          r.error = "cancelled"
        }
      }
    }
    try {
      await this.deps.client.refreshNotes()
    } catch {
      /* final sync is best-effort; statuses are already recorded */
    }

    return this.settle(req, plan.totalNet, rows, funding, "settled")
  }

  private settle(
    req: RunRequest,
    totalPlanned: bigint,
    rows: RowState[],
    funding: RunReceipt["funding"],
    phase: RunSnapshot["phase"],
  ): RunReceipt {
    const entries = rows.map((r) => ({
      address: r.address,
      amountHuman: r.amountHuman,
      memo: r.memo,
      status: (r.status === "confirmed" ? "sent" : r.status === "confirming" ? "confirming" : "failed") as "sent" | "confirming" | "failed",
      txSignature: r.txSignature,
      error: r.error,
      attempts: r.attempts,
      noteLeafIndex: r.noteLeafIndex,
      noteCommitment: r.noteCommitment,
    }))
    const receipt: RunReceipt = {
      id: this.deps.newId(),
      createdAt: this.deps.now(),
      fileHash: req.fileHash,
      asset: req.asset,
      mode: req.mode ?? "public",
      totalPlanned,
      entries,
      funding,
      summary: {
        sent: entries.filter((e) => e.status === "sent").length,
        failed: entries.filter((e) => e.status === "failed").length,
        total: entries.length,
      },
    }
    saveRun(receipt)
    this.emit(phase, funding?.txSignature)
    return receipt
  }
}

export function treeKeyOf(asset: Asset): string {
  return asset.kind === "sol" ? solTreeKey() : splTreeKey(asset.mint)
}

async function defaultWaitUntilIndexed(treeKey: string, minLeafIndex: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const st = await fetchTreeState(treeKey)
      if (st.nextLeafIndex > minLeafIndex) return
    } catch {
      /* transient indexer hiccup — retry */
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`merkle tree did not index leaf ${minLeafIndex} within ${timeoutMs}ms`)
}

async function defaultConfirm(sig: string): Promise<boolean> {
  const conn = new Connection(config.get().rpcUrl, "confirmed")
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
      const st = value?.[0]
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true
      if (st?.err) return false
    } catch {
      /* rate limit — retry */
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return false
}

export function createEngine(client: EngineClient): PayrollEngine {
  return new PayrollEngine({
    client,
    listNotes: client.publicKey
      ? (asset) =>
        unspentNotes(client.publicKey!)
          .filter((n) => n.mintAddress === (asset.kind === "sol" ? WRAPPED_SOL_MINT : asset.mint))
          .map((n) => ({ id: n.id, amount: n.amount, blinding: n.blinding }))
      : undefined,
    waitUntilIndexed: defaultWaitUntilIndexed,
    confirmSignature: defaultConfirm,
    now: () => Date.now(),
    newId: () =>
      Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
}
