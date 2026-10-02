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
  /** Epoch ms: first attempt began, relay accepted the payout, chain confirmed. */
  startedAt?: number
  relayedAt?: number
  confirmedAt?: number
}

export interface RunSnapshot {
  phase: "funding" | "paying" | "settled" | "aborted"
  rows: RowState[]
  depositSig?: string
  /** Epoch ms the run began; fundedAt lands once the deposit confirms. */
  startedAt: number
  fundedAt?: number
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
  /** Parallel proving lanes (1-8); defaults to 8. */
  lanes?: number
}

export interface EngineClient {
  init(): Promise<void>
  unlock(): Promise<void>
  refreshNotes(opts?: { fromScratch?: boolean }): Promise<unknown>
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
const RESERVE_POLL_MS = 350
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

  /**
   * Pin the two largest free notes for a merge self-transfer. Unlike
   * tryReserve (largest covering gross), a merge always consumes the two
   * biggest fragments, so it must claim them explicitly or a racing payout
   * lane could reserve the same notes mid-merge.
   */
  reserveTopPair(): { pins: PinnedNotes; amounts: [bigint, bigint] } | null {
    const free = [...this.free.values()].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
    )
    const a = free[0]
    const b = free[1]
    if (!a || !b) return null
    this.free.delete(a.id)
    this.free.delete(b.id)
    this.reserved.add(a.id)
    this.reserved.add(b.id)
    this.busy++
    return {
      pins: { ids: [a.id, b.id], blindings: [a.blinding, b.blinding] },
      amounts: [a.amount, b.amount],
    }
  }

  freeNotes(): Array<{ amount: bigint; blinding: string }> {
    return [...this.free.values()].map((n) => ({ amount: n.amount, blinding: n.blinding }))
  }

  totalFree(): bigint {
    let sum = 0n
    for (const n of this.free.values()) sum += n.amount
    return sum
  }
}

export class PayrollEngine {
  private cancelled = false
  private emit: (phase: RunSnapshot["phase"], depositSig?: string) => void = () => {}
  private startedAt = 0
  private fundedAt?: number
  private merges = 0

  constructor(private deps: EngineDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  async run(req: RunRequest, onUpdate?: (s: RunSnapshot) => void): Promise<RunReceipt> {
    this.cancelled = false
    this.startedAt = this.deps.now()
    this.fundedAt = undefined
    this.merges = 0
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
      onUpdate?.({
        phase,
        rows: rows.map((r) => ({ ...r })),
        depositSig,
        startedAt: this.startedAt,
        fundedAt: this.fundedAt,
      })

    await this.deps.client.init()
    await this.deps.client.unlock()

    let funding: RunReceipt["funding"] = null
    if (plan.shortfall > 0n) {
      this.emit("funding")
      try {
        // One lumpsum deposit: a single signature funds the whole run. The
        // note is >= every row's gross, so rows pay through its change chain
        // while the vault's older fragments cover rows via the pair logic.
        // (Per-row funding costs one popup per row; the step ladder it
        // replaced stranded rows when fragments couldn't fit a payout.)
        let firstSig: string | undefined
        let lastLeaf = -1
        const amount = Number(plan.shortfall)
        if (amount <= 0 || !Number.isSafeInteger(amount)) throw new Error("bad deposit size")
        const dep =
          req.asset.kind === "sol"
            ? await this.deps.client.depositSOL(amount)
            : await this.deps.client.depositSPL(req.asset.mint, amount)
        firstSig = dep.signature
        lastLeaf = dep.leafIndex
        await this.deps.waitUntilIndexed(treeKeyOf(req.asset), lastLeaf)
        await this.deps.client.refreshNotes()
        this.fundedAt = this.deps.now()
        funding = { depositedRaw: plan.shortfall, txSignature: firstSig ?? "", depositedAt: this.fundedAt }
        this.emit("funding", firstSig)
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

    const selfAddress = this.deps.client.publicKey?.toBase58()
    const feeFloorBig = BigInt(req.asset.kind === "sol" ? (req.minTransferFee ?? 0) : 0)
    const bpsBig = BigInt(req.bps)
    const feeOf = (net: bigint): bigint => {
      const f = (net * bpsBig + 9_999n) / 10_000n
      return f < feeFloorBig ? feeFloorBig : f
    }

    let lastRefreshAt = 0
    let lastFromScratchAt = 0
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
     * The circuit accepts at most 2 input notes per proof, so when the vault's
     * total balance covers a row but no note or pair does, merge the two
     * largest fragments into one fresh note (a self transfer, still relayer
     * signed — no wallet popup) until something fits. Single-flight: waiting
     * lanes share one merge chain and re-poll after it lands — a chain sized
     * for a smaller row may not cover a bigger one, so the caller re-checks
     * and starts another chain if needed.
     */
    let consolidating: Promise<void> | null = null
    const consolidateFor = (gross: bigint): Promise<void> => {
      if (consolidating) return consolidating
      consolidating = (async () => {
        if (!ledger || !selfAddress) return
        for (let merges = 0; merges < 8; merges++) {
          const free = ledger.freeNotes().sort((a, b) =>
            a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
          )
          const top = free[0]
          if (top && top.amount >= gross) return
          if (top && free[1] && top.amount + free[1].amount >= gross) return
          if (free.length < 2) return
          const pair = ledger.reserveTopPair()
          if (!pair) return
          const merged = pair.amounts[0] + pair.amounts[1]
          // solve net + fee(net) == merged so the merge leaves no dust change
          let net = merged
          for (let i = 0; i < 4; i++) net = merged - feeOf(net)
          if (net + feeOf(net) > merged) net = merged - feeOf(net)
          if (net <= 0n) {
            ledger.release(pair.pins)
            ledger.busy--
            return
          }
          this.merges++
          try {
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.transferNoteSOL(selfAddress, Number(net), {
                    relay: true as const,
                    inputNotes: pair.pins.blindings.map((blinding) => ({ blinding })),
                  })
                : await this.deps.client.transferNoteSPL(req.asset.mint, selfAddress, Number(net), {
                    relay: true as const,
                    inputNotes: pair.pins.blindings.map((blinding) => ({ blinding })),
                  })
            await this.deps.waitUntilIndexed(treeKeyOf(req.asset), res.leafIndex)
            ledger.commitSpent(pair.pins)
          } catch (e) {
            // notes went nowhere conclusive — give them back and let the
            // caller's reserve loop decide (it rescans before retrying)
            ledger.release(pair.pins)
            throw e
          } finally {
            ledger.busy--
          }
          await this.deps.client.refreshNotes().catch(() => {})
          reloadLedger()
        }
      })().finally(() => {
        consolidating = null
      })
      return consolidating
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
      let mergeRounds = 0
      for (;;) {
        const pinned = ledger.tryReserve(gross)
        if (pinned) {
          ledger.busy++
          return pinned
        }
        if (this.cancelled) return null
        if (ledger.busy === 0) {
          // nothing is in flight, so the view is authoritative
          if (!scannedFinal) {
            scannedFinal = true
            await refreshNow()
            continue
          }
          // a cursor-based scan can hide landed change notes (fixed at the
          // source in the SDK's cursor, but keep this heal as a safety net):
          // one full rescan from index 0 per minute, then concede the pool
          // is truly spent
          if (this.deps.now() - lastFromScratchAt > 60_000) {
            lastFromScratchAt = this.deps.now()
            await this.deps.client.refreshNotes({ fromScratch: true }).catch(() => {})
            reloadLedger()
            continue
          }
          // the balance is there but fragmented past the 2-input circuit
          // limit — merge fragments into fresh notes and try again. A shared
          // chain may have been sized for a smaller row, so keep starting new
          // chains (bounded) while the vault total could still cover gross.
          if (mergeRounds < 8 && ledger.totalFree() >= gross) {
            mergeRounds++
            await consolidateFor(gross)
            continue
          }
          return null
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
        if (!row.startedAt) row.startedAt = this.deps.now()
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
            const total = ledger.totalFree()
            row.status = "failed"
            row.error =
              `insufficient private balance: no free note covers ${gross.toString()} ` +
              `(vault has ${total.toString()} across ${ledger.freeNotes().length} notes)`
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
          row.relayedAt = this.deps.now()
          row.status = "relayed"
          this.emit("paying", funding?.txSignature)
          row.status = (await this.deps.confirmSignature(sig)) ? "confirmed" : "confirming"
          row.confirmedAt = this.deps.now()
          this.emit("paying", funding?.txSignature)
          if (pinned && ledger) {
            ledger.commitSpent(pinned)
            ledger.busy--
            pinned = null
          }
          void scheduleRefresh()
          return
        } catch (e) {
          // A throw after broadcast must never free the pinned notes for a
          // retry: they may already be spent on-chain, and re-reserving
          // would pay this row twice. If the pinned notes vanished from the
          // spendable view, the payout landed — commit them as spent and
          // stop retrying.
          let landed = false
          if (pinned) {
            await this.deps.client.refreshNotes().catch(() => {})
            reloadLedger()
            const spendable = new Set(
              (this.deps.listNotes?.(req.asset) ?? []).map((n) => n.blinding),
            )
            landed = pinned.blindings.every((b) => !spendable.has(b))
          }
          if (pinned && ledger) {
            if (landed) ledger.commitSpent(pinned)
            else ledger.release(pinned)
            ledger.busy--
            pinned = null
          }
          if (landed) {
            row.error = `unconfirmed after broadcast: ${(e as Error).message}`
            row.status = "confirming"
            return
          }
          row.error = (e as Error).message
          if (attempt === ATTEMPTS) row.status = "failed"
          else await this.deps.sleep(500 * 2 ** (attempt - 1))
        }
      }
    }

    this.emit("paying", funding?.txSignature)
    let next = 0
    // Widest rows first: greedy consumption fragments the change pool and the
    // circuit caps a proof at 2 inputs, so paying the largest rows while big
    // notes still exist keeps the tail rows payable without merge round-trips.
    const order = plan.rows
      .map((r, i) => ({ gross: r.gross, i }))
      .sort((a, b) => (a.gross > b.gross ? -1 : a.gross < b.gross ? 1 : 0))
      .map((o) => o.i)
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelled) return
        const k = next++
        if (k >= order.length) return
        const i = order[k]
        await payOne(rows[i], plan.rows[i])
      }
    }
    const laneCount = ledger ? Math.min(Math.max(1, req.lanes ?? LANES), LANES, rows.length) : 1
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
      startedAt: r.startedAt,
      relayedAt: r.relayedAt,
      confirmedAt: r.confirmedAt,
    }))
    const finishedAt = this.deps.now()
    const receipt: RunReceipt = {
      id: this.deps.newId(),
      createdAt: this.deps.now(),
      fileHash: req.fileHash,
      asset: req.asset,
      mode: req.mode ?? "public",
      totalPlanned,
      entries,
      funding,
      startedAt: this.startedAt,
      fundedAt: this.fundedAt,
      finishedAt,
      merges: this.merges,
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
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`merkle tree did not index leaf ${minLeafIndex} within ${timeoutMs}ms`)
}

async function defaultConfirm(sig: string): Promise<boolean> {
  const conn = new Connection(config.get().rpcUrl, "confirmed")
  // The relay may broadcast faster than we subscribe; catch already-landed
  // signatures before waiting on the websocket.
  try {
    const { value } = await conn.getSignatureStatuses([sig])
    const st = value?.[0]
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return !st.err
    if (st?.err) return false
  } catch {
    /* fall through to the websocket */
  }
  // Push, not poll: Alpenglow finality is sub-second on devnet, so a polling
  // interval added more latency than the chain itself.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.removeSignatureListener(subId)
      resolve(false)
    }, 45_000)
    const subId = conn.onSignature(
      sig,
      (result) => {
        clearTimeout(timer)
        resolve(!result.err)
      },
      "confirmed",
    )
  })
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
