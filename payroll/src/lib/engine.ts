import { Connection, type PublicKey } from "@solana/web3.js"
import {
  fetchTreeState,
  getBackendUrl,
  solTreeKey,
  splTreeKey,
  unspentNotes,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

import { config } from "./config"
import { planRun } from "./fees"
import { saveRun } from "./store"
import type { Asset, EntryStatus, PayrollEntry, RunMode, RunReceipt } from "./types"

export interface RowTiming {
  /** Waiting for a spendable note reservation (pool contention). */
  reserveMs?: number
  /** Recipient keys + merkle proof fetch before proving starts. */
  prepMs?: number
  /** Prove + relay POST round-trip (the SDK resolves after both). */
  proveRelayMs?: number
  /** Chain confirmation wait. */
  confirmMs?: number
}

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
  /** Stage durations for the final run's timing table. */
  timing?: RowTiming
}

export interface RunSnapshot {
  phase: "funding" | "paying" | "settled" | "aborted"
  rows: RowState[]
  depositSig?: string
  /** Epoch ms the run began; fundedAt lands once the deposit confirms. */
  startedAt: number
  fundedAt?: number
  /** Funding-note splits run so lanes prove in parallel. */
  splits?: number
  /** Effective parallel payout chains for this run (min(requested, 8, rows)). */
  lanes?: number
  /**
   * One human sentence about the slowest current activity (lane fan-out,
   * indexer catch-up, post-error adjudication). The UI surfaces it as a
   * toast so a quiet minute never looks like a hang.
   */
  status?: string
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
  refreshNotes(opts?: { fromScratch?: boolean; recheckSpent?: boolean }): Promise<unknown>
  depositSOL(lamports: number, opts?: { split?: boolean }): Promise<{ signature: string; leafIndex: number }>
  depositSPL(
    mint: string,
    raw: number | string,
    opts?: { split?: boolean },
  ): Promise<{ signature: string; leafIndex: number }>
  withdrawSOL(
    lamports: number,
    recipient: string,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string; changeNote?: ChangeNoteRef }>
  withdrawSPL(
    mint: string,
    raw: number | string,
    recipient: string,
    opts?: { relay?: boolean; inputNotes?: Array<{ blinding: string }> },
  ): Promise<{ signature: string; changeNote?: ChangeNoteRef }>
  transferNoteSOL(
    recipient: string,
    netLamports: number,
    opts?: {
      relay?: boolean
      inputNotes?: Array<{ blinding: string }>
      /** SDK hook fired after prep (recipient keys, merkle proof) but before proving. */
      onSubmitted?: (info: unknown) => Promise<void> | void
    },
  ): Promise<{ signature: string; leafIndex: number; commitment: string; changeNote?: ChangeNoteRef }>
  transferNoteSPL(
    mint: string,
    recipient: string,
    netRaw: number,
    opts?: {
      relay?: boolean
      inputNotes?: Array<{ blinding: string }>
      onSubmitted?: (info: unknown) => Promise<void> | void
    },
  ): Promise<{ signature: string; leafIndex: number; commitment: string; changeNote?: ChangeNoteRef }>
  /**
   * Pins a minted change note's authoritative leaf index (matched by
   * blinding) and un-pends it, so the lane's next row can spend it without
   * waiting for a sync-scan heal. Optional: mocks and older clients omit it
   * and the note heals on the next refresh as before.
   */
  resolveChangeNote?(
    treeKey: string,
    mintAddress: string | undefined,
    change: ChangeNoteRef,
  ): Promise<void>
  /** SDK adjudication: spending signature if any of these notes is already spent. */
  signatureIfSpent?(blindings: string[]): Promise<string | null>
  /** Exposed by the SDK client; lets the engine reserve/pin inputs for parallel lanes. */
  readonly publicKey?: PublicKey
}

export interface NoteRef {
  id: string
  amount: string
  blinding: string
}

/** A payout's change note, identified by its blinding (the leaf index that
 * comes with it is only a guess until the indexer sees the tx). */
export interface ChangeNoteRef {
  amount: string
  blinding: string
  index: number
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
  /** Forces one indexer sync so plan-time balance reads see fresh leaves. Optional: tests omit it and no network call is made. */
  kickIndexer?(): Promise<void>
}

const ATTEMPTS = 3
// Hard cap on parallel payout chains — the picker scales its options with
// machine cores and must never offer more than this. Lanes are note chains,
// not CPU threads; past ~8 the wall is devnet landing + mirror indexing, so
// higher counts serve big-core machines (32) rather than same-machine speed.
const LANES = 32
const RESERVE_POLL_MS = 350
const RESERVE_WAIT_CAP_MS = 120_000
// A thrown-after-broadcast payout is adjudicated by polling its nullifiers:
// the relayer's in-flight guard holds ~60s while the first submit is still
// proving and the nullifier mirror syncs lazily, so a single immediate check
// reads "not landed" for a payout that lands a minute later (rows reported
// failed while the money arrived). The window matches the guard's TTL — past
// it a retry is safe again.
export const ADJUDICATE_POLLS = 12
const ADJUDICATE_POLL_MS = 5_000
const REFRESH_MIN_GAP_MS = 1_500
// Below this many rows the split fan-out costs more than the serialization it
// removes, so short runs pay straight through the change chain.
const SPLIT_MIN_ROWS = 10

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
export class NoteLedger {
  private free = new Map<string, { id: string; amount: bigint; blinding: string }>()
  private reserved = new Set<string>()
  /** Per-lane change-note claims (A5): lane -> the blinding its last payout minted. */
  private laneClaims = new Map<number, { blinding: string; seenFree: boolean; at: number }>()
  /** Claims outlive the reloads that fire while their note is still pending —
   * expiry needs evidence: the note observed free and then gone, or a
   * no-landing age past the 8s resolve window. */
  private static readonly CLAIM_LAND_TIMEOUT_MS = 10_000
  /** Lanes holding a reservation or mid-transfer; waiters poll while this is > 0. */
  busy = 0

  reload(notes: NoteRef[], now: number = Date.now()): void {
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
    // A pending note must not void its claim: reloads fire every ~1.5s under
    // load while the note is still invisible to listNotes. Expire on evidence
    // only — landed-then-gone (spent/healed), or no landing within the cap.
    for (const [lane, claim] of [...this.laneClaims]) {
      const landed = [...this.free.values()].some((n) => n.blinding === claim.blinding)
      if (landed) {
        claim.seenFree = true
      } else if (claim.seenFree || now - claim.at > NoteLedger.CLAIM_LAND_TIMEOUT_MS) {
        this.laneClaims.delete(lane)
      }
    }
  }

  claimForLane(lane: number): string | undefined {
    return this.laneClaims.get(lane)?.blinding
  }

  setLaneClaim(lane: number, blinding: string, now: number = Date.now()): void {
    this.laneClaims.set(lane, { blinding, seenFree: false, at: now })
  }

  /** Largest note covering gross (preferring the lane's claimed change note),
   * else the greedy largest + complement pair. */
  tryReserve(gross: bigint, preferBlinding?: string): PinnedNotes | null {
    const free = [...this.free.values()].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
    )
    const take = (n: { id: string; blinding: string }) => {
      this.free.delete(n.id)
      this.reserved.add(n.id)
    }
    const claimed = preferBlinding
      ? free.find((n) => n.blinding === preferBlinding && n.amount >= gross)
      : undefined
    const single = claimed ?? free.find((n) => n.amount >= gross)
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
  private setStatus: (status: string | undefined) => void = () => {}
  private statusRef: string | undefined = undefined
  private startedAt = 0
  private fundedAt?: number
  private merges = 0
  private splits = 0
  private laneCount = 0

  constructor(private deps: EngineDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  async run(req: RunRequest, onUpdate?: (s: RunSnapshot) => void): Promise<RunReceipt> {
    this.cancelled = false
    this.startedAt = this.deps.now()
    this.fundedAt = undefined
    this.merges = 0
    this.splits = 0
    this.statusRef = undefined
    const decimals = req.asset.kind === "sol" ? 9 : req.asset.decimals
    const rows: RowState[] = req.entries.map((e) => ({
      address: e.address,
      amountHuman: e.amountHuman,
      memo: e.memo,
      status: "queued" as EntryStatus,
      attempts: 0,
    }))
    let currentPhase: RunSnapshot["phase"] = "funding"
    this.emit = (phase, depositSig) => {
      // Once cancelled, never show a running phase again: the engine winds
      // in-flight rows down asynchronously, and letting "paying" resurrect
      // after the user hit cancel made the button look dead.
      if (this.cancelled && phase !== "settled") phase = "aborted"
      currentPhase = phase
      onUpdate?.({
        phase,
        rows: rows.map((r) => ({ ...r })),
        depositSig,
        startedAt: this.startedAt,
        fundedAt: this.fundedAt,
        splits: this.splits,
        lanes: this.laneCount,
        status: this.statusRef,
      })
    }
    // Status is held outside the emit closure so any code path can update the
    // current activity and re-emit the same phase without rebuilding rows.
    this.setStatus = (status) => {
      if (this.statusRef === status) return
      this.statusRef = status
      this.emit(currentPhase)
    }
    // One shared indexer kick at a time, at most one per 20s across all
    // lanes: a per-row kick every 5s during an adjudication storm pinned the
    // backend's sync lock and starved the relayer (28/min collapsed to 7/min
    // on a 5-lane run).
    let kickInFlight: Promise<void> | null = null
    let lastKickAt = 0
    const gatedKick = (): Promise<void> => {
      if (!this.deps.kickIndexer) return Promise.resolve()
      if (this.deps.now() - lastKickAt < 20_000) return Promise.resolve()
      if (kickInFlight) return kickInFlight
      lastKickAt = this.deps.now()
      kickInFlight = this.deps
        .kickIndexer()
        .catch(() => {})
        .finally(() => {
          kickInFlight = null
        })
      return kickInFlight
    }

    await this.deps.client.init()
    await this.deps.client.unlock()

    // Verify the vault from the chain before planning. The caller's
    // pre-unlock total can hold phantom notes (spent on-chain by a cancelled
    // earlier run but never marked spent locally), which under-quotes the
    // deposit and let the vault run dry mid-run — 17 rows died with
    // "insufficient private balance" in the measured 100-row run because of
    // exactly that. A regular refresh + the SDK's nullifier re-check cleans
    // phantoms in seconds; a fromScratch rescan here cost ~90s of start lag
    // on every run, so it is reserved for reserveFor's gated heal.
    let vaultRaw = req.vaultRaw
    if (this.deps.listNotes && !this.cancelled) {
      try {
        this.setStatus("Verifying the private vault balance from the chain…")
        // fire, never await: the kick runs a FULL backend sync and blocks
        // ~90s on a grown tree — that was the 1.5-minute hold before every
        // run. The refresh below is best-effort anyway; reserveFor's gated
        // heal and the mid-run top-up cover whatever it misses.
        void gatedKick()
        await this.deps.client.refreshNotes({ recheckSpent: true })
        vaultRaw = this.deps.listNotes(req.asset).reduce((s, n) => s + BigInt(n.amount), 0n)
      } catch {
        // keep the caller's estimate — the mid-run top-up below still backstops it
      }
    }
    const planOpts = {
      mode: req.mode,
      // the floor is SOL-denominated; token raw units never pay it
      minTransferFee: req.asset.kind === "sol" ? req.minTransferFee : 0,
    }
    let plan = planRun(req.entries, decimals, req.bps, vaultRaw, planOpts)
    // Fresh-deposit fast path: EVERY full run pays from one fresh deposit.
    // Payouts leave a change note each, so a vault fragments by design —
    // paying from the leftovers degrades run over run (26/min on a fresh
    // deposit, 10/min on the next run through merge chains). Planning
    // against an empty vault makes funding deposit the full amount: the run
    // rides change chains exactly like a first deposit, every time. The
    // leftover notes stay in the vault as spendable money. Full-size runs
    // only (the same bar as the lane fan-out): for a short run a gasless
    // merge beats another wallet prompt.
    if (this.deps.listNotes && plan.rows.length >= SPLIT_MIN_ROWS) {
      this.setStatus("Paying this run from one fresh deposit — leftover vault notes stay spendable…")
      plan = planRun(req.entries, decimals, req.bps, 0n, planOpts)
    }

    const feeFloorBig = BigInt(req.asset.kind === "sol" ? (req.minTransferFee ?? 0) : 0)
    const bpsBig = BigInt(req.bps)
    const feeOf = (net: bigint): bigint => {
      const f = (net * bpsBig + 9_999n) / 10_000n
      return f < feeFloorBig ? feeFloorBig : f
    }
    // The lane fan-out pays a relayer fee per split self-transfer; without
    // budgeting those, the final rows starve by a few tens of thousands of
    // lamports (the measured 100-run: last row short by 28,482). Simulate the
    // halving waves on the deposit itself, then pad — the extra stays in the
    // payer's own vault.
    const splitBudget = ((): bigint => {
      if (plan.shortfall === 0n || plan.rows.length < SPLIT_MIN_ROWS) return 0n
      const target = Math.min(Math.max(1, req.lanes ?? LANES), LANES, plan.rows.length)
      let notes = [plan.shortfall]
      let fees = 0n
      while (notes.length < target && notes.length < 64) {
        const next: bigint[] = []
        for (const x of notes) {
          const pool = x - feeOf(x)
          const half = pool / 2n
          fees += feeOf(half)
          next.push(half, pool - half)
        }
        notes = next
      }
      return (fees * 3n) / 2n + 60_000n
    })()

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
        const amount = Number(plan.shortfall + splitBudget)
        if (amount <= 0 || !Number.isSafeInteger(amount)) throw new Error("bad deposit size")
        // A wide run starts its fan-out from two half-notes instead of one —
        // one fewer halving wave (a proof + relay per split) before the lanes
        // open. Only when each half can fund the widest row alone; otherwise
        // the split would buy a merge chain, not lanes.
        const maxGross = plan.rows.reduce((m, r) => (r.gross > m ? r.gross : m), 0n)
        const wantSplit =
          plan.rows.length >= SPLIT_MIN_ROWS && (plan.shortfall + splitBudget) / 2n >= maxGross
        const splitOpt = wantSplit ? { split: true } : undefined
        const dep =
          req.asset.kind === "sol"
            ? await this.deps.client.depositSOL(amount, splitOpt)
            : await this.deps.client.depositSPL(req.asset.mint, amount, splitOpt)
        firstSig = dep.signature
        lastLeaf = dep.leafIndex
        await this.deps.waitUntilIndexed(treeKeyOf(req.asset), lastLeaf)
        await this.deps.client.refreshNotes()
        this.fundedAt = this.deps.now()
        funding = { depositedRaw: BigInt(amount), txSignature: firstSig ?? "", depositedAt: this.fundedAt }
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
    if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset), this.deps.now())

    const selfAddress = this.deps.client.publicKey?.toBase58()

    let lastRefreshAt = 0
    let lastFromScratchAt = 0
    let refreshInFlight: Promise<void> | null = null
    const reloadLedger = (): void => {
      if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset), this.deps.now())
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
    const reserveFor = async (gross: bigint, lane?: number): Promise<PinnedNotes | null> => {
      if (!ledger) return null
      const deadline = this.deps.now() + RESERVE_WAIT_CAP_MS
      let scannedFinal = false
      let mergeRounds = 0
      let healedOnce = false
      let lastStallKickAt = 0
      for (;;) {
        const pinned = ledger.tryReserve(gross, lane !== undefined ? ledger.claimForLane(lane) : undefined)
        if (pinned) {
          ledger.busy++
          return pinned
        }
        if (this.cancelled) return null
        if (ledger.busy === 0) {
          // nothing is in flight, so the view is authoritative
          if (!scannedFinal) {
            scannedFinal = true
            // On prod the mirror syncs lazily (~once/min): the change note
            // this row needs may exist on-chain but not in the mirror yet —
            // the 10/min ceiling on the measured 100-row run. Kick the sync
            // so the refresh below can actually see it.
            void gatedKick()
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
          // last resort before conceding: one full rescan (bounded once per
          // row, not throttled) — a skipped leaf can hide real money from
          // the cursor view exactly when a row needs it
          if (!healedOnce) {
            healedOnce = true
            await this.deps.client.refreshNotes({ fromScratch: true }).catch(() => {})
            reloadLedger()
            continue
          }
          return null
        }
        // other lanes are mid-payout and their change notes are coming; wait
        scannedFinal = false
        if (this.deps.now() > deadline) return null
        // Kick the sync even with lanes busy: the note this row waits for
        // belongs to a lane whose tx ALREADY landed — busy stays >0 while
        // every lane starves on the lazy mirror (the prod 100-row gridlock:
        // "4 proving, 35 waiting" for minutes). Kick at most every 15s.
        if (this.deps.now() - lastStallKickAt > 15_000) {
          lastStallKickAt = this.deps.now()
          void gatedKick()
        }
        void scheduleRefresh()
        await this.deps.sleep(RESERVE_POLL_MS)
      }
    }

    /**
     * Last-resort funding recovery when the note pool cannot cover a row: one
     * full rescan (the "missing" money may be an unseen change note), then —
     * if the vault is genuinely short — a single top-up deposit sized to
     * everything still owed, shared by all starving lanes via the in-flight
     * promise. Rows must never silently strand on a dry vault again (17 died
     * that way in the measured run); one wallet signature mid-run is the
     * price of guaranteeing it.
     */
    let topUpInFlight: Promise<boolean> | null = null
    let topUpsUsed = 0
    const ensureTopUp = async (gross: bigint): Promise<boolean> => {
      if (!ledger || topUpsUsed >= 1) return false
      if (topUpInFlight) return topUpInFlight
      topUpInFlight = (async () => {
        try {
          await this.deps.client.refreshNotes({ fromScratch: true }).catch(() => {})
          reloadLedger()
          if (ledger.totalFree() >= gross) return true
          topUpsUsed++
          const owed = plan.rows.reduce(
            (s, r, i) =>
              rows[i].status === "confirmed" || rows[i].status === "relayed" || rows[i].status === "confirming"
                ? s
                : s + r.gross,
            0n,
          )
          const amount = Number(owed + plan.margin + 120_000n)
          if (amount <= 0 || !Number.isSafeInteger(amount)) return false
          this.setStatus(
            `Vault ran dry — signing one top-up deposit of ${(amount / 1e9).toFixed(4)} SOL to finish the run…`,
          )
          const dep =
            req.asset.kind === "sol"
              ? await this.deps.client.depositSOL(amount)
              : await this.deps.client.depositSPL(req.asset.mint, amount)
          await this.deps.waitUntilIndexed(treeKeyOf(req.asset), dep.leafIndex)
          await this.deps.client.refreshNotes().catch(() => {})
          reloadLedger()
          return true
        } catch {
          // a rejected wallet popup (or dead RPC) is not a payout failure —
          // concede and let the row report the honest balance error
          return false
        } finally {
          topUpInFlight = null
        }
      })()
      return topUpInFlight
    }

    // Confirms detached from the payout lanes (A6); drained before settle.
    const confirms: Array<Promise<void>> = []

    /**
     * A row's change note is the next row's input on this lane. Claim it by
     * blinding so tryReserve prefers it without a refresh detour, and let
     * resolveChangeNote pin the authoritative leaf index in the background —
     * until it lands the note stays pending in the SDK (unspendable), so a
     * claim can never reserve a guess.
     */
    const claimLaneChange = (
      lane: number,
      change: ChangeNoteRef,
    ): void => {
      if (!ledger) return
      ledger.setLaneClaim(lane, change.blinding, this.deps.now())
      const resolving = this.deps.client.resolveChangeNote?.(
        treeKeyOf(req.asset),
        req.asset.kind === "sol" ? undefined : req.asset.mint,
        change,
      )
      void resolving?.then(() => reloadLedger()).catch(() => {})
    }

    const payOne = async (
      row: RowState,
      planRow: (typeof plan.rows)[number],
      lane: number,
    ): Promise<void> => {
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
        const timing: RowTiming = {}
        // set the moment the SDK hands the tx to the relay — anything thrown
        // before this is a pre-broadcast failure and must release the pins
        // for retry, never be mistaken for a landed payout
        let submitted = false
        try {
          const reserveStart = this.deps.now()
          pinned = await reserveFor(gross, lane)
          timing.reserveMs = this.deps.now() - reserveStart
          if (this.cancelled) {
            if (pinned) {
              ledger?.release(pinned)
              if (ledger) ledger.busy--
            }
            row.status = "failed"
            row.error = "cancelled"
            return
          }
          if (!pinned && ledger && (await ensureTopUp(gross))) {
            pinned = await reserveFor(gross, lane)
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
          let changeNote: ChangeNoteRef | undefined
          if (req.mode === "shielded") {
            // Exact net in the note; the SDK takes its fee from the sender's
            // remaining notes, so no gross solve is needed here.
            const net = Number(planRow.net)
            let proveStart = this.deps.now()
            const onSubmitted = async (): Promise<void> => {
              submitted = true
              timing.prepMs = this.deps.now() - reserveStart - (timing.reserveMs ?? 0)
              proveStart = this.deps.now()
            }
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.transferNoteSOL(row.address, net, { ...pinOpts, onSubmitted })
                : await this.deps.client.transferNoteSPL(req.asset.mint, row.address, net, {
                    ...pinOpts,
                    onSubmitted,
                  })
            timing.proveRelayMs = this.deps.now() - proveStart
            sig = res.signature
            row.txSignature = res.signature
            row.noteLeafIndex = res.leafIndex
            row.noteCommitment = res.commitment
            changeNote = res.changeNote
          } else {
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.withdrawSOL(Number(gross), row.address, pinOpts)
                : await this.deps.client.withdrawSPL(req.asset.mint, Number(gross), row.address, pinOpts)
            sig = res.signature
            row.txSignature = res.signature
            changeNote = res.changeNote
          }
          row.error = undefined
          row.relayedAt = this.deps.now()
          row.status = "relayed"
          row.timing = timing
          this.emit("paying", funding?.txSignature)
          if (changeNote) claimLaneChange(lane, changeNote)
          // The nullifiers are irreversibly on the chain the moment the
          // relayer accepted the tx — holding the pins through the confirm
          // only starves the other lanes. Spent at relay time; a
          // relay-OK-but-chain-fail leaves the ledger short one note,
          // matching the SDK's markNoteSpent semantics (the next refresh
          // resurrects the truth).
          if (pinned && ledger) {
            ledger.commitSpent(pinned)
            ledger.busy--
            pinned = null
          }
          // Confirm off the critical path: this worker picks up its next row
          // now; run() awaits every confirm before settle() reads statuses.
          const confirmStart = this.deps.now()
          confirms.push(
            this.deps.confirmSignature(sig)
              .then((ok) => {
                timing.confirmMs = this.deps.now() - confirmStart
                row.status = ok ? "confirmed" : "confirming"
                row.confirmedAt = this.deps.now()
                this.emit("paying", funding?.txSignature)
                void scheduleRefresh()
              })
              .catch(() => {
                // a dead websocket is not a failed payout — settle keeps
                // this row "confirming" rather than mapping relayed→failed
                row.status = "confirming"
              }),
          )
          return
        } catch (e) {
          const msg = (e as Error).message
          // A pinned note can vanish from the SDK's live spendable set
          // between the ledger reload and the tx build (a landing lane's
          // scan marks notes spent mid-flight). Re-sync before the retry so
          // it re-resolves from a current set — but a REGULAR sync only: a
          // fromScratch rescan here costs ~90s per hit and floods the
          // backend, and with more lanes the heals themselves caused the
          // next round of vanishes (the 5-lane run collapsed to 7/min).
          // If the note is genuinely spent, reserveFor's gated full rescan
          // is the one that finds out.
          if (!submitted && /pinned note not found|pinned notes hold /.test(msg)) {
            await this.deps.client.refreshNotes().catch(() => {})
            reloadLedger()
          }
          // A throw after broadcast must never free the pinned notes for a
          // retry until we know they are not spent on-chain: the relayer
          // refuses a retry for ~60s anyway (in-flight guard), so spend that
          // window adjudicating — poll the pinned notes' nullifiers and, if
          // one is spent, the payout landed and carries the real signature.
          // Holding the pins through the poll also stops a racing row from
          // re-reserving the same notes and reporting a phantom success (the
          // run whose UI counted 98 paid while the chain held 73 payouts).
          let landed = false
          if (pinned && (submitted || req.mode !== "shielded")) {
            if (req.mode === "shielded" && this.deps.client.signatureIfSpent) {
              this.setStatus("Verifying whether the payout already reached the chain…")
              for (let poll = 0; poll < ADJUDICATE_POLLS; poll++) {
                const sig = await this.deps.client.signatureIfSpent(pinned.blindings).catch(() => null)
                if (sig) {
                  landed = true
                  row.txSignature = sig
                  break
                }
                if (this.cancelled || poll === ADJUDICATE_POLLS - 1) break
                await gatedKick()
                await this.deps.sleep(ADJUDICATE_POLL_MS)
              }
            }
            if (!landed) {
              await this.deps.client.refreshNotes().catch(() => {})
              reloadLedger()
              const spendable = new Set(
                (this.deps.listNotes?.(req.asset) ?? []).map((n) => n.blinding),
              )
              landed = pinned.blindings.every((b) => !spendable.has(b))
            }
          }
          this.setStatus(undefined)
          if (pinned && ledger) {
            if (landed) ledger.commitSpent(pinned)
            else ledger.release(pinned)
            ledger.busy--
            pinned = null
          }
          if (landed) {
            if (row.txSignature) {
              row.error = undefined
              row.relayedAt = this.deps.now()
              row.status = "relayed"
              this.emit("paying", funding?.txSignature)
              const confirmStart = this.deps.now()
              row.status = (await this.deps.confirmSignature(row.txSignature)) ? "confirmed" : "confirming"
              timing.confirmMs = (timing.confirmMs ?? 0) + this.deps.now() - confirmStart
              row.confirmedAt = this.deps.now()
              row.timing = timing
              this.emit("paying", funding?.txSignature)
              void scheduleRefresh()
              return
            }
            row.error = `unconfirmed after broadcast: ${msg}`
            row.status = "confirming"
            return
          }
          row.error = msg
          if (attempt === ATTEMPTS) row.status = "failed"
          else await this.deps.sleep(500 * 2 ** (attempt - 1))
        }
      }
    }

    /**
     * Lane fan-out: right after the single funding signature the vault is one
     * big note, so payout lanes serialize on its change chain (~8s per hop —
     * the measured 5-row run). Split notes with gasless self-transfers
     * (relayer-signed, still zero wallet signatures) until there are about
     * `lanes` spendable notes, then rows prove truly in parallel.
     */
    const splitForLanes = async (): Promise<void> => {
      if (!ledger || !selfAddress || plan.rows.length < SPLIT_MIN_ROWS) return
      const target = Math.min(Math.max(1, req.lanes ?? LANES), LANES, plan.rows.length)
      for (let wave = 0; wave < 4 && !this.cancelled; wave++) {
        const free = ledger
          .freeNotes()
          .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))
        // never split below the widest row: every note the fan-out produces
        // must still pay any single payout alone, otherwise the splits would
        // just buy a merge chain (a proof + tx each) instead of lanes
        const maxGross = plan.rows.reduce((m, r) => (r.gross > m ? r.gross : m), 0n)
        // only notes that can actually fund a row count toward the lane
        // target — leftover dust from an earlier run must not make the
        // fan-out think the lanes already exist (the second 100-run counted
        // 6 dust notes, split once instead of seven times, and serialized
        // every payout through a single chain)
        const laneWorthy = free.filter((n) => n.amount >= maxGross)
        if (laneWorthy.length >= target) return
        const splittable = free.filter((n) => {
          const half = (n.amount - feeOf(n.amount)) / 2n
          return half >= maxGross && half > feeOf(half)
        })
        if (splittable.length === 0) return
        this.setStatus(
          `Building ${target} payout lanes: splitting note ${laneWorthy.length + 1} of ${target} (proof ~5s each)…`,
        )
        await Promise.all(
          splittable.map(async (n) => {
            const half = (n.amount - feeOf(n.amount)) / 2n
            try {
              const res =
                req.asset.kind === "sol"
                  ? await this.deps.client.transferNoteSOL(selfAddress, Number(half), {
                      relay: true as const,
                      inputNotes: [{ blinding: n.blinding }],
                    })
                  : await this.deps.client.transferNoteSPL(req.asset.mint, selfAddress, Number(half), {
                      relay: true as const,
                      inputNotes: [{ blinding: n.blinding }],
                    })
              this.splits++
              this.setStatus(
                `Waiting for the chain to index split ${this.splits}… (a fresh payout lane)`,
              )
              await this.deps.waitUntilIndexed(treeKeyOf(req.asset), res.leafIndex)
            } catch {
              /* best-effort: the run continues with fewer, larger notes */
            }
          }),
        )
        await this.deps.client.refreshNotes().catch(() => {})
        reloadLedger()
      }
      this.setStatus(undefined)
    }

    // Fan the funding note out before lanes start claiming pieces of it.
    await splitForLanes()
    this.setStatus(undefined)
    this.emit("paying", funding?.txSignature)
    let next = 0
    // Widest rows first: greedy consumption fragments the change pool and the
    // circuit caps a proof at 2 inputs, so paying the largest rows while big
    // notes still exist keeps the tail rows payable without merge round-trips.
    const order = plan.rows
      .map((r, i) => ({ gross: r.gross, i }))
      .sort((a, b) => (a.gross > b.gross ? -1 : a.gross < b.gross ? 1 : 0))
      .map((o) => o.i)
    const worker = async (lane: number): Promise<void> => {
      for (;;) {
        if (this.cancelled) return
        const k = next++
        if (k >= order.length) return
        const i = order[k]
        await payOne(rows[i], plan.rows[i], lane)
      }
    }
    const laneCount = ledger ? Math.min(Math.max(1, req.lanes ?? LANES), LANES, rows.length) : 1
    this.laneCount = laneCount
    await Promise.all(Array.from({ length: laneCount }, (_, lane) => worker(lane)))
    // settle() maps anything not confirmed/confirming to failed, so every
    // detached confirm must have landed its final status first
    await Promise.allSettled(confirms)

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
      splits: this.splits || undefined,
      timing: meanTiming(rows),
      summary: {
        sent: entries.filter((e) => e.status === "sent").length,
        failed: entries.filter((e) => e.status === "failed").length,
        total: entries.length,
      },
    }
    saveRun(receipt)
    this.statusRef = undefined
    this.emit(phase, funding?.txSignature)
    return receipt
  }
}

export function treeKeyOf(asset: Asset): string {
  return asset.kind === "sol" ? solTreeKey() : splTreeKey(asset.mint)
}

/** Per-stage means across the rows that completed, for the timing table. */
function meanTiming(rows: RowState[]): RowTiming | undefined {
  const sum: Required<RowTiming> = { reserveMs: 0, prepMs: 0, proveRelayMs: 0, confirmMs: 0 }
  const n: Required<RowTiming> = { reserveMs: 0, prepMs: 0, proveRelayMs: 0, confirmMs: 0 }
  for (const r of rows) {
    if (!r.timing) continue
    for (const k of Object.keys(sum) as Array<keyof RowTiming>) {
      const v = r.timing[k]
      if (v !== undefined) {
        sum[k] += v
        n[k]++
      }
    }
  }
  if (n.reserveMs + n.prepMs + n.proveRelayMs + n.confirmMs === 0) return undefined
  const mean = (k: keyof RowTiming): number | undefined =>
    n[k] === 0 ? undefined : Math.round(sum[k] / n[k]!)
  return {
    reserveMs: mean("reserveMs"),
    prepMs: mean("prepMs"),
    proveRelayMs: mean("proveRelayMs"),
    confirmMs: mean("confirmMs"),
  }
}

async function defaultWaitUntilIndexed(treeKey: string, minLeafIndex: number, timeoutMs = 30_000): Promise<void> {
  const backend = getBackendUrl()
  const deadline = Date.now() + timeoutMs
  let last: number | null = null
  while (Date.now() < deadline) {
    let next: number | null = null
    try {
      const st = await fetchTreeState(treeKey)
      if (st.nextLeafIndex > minLeafIndex) return
      next = st.nextLeafIndex
    } catch {
      /* transient indexer hiccup — retry */
    }
    // Reads are sync-free and the backend cron only walks the chain once a
    // minute: when the mirror stops advancing, kick it instead of idling out
    // (the split fan-out paid ~80s per run waiting for the cron tick).
    if (backend && next !== null && next === last) {
      fetch(`${backend}/api/indexer/kick`, { method: "POST" }).catch(() => {})
    }
    last = next
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`merkle tree did not index leaf ${minLeafIndex} within ${timeoutMs}ms`)
}

async function defaultConfirm(sig: string): Promise<boolean> {
  const conn = new Connection(config.confirmRpcUrl(), "confirmed")
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
    kickIndexer: () =>
      fetch(`${getBackendUrl()}/api/indexer/kick`, { method: "POST" }).then(() => undefined),
    confirmSignature: defaultConfirm,
    now: () => Date.now(),
    newId: () =>
      Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
}
