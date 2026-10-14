import { Connection, type PublicKey } from "@solana/web3.js"
import {
  fetchCommitmentLeaf,
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
  /** Funding confirmed → a lane worker picked the row up. */
  queueMs?: number
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
  /** Pay a shielded full-size run through a payout tree (two rows per
   * proof, 99 proofs per 100 rows instead of ~107). Opt-in: measured even
   * with lanes in the browser (fewer proofs, each a little slower). */
  tree?: boolean
  /** Shielded full-size runs fund each lane with an exact note (see
   * planExactLanes); false keeps the legacy halving fan-out. Defaults to true. */
  exactLanes?: boolean
}

export interface EngineClient {
  init(): Promise<void>
  unlock(): Promise<void>
  refreshNotes(opts?: { fromScratch?: boolean; recheckSpent?: boolean; quick?: string }): Promise<unknown>
  depositSOL(
    lamports: number,
    opts?: { split?: boolean; firstAmount?: number },
  ): Promise<{ signature: string; leafIndex: number }>
  depositSPL(
    mint: string,
    raw: number | string,
    opts?: { split?: boolean; firstAmount?: number },
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
    opts?: TransferOpts,
  ): Promise<TransferResult>
  transferNoteSPL(
    mint: string,
    recipient: string,
    netRaw: number,
    opts?: TransferOpts,
  ): Promise<TransferResult>
  /**
   * Pins a minted change note's authoritative leaf index (matched by
   * blinding) and un-pends it, so the lane's next row can spend it without
   * waiting for a sync-scan heal. Optional: mocks and older clients omit it
   * and the note heals on the next refresh as before.
   */
  /**
   * Pin a pending change note's authoritative leaf index. Resolves true
   * when the leaf was found; false when the window timed out (the note is
   * a phantom or a hole — the caller should stop re-polling this blinding).
   */
  resolveChangeNote?(
    treeKey: string,
    mintAddress: string | undefined,
    change: ChangeNoteRef,
  ): Promise<boolean | void>
  /** SDK adjudication: spending signature if any of these notes is already spent. */
  signatureIfSpent?(blindings: string[]): Promise<string | null>
  /**
   * Chain-truth restore: un-mark notes burned at relay-accept whose tx
   * failed execution (nullifier absent from the chain). Returns how many
   * notes were restored.
   */
  markNotesUnspent?(blindings: string[]): Promise<number>
  /** Exposed by the SDK client; lets the engine reserve/pin inputs for parallel lanes. */
  readonly publicKey?: PublicKey
}

export interface TransferOpts {
  relay?: boolean
  inputNotes?: Array<{ blinding: string }>
  /** SDK hook fired after prep (recipient keys, merkle proof) but before proving. */
  onSubmitted?: (info: unknown) => Promise<void> | void
  /** Exact relayer fee (overrides the SDK's bps + floor default). */
  fee?: number
  /** Output 2 pays this recipient instead of change (inputs must be exact). */
  second?: { recipient: string; net: number }
}

export interface TransferResult {
  signature: string
  leafIndex: number
  commitment: string
  changeNote?: ChangeNoteRef
  second?: { leafIndex: number; commitment: string }
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

/** Tri-state confirm: only "failed" is definitive (the tx landed and the
 * program rejected it) — "unknown" keeps the row "confirming". */
export type ConfirmOutcome = "confirmed" | "failed" | "unknown"

export interface EngineDeps {
  client: EngineClient
  waitUntilIndexed(treeKey: string, minLeafIndex: number): Promise<void>
  confirmSignature(sig: string): Promise<ConfirmOutcome>
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
  /** Indexed leaf of a note commitment (null: not found). The SDK's leaf index
   * is a pre-send guess that concurrent lanes share; receipts show this one. */
  leafIndexOf?(treeKey: string, commitment: string): Promise<number | null>
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
  /** Pinned note id -> its blinding. Pins end only via release/commitSpent. */
  private reserved = new Map<string, string>()
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
    // One note = one blinding: a second copy under another id must never be
    // offered while the first is free or pinned (two lanes would spend it).
    const heldBlindings = new Set(this.reserved.values())
    const offered = new Set<string>()
    for (const n of notes) {
      seen.add(n.id)
      if (this.reserved.has(n.id)) continue
      if (heldBlindings.has(n.blinding) || offered.has(n.blinding)) {
        this.free.delete(n.id)
        continue
      }
      offered.add(n.blinding)
      this.free.set(n.id, { id: n.id, amount: BigInt(n.amount), blinding: n.blinding })
    }
    for (const id of [...this.free.keys()]) {
      if (!seen.has(id)) this.free.delete(id)
    }
    // Pins are NOT dropped when their note is briefly missing from the list
    // (flagged mid-heal, re-indexed under a new id): dropping them let the
    // note come back "free" while its lane was still proving, and a second
    // lane spent it again (NULLIFIER_SPENT retries, a wasted proof each).
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

  /** The claimed note's tx definitively failed on-chain (nothing was minted):
   * drop the claim now instead of holding the lane on a phantom through the
   * evidence-expiry window. */
  clearLaneClaim(lane: number, blinding: string): void {
    if (this.laneClaims.get(lane)?.blinding === blinding) this.laneClaims.delete(lane)
  }

  /** Largest note covering gross (preferring the lane's claimed change note),
   * else the greedy largest + complement pair. */
  tryReserve(gross: bigint, preferBlinding?: string): PinnedNotes | null {
    const free = [...this.free.values()].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
    )
    const take = (n: { id: string; blinding: string }) => {
      this.free.delete(n.id)
      this.reserved.set(n.id, n.blinding)
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

  /** The free note with this blinding, if it covers `gross` (a lane's own change). */
  reserveBlinding(blinding: string, gross: bigint): PinnedNotes | null {
    for (const n of this.free.values()) {
      if (n.blinding !== blinding || n.amount < gross) continue
      this.free.delete(n.id)
      this.reserved.set(n.id, n.blinding)
      return { ids: [n.id], blindings: [n.blinding] }
    }
    return null
  }

  /** A free note of exactly `amount` that is not in `exclude` (payout tree). */
  reserveExact(amount: bigint, exclude: Set<string>): PinnedNotes | null {
    for (const n of this.free.values()) {
      if (n.amount !== amount || exclude.has(n.id)) continue
      this.free.delete(n.id)
      this.reserved.set(n.id, n.blinding)
      return { ids: [n.id], blindings: [n.blinding] }
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
    this.reserved.set(a.id, a.blinding)
    this.reserved.set(b.id, b.blinding)
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

/**
 * Payout tree node. A leaf's tx pays one or two rows from a note worth
 * exactly their gross (output 2 pays the second row, so no change note);
 * an internal node's tx splits its note into its children's notes.
 */
export interface PayoutTreeNode {
  /** Exact value of the note this node's tx spends. */
  amount: bigint
  /** Relayer fee of this node's tx. */
  fee: bigint
  /** Leaf only: the plan-row indexes its tx pays. */
  rows?: number[]
  /** Lane leaf (exact-lane plan): the note funds this lane's own chain. */
  lane?: number
  left?: PayoutTreeNode
  right?: PayoutTreeNode
  /** Leaves under this node (scheduling priority: widest first). */
  size: number
}

/**
 * Balanced payout tree over `order` (plan-row indexes), two rows per leaf.
 * With the 2-in/2-out circuit every proof can mint at most one note more than
 * it spends, so 100 payees need >= 99 proofs from one funding deposit: the
 * tree hits that floor (deposit + 48 splits + 50 pair payouts), where lanes
 * pay one row per proof plus the fan-out splits. Leaves pay exactly the
 * per-row fees the plan quoted; each split pays `splitFee`.
 */
export function buildPayoutTree(
  rows: Array<{ gross: bigint; fee: bigint }>,
  order: number[],
  splitFee: bigint,
): PayoutTreeNode {
  if (order.length === 0) throw new Error("payout tree needs rows")
  const leaves: PayoutTreeNode[] = []
  for (let k = 0; k < order.length; k += 2) {
    const ix = order.slice(k, k + 2)
    leaves.push({
      amount: ix.reduce((s, i) => s + rows[i].gross, 0n),
      fee: ix.reduce((s, i) => s + rows[i].fee, 0n),
      rows: ix,
      size: 1,
    })
  }
  return buildSplitTree(leaves, splitFee)
}

/** Balanced binary split tree over `leaves`: each internal node's note is
 * exactly its children's notes plus its own split fee. */
export function buildSplitTree(leaves: PayoutTreeNode[], splitFee: bigint): PayoutTreeNode {
  const build = (lo: number, hi: number): PayoutTreeNode => {
    if (hi - lo === 1) return leaves[lo]
    const mid = (lo + hi + 1) >> 1
    const left = build(lo, mid)
    const right = build(mid, hi)
    return { amount: left.amount + right.amount + splitFee, fee: splitFee, left, right, size: left.size + right.size }
  }
  return build(0, leaves.length)
}

/**
 * Exact-lane plan: rows dealt to `lanes` chains largest-first onto the
 * lightest lane (balanced totals), each lane funded by a note worth exactly
 * its rows' gross. A lane then pays only from its own change chain and ends
 * at zero — no lane ever needs another lane's note, a 2-note pair or a merge.
 * (Halving the deposit evenly left every lane a too-small leftover at the
 * tail: payouts fell from ~1.3/s to ~0.3/s and runs ended in top-ups.)
 */
export function planExactLanes(
  rows: Array<{ gross: bigint }>,
  order: number[],
  lanes: number,
): number[][] {
  const n = Math.max(1, Math.min(lanes, order.length))
  const out: number[][] = Array.from({ length: n }, () => [])
  const sums = new Array<bigint>(n).fill(0n)
  for (const i of order) {
    let k = 0
    for (let j = 1; j < n; j++) if (sums[j] < sums[k]) k = j
    out[k].push(i)
    sums[k] += rows[i].gross
  }
  return out
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
  private fundingTiming: RunReceipt["fundingTiming"] = undefined

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
    this.fundingTiming = undefined
    const verifyStart = this.deps.now()
    const verifying = (async (): Promise<bigint> => {
      if (!this.deps.listNotes || this.cancelled) return req.vaultRaw
      try {
        this.setStatus("Verifying the private vault balance from the chain…")
        // fire, never await: the kick runs a FULL backend sync and blocks
        // ~90s on a grown tree — that was the 1.5-minute hold before every
        // run. The refresh below is best-effort anyway; reserveFor's gated
        // heal and the mid-run top-up cover whatever it misses.
        void gatedKick()
        await this.deps.client.refreshNotes({ recheckSpent: true })
        return this.deps.listNotes(req.asset).reduce((s, n) => s + BigInt(n.amount), 0n)
      } catch {
        // keep the caller's estimate — the mid-run top-up below still backstops it
        return req.vaultRaw
      }
    })()
    // Full-size runs fund from a fresh deposit whatever the vault holds, so
    // the vault check runs alongside the deposit proof instead of before it
    // (a wallet with a long note history paid seconds here); the ledger
    // still waits for it before lanes start.
    const fullSize = !!this.deps.listNotes && req.entries.length >= SPLIT_MIN_ROWS
    const vaultRaw = fullSize ? req.vaultRaw : await verifying
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
      this.setStatus("Paying this run from one fresh deposit - leftover vault notes stay spendable…")
      plan = planRun(req.entries, decimals, req.bps, 0n, planOpts)
    }

    // Widest rows first: greedy consumption fragments the change pool and the
    // circuit caps a proof at 2 inputs, so paying the largest rows while big
    // notes still exist keeps the tail rows payable without merge round-trips.
    const order = plan.rows
      .map((r, i) => ({ gross: r.gross, i }))
      .sort((a, b) => (a.gross > b.gross ? -1 : a.gross < b.gross ? 1 : 0))
      .map((o) => o.i)
    const selfAddress = this.deps.client.publicKey?.toBase58()
    const payoutTree =
      req.tree === true &&
      req.mode === "shielded" &&
      this.deps.listNotes &&
      selfAddress &&
      plan.rows.length >= SPLIT_MIN_ROWS &&
      plan.shortfall > 0n
        ? buildPayoutTree(plan.rows, order, BigInt(req.asset.kind === "sol" ? (req.minTransferFee ?? 0) : 0))
        : null
    const laneTarget = Math.min(Math.max(1, req.lanes ?? LANES), LANES, plan.rows.length)
    const splitFeeExact = BigInt(req.asset.kind === "sol" ? (req.minTransferFee ?? 0) : 0)
    const laneRows =
      !payoutTree &&
      req.exactLanes !== false &&
      req.mode === "shielded" &&
      this.deps.listNotes &&
      selfAddress &&
      plan.rows.length >= SPLIT_MIN_ROWS &&
      plan.shortfall > 0n &&
      laneTarget >= 2
        ? planExactLanes(plan.rows, order, laneTarget)
        : null
    const laneTree = laneRows
      ? buildSplitTree(
          laneRows.map((ix, lane) => ({ amount: ix.reduce((s, i) => s + plan.rows[i].gross, 0n), fee: 0n, lane, size: 1 })),
          splitFeeExact,
        )
      : null
    const fundTree = payoutTree ?? laneTree
    // notes the vault held before this run's deposit: the tree spends only
    // its own exact-value notes, never an older one that happens to match
    const preRunNotes = new Set((fundTree && this.deps.listNotes?.(req.asset).map((n) => n.id)) || [])

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
      if (fundTree || plan.shortfall === 0n || plan.rows.length < SPLIT_MIN_ROWS) return 0n
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
        // The payout tree's deposit IS its root split: exactly its two halves.
        const treeHalves = fundTree?.left && fundTree.right ? [fundTree.left, fundTree.right] : null
        const amount = Number(
          fundTree
            ? treeHalves
              ? treeHalves[0].amount + treeHalves[1].amount
              : fundTree.amount
            : plan.shortfall + splitBudget,
        )
        if (amount <= 0 || !Number.isSafeInteger(amount)) throw new Error("bad deposit size")
        // A wide run starts its fan-out from two half-notes instead of one —
        // one fewer halving wave (a proof + relay per split) before the lanes
        // open. Only when each half can fund the widest row alone; otherwise
        // the split would buy a merge chain, not lanes.
        const maxGross = plan.rows.reduce((m, r) => (r.gross > m ? r.gross : m), 0n)
        const wantSplit =
          plan.rows.length >= SPLIT_MIN_ROWS && (plan.shortfall + splitBudget) / 2n >= maxGross
        const splitOpt = treeHalves
          ? { split: true, firstAmount: Number(treeHalves[0].amount) }
          : fundTree
            ? undefined
            : wantSplit
              ? { split: true }
              : undefined
        const depositStart = this.deps.now()
        const dep =
          req.asset.kind === "sol"
            ? await this.deps.client.depositSOL(amount, splitOpt)
            : await this.deps.client.depositSPL(req.asset.mint, amount, splitOpt)
        firstSig = dep.signature
        lastLeaf = dep.leafIndex
        const indexStart = this.deps.now()
        await this.deps.waitUntilIndexed(treeKeyOf(req.asset), lastLeaf)
        // mid-run poll semantics: the deposit itself reported its note, so
        // only the paid tree needs scanning — no all-tree sweep, no recheck
        await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) })
        this.fundedAt = this.deps.now()
        this.fundingTiming = {
          verifyMs: depositStart - verifyStart,
          depositMs: indexStart - depositStart,
          indexMs: this.fundedAt - indexStart,
        }
        funding = { depositedRaw: BigInt(amount), txSignature: firstSig ?? "", depositedAt: this.fundedAt }
        this.emit("funding", firstSig)
      } catch (e) {
        for (const r of rows) {
          r.status = "failed"
          r.error = `aborted: funding failed - ${(e as Error).message}`
        }
        return this.settle(req, plan.totalNet, rows, funding, "aborted")
      }
    }

    await verifying
    const ledger = this.deps.listNotes ? new NoteLedger() : null
    if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset), this.deps.now())

    let lastRefreshAt = 0
    let lastFromScratchAt = 0
    let refreshInFlight: Promise<void> | null = null
    // Lanes waiting for a note wake the moment the ledger changes (a change
    // note resolved, a refresh landed) instead of on the next poll tick.
    let ledgerWaiters: Array<() => void> = []
    const ledgerChanged = (): Promise<void> => new Promise((r) => ledgerWaiters.push(r))
    const reloadLedger = (): void => {
      if (ledger && this.deps.listNotes) ledger.reload(this.deps.listNotes(req.asset), this.deps.now())
      const waiters = ledgerWaiters
      ledgerWaiters = []
      for (const w of waiters) w()
    }
    // bring fresh notes (change notes land after each relay) into the ledger,
    // at most one scan in flight and never more often than the gap
    const scheduleRefresh = (): Promise<void> => {
      if (refreshInFlight) return refreshInFlight
      if (this.deps.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) return Promise.resolve()
      lastRefreshAt = this.deps.now()
      refreshInFlight = (async () => {
        try {
          // quick: only the paid tree, no old-note recheck — a fresh change
          // note cannot be spent, and re-deriving old nullifiers starved the
          // provers mid-run
          await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) })
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
        await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) })
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
          await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) }).catch(() => {})
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
        await Promise.race([this.deps.sleep(RESERVE_POLL_MS), ledgerChanged()])
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
            `Vault ran dry - signing one top-up deposit of ${(amount / 1e9).toFixed(4)} SOL to finish the run…`,
          )
          const dep =
            req.asset.kind === "sol"
              ? await this.deps.client.depositSOL(amount)
              : await this.deps.client.depositSPL(req.asset.mint, amount)
          await this.deps.waitUntilIndexed(treeKeyOf(req.asset), dep.leafIndex)
          await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) }).catch(() => {})
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

    // Change-note blindings whose resolve windows timed out (phantoms from
    // landed-but-failed attempts, or mirror holes). Claiming them again
    // would poll /api/commitment for the rest of the run — the 404 loops
    // in the field console.
    const deadChanges = new Set<string>()

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
      if (deadChanges.has(change.blinding)) return
      ledger.setLaneClaim(lane, change.blinding, this.deps.now())
      const resolving = this.deps.client.resolveChangeNote?.(
        treeKeyOf(req.asset),
        req.asset.kind === "sol" ? undefined : req.asset.mint,
        change,
      )
      void resolving
        ?.then((ok) => {
          if (ok === false) deadChanges.add(change.blinding)
          return reloadLedger()
        })
        .catch(() => {})
    }

    // the line forms here: rows stamped before this moment waited on funding
    // splits, after it on lane contention — queueMs names which
    let payoutsStart = this.deps.now()

    // A signature already recorded for another row is never this row's
    // landing: the two spent one note (a resurrected note reserved twice).
    const claimedByOther = (sig: string, row: RowState): boolean =>
      rows.some((r) => r !== row && r.txSignature === sig)

    /**
     * Exact-lane reservation: only this lane's own change note (its claim).
     * No claim, a claim that cannot cover the row, or a 30s stall falls back
     * to the shared reserveFor path.
     */
    const reserveOwn = async (gross: bigint, lane: number): Promise<PinnedNotes | null> => {
      if (!ledger) return null
      const deadline = this.deps.now() + 30_000
      for (;;) {
        const claim = ledger.claimForLane(lane)
        const seen = claim ? ledger.freeNotes().find((n) => n.blinding === claim) : undefined
        if (!claim || (seen && seen.amount < gross) || this.deps.now() > deadline) {
          return reserveFor(gross, lane)
        }
        const pin = ledger.reserveBlinding(claim, gross)
        if (pin) {
          ledger.busy++
          return pin
        }
        if (this.cancelled) return null
        await Promise.race([this.deps.sleep(RESERVE_POLL_MS), ledgerChanged()])
      }
    }

    const payOne = async (
      row: RowState,
      planRow: (typeof plan.rows)[number],
      lane: number,
      opts?: { preset?: PinnedNotes; own?: boolean },
    ): Promise<void> => {
      const gross = planRow.gross
      // a lane's funding note, already pinned by the fan-out (first try only)
      let preset = opts?.preset
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (this.cancelled) {
          if (preset) ledger?.release(preset)
          row.status = "failed"
          row.error = "cancelled"
          return
        }
        row.attempts = attempt
        const timing: RowTiming = {}
        if (!row.startedAt) {
          row.startedAt = this.deps.now()
          // how long the row stood in line before a lane took it — fundedAt
          // when the run had to fund, else the payout-phase start
          timing.queueMs = row.startedAt - (this.fundedAt ?? payoutsStart)
        }
        row.status = "proving"
        this.emit("paying", funding?.txSignature)
        let pinned: PinnedNotes | null = null
        // set the moment the SDK hands the tx to the relay — anything thrown
        // before this is a pre-broadcast failure and must release the pins
        // for retry, never be mistaken for a landed payout
        let submitted = false
        // prove+relay window start; reset by onSubmitted so the catch's
        // post-submit stamp below measures only the relay leg
        let proveStart = 0
        try {
          const reserveStart = this.deps.now()
          if (preset && ledger) {
            pinned = preset
            preset = undefined
            ledger.busy++
          } else {
            pinned = opts?.own ? await reserveOwn(gross, lane) : await reserveFor(gross, lane)
          }
          timing.reserveMs = this.deps.now() - reserveStart
          if (this.cancelled) {
            if (pinned) {
              ledger?.release(pinned)
              if (ledger) ledger.busy--
            }
            row.status = "failed"
            row.timing = timing
            row.error = "cancelled"
            return
          }
          if (!pinned && ledger && (await ensureTopUp(gross))) {
            pinned = await reserveFor(gross, lane)
          }
          if (!pinned && ledger) {
            const total = ledger.totalFree()
            row.status = "failed"
            row.timing = timing
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
            proveStart = this.deps.now()
            const onSubmitted = async (): Promise<void> => {
              submitted = true
              timing.prepMs = this.deps.now() - reserveStart - (timing.reserveMs ?? 0)
              proveStart = this.deps.now()
            }
            // the plan's exact fee: exact lanes end their chain at zero
            const fee = Number(planRow.fee)
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.transferNoteSOL(row.address, net, { ...pinOpts, onSubmitted, fee })
                : await this.deps.client.transferNoteSPL(req.asset.mint, row.address, net, {
                    ...pinOpts,
                    onSubmitted,
                    fee,
                  })
            timing.proveRelayMs = this.deps.now() - proveStart
            if (claimedByOther(res.signature, row)) throw new Error("input note was already spent by another payout")
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
          // Capture before commitSpent drops the pin: if the confirm comes
          // back definitively failed, these are the blindings to restore.
          const pinBlindings = pinned ? [...pinned.blindings] : []
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
              .then(async (outcome) => {
                timing.confirmMs = this.deps.now() - confirmStart
                if (outcome === "confirmed") {
                  row.status = "confirmed"
                  row.confirmedAt = this.deps.now()
                  // the receipt's leaf: the indexed one, not the shared guess
                  if (row.noteCommitment && this.deps.leafIndexOf) {
                    const leaf = await this.deps.leafIndexOf(treeKeyOf(req.asset), row.noteCommitment).catch(() => null)
                    if (leaf !== null) row.noteLeafIndex = leaf
                  }
                } else if (outcome === "failed") {
                  // Definitive on-chain execution failure (the program
                  // rejected the spend): no money moved, so the row must
                  // count as failed — never "confirming" (the run-5 receipt
                  // counted dead txs as sent while their pinned change
                  // notes 404'd forever as phantoms). Drop the claim so the
                  // lane's next row re-reserves instead of polling a note
                  // that will never exist, and refresh so the inputs —
                  // committed spent above — resurrect immediately.
                  row.status = "failed"
                  row.error = `payout tx failed on-chain: ${sig}`
                  if (changeNote) ledger?.clearLaneClaim(lane, changeNote.blinding)
                  // Restore the inputs this relay-accept burned: the
                  // program rejected the spend, so their nullifiers are
                  // absent from the chain and the notes are still good.
                  // Restore BEFORE the refresh so the scan sees them back
                  // in the spendable set.
                  if (pinBlindings.length) {
                    void this.deps.client
                      .markNotesUnspent?.(pinBlindings)
                      .catch(() => {})
                      .then(() => scheduleRefresh())
                  } else {
                    void scheduleRefresh()
                  }
                } else {
                  // ambiguous (timeout, lost signal) — keep "confirming"
                  row.status = "confirming"
                }
                this.emit("paying", funding?.txSignature)
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
          // A post-submit throw (relay 409, lost response) still proved and
          // relayed — stamp that window now or the adjudication path below
          // assigns a timing with prep/confirm but no proveRelayMs.
          if (submitted && timing.proveRelayMs === undefined) {
            timing.proveRelayMs = this.deps.now() - proveStart
          }
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
            await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) }).catch(() => {})
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
          let collided = false
          if (pinned && (submitted || req.mode !== "shielded")) {
            if (req.mode === "shielded" && this.deps.client.signatureIfSpent) {
              this.setStatus("Verifying whether the payout already reached the chain…")
              for (let poll = 0; poll < ADJUDICATE_POLLS; poll++) {
                const sig = await this.deps.client.signatureIfSpent(pinned.blindings).catch(() => null)
                if (sig && claimedByOther(sig, row)) {
                  collided = true
                  break
                }
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
            if (!landed && !collided) {
              await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) }).catch(() => {})
              reloadLedger()
              const spendable = new Set(
                (this.deps.listNotes?.(req.asset) ?? []).map((n) => n.blinding),
              )
              landed = pinned.blindings.every((b) => !spendable.has(b))
            }
          }
          this.setStatus(undefined)
          if (pinned && ledger) {
            // a collided note is gone (the other payout spent it)
            if (landed || collided) ledger.commitSpent(pinned)
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
              const outcome = await this.deps.confirmSignature(row.txSignature)
              row.status = outcome === "confirmed" ? "confirmed" : "confirming"
              if (outcome === "confirmed") row.confirmedAt = this.deps.now()
              timing.confirmMs = (timing.confirmMs ?? 0) + this.deps.now() - confirmStart
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
          // failed rows carry their last attempt's stages too — the wall of
          // a run with retries is otherwise partly unattributable
          row.timing = timing
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
        await this.deps.client.refreshNotes({ quick: treeKeyOf(req.asset) }).catch(() => {})
        reloadLedger()
      }
      this.setStatus(undefined)
    }

    /**
     * Payout tree: every ready node (its exact-value note is in the vault)
     * proves at once, widest first, up to the lane cap. A split mints its
     * children's notes; a leaf pays its one or two rows. Any node that fails
     * its attempts leaves its rows queued for the lane path, which pays them
     * from whatever notes the tree left (each holds its subtree's full gross).
     */
    const payTree = async (
      root: PayoutTreeNode,
      startLane?: (lane: number, pin: PinnedNotes) => void,
    ): Promise<void> => {
      if (!ledger || !selfAddress) return
      const treeKey = treeKeyOf(req.asset)
      const cap = Math.min(Math.max(1, req.lanes ?? LANES), LANES)
      this.laneCount = cap
      const internal = root.size - 1 - (root.left ? 1 : 0)
      const waiting: PayoutTreeNode[] = root.left && root.right ? [root.left, root.right] : [root]
      const leafConfirms: Array<Promise<void>> = []
      let inFlight = 0
      let wake: () => void = () => {}
      const woken = (): Promise<void> => new Promise((r) => (wake = r))
      // single-flight refresh that always runs once more after a landing
      // that arrived mid-scan, so a fresh split's notes are never missed
      let scan: Promise<void> | null = null
      let rescan = false
      const refreshTree = (): Promise<void> => {
        if (scan) {
          rescan = true
          return scan
        }
        scan = (async () => {
          do {
            rescan = false
            await this.deps.client.refreshNotes({ quick: treeKey }).catch(() => {})
            reloadLedger()
          } while (rescan)
        })().finally(() => {
          scan = null
        })
        return scan
      }
      const transfer = (to: string, net: bigint, opts: TransferOpts): Promise<TransferResult> =>
        req.asset.kind === "sol"
          ? this.deps.client.transferNoteSOL(to, Number(net), opts)
          : this.deps.client.transferNoteSPL(req.asset.mint, to, Number(net), opts)

      const runNode = async (node: PayoutTreeNode, pin: PinnedNotes): Promise<void> => {
        const leafRows = (node.rows ?? []).map((i) => rows[i])
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
          if (this.cancelled) break
          const timing: RowTiming = {}
          const t0 = this.deps.now()
          for (const r of leafRows) {
            r.attempts = attempt
            r.status = "proving"
            if (!r.startedAt) {
              r.startedAt = t0
              timing.queueMs = t0 - (this.fundedAt ?? this.startedAt)
            }
          }
          if (leafRows.length) this.emit("paying", funding?.txSignature)
          let submitted = false
          let proveStart = t0
          let sig: string | undefined
          let res: TransferResult | undefined
          try {
            const opts: TransferOpts = {
              relay: true,
              inputNotes: pin.blindings.map((blinding) => ({ blinding })),
              fee: Number(node.fee),
              onSubmitted: () => {
                submitted = true
                timing.prepMs = this.deps.now() - t0
                proveStart = this.deps.now()
              },
            }
            if (node.rows) {
              const [a, b] = node.rows.map((i) => plan.rows[i])
              if (b) opts.second = { recipient: b.address, net: Number(b.net) }
              res = await transfer(a.address, a.net, opts)
            } else {
              res = await transfer(selfAddress, node.left!.amount, opts)
            }
            sig = res.signature
            timing.proveRelayMs = this.deps.now() - proveStart
          } catch (e) {
            const msg = (e as Error).message
            for (const r of leafRows) r.error = msg
            // after broadcast the spend may have landed: adjudicate by the
            // input's nullifier before ever re-spending the note
            if (submitted && this.deps.client.signatureIfSpent) {
              for (let poll = 0; poll < ADJUDICATE_POLLS && !sig; poll++) {
                sig = (await this.deps.client.signatureIfSpent(pin.blindings).catch(() => null)) ?? undefined
                if (!sig && poll < ADJUDICATE_POLLS - 1) {
                  await gatedKick()
                  await this.deps.sleep(ADJUDICATE_POLL_MS)
                }
              }
            }
            if (!sig) {
              if (/pinned note not found|pinned notes hold /.test(msg)) await refreshTree()
              if (attempt < ATTEMPTS) await this.deps.sleep(500 * 2 ** (attempt - 1))
              continue
            }
          }
          ledger.commitSpent(pin)
          if (!node.rows) {
            this.splits++
            this.setStatus(
              this.splits < internal
                ? `Fanning out payout notes: split ${this.splits} of ${internal} (pays two employees per proof)…`
                : undefined,
            )
            // the children's notes exist once the split confirms and the
            // scan picks them up; a definitive failure gives the note back
            const outcome = await this.deps.confirmSignature(sig!)
            if (outcome === "failed") {
              await this.deps.client.markNotesUnspent?.(pin.blindings).catch(() => 0)
              await refreshTree()
              const again = ledger.reserveExact(node.amount, preRunNotes)
              if (again && attempt < ATTEMPTS) {
                pin = again
                continue
              }
              if (again) ledger.release(again)
              return
            }
            waiting.push(node.left!, node.right!)
            await refreshTree()
            return
          }
          const leafIdx = [res?.leafIndex, res?.second?.leafIndex]
          const commits = [res?.commitment, res?.second?.commitment]
          leafRows.forEach((r, k) => {
            r.error = undefined
            r.txSignature = sig
            r.noteLeafIndex = leafIdx[k]
            r.noteCommitment = commits[k]
            r.relayedAt = this.deps.now()
            r.status = "relayed"
            r.timing = { ...timing }
          })
          this.emit("paying", funding?.txSignature)
          const confirmStart = this.deps.now()
          leafConfirms.push(
            this.deps.confirmSignature(sig!).then(
              async (outcome) => {
                for (const r of leafRows) {
                  r.timing = { ...r.timing, confirmMs: this.deps.now() - confirmStart }
                  if (outcome === "confirmed") {
                    r.status = "confirmed"
                    r.confirmedAt = this.deps.now()
                  } else if (outcome === "failed") {
                    // nothing moved: hand the rows to the lane path
                    r.status = "queued"
                    r.txSignature = undefined
                    r.error = `payout tx failed on-chain: ${sig}`
                  } else {
                    r.status = "confirming"
                  }
                }
                if (outcome === "failed") {
                  await this.deps.client.markNotesUnspent?.(pin.blindings).catch(() => 0)
                  await refreshTree()
                }
                this.emit("paying", funding?.txSignature)
              },
              () => {
                for (const r of leafRows) r.status = "confirming"
              },
            ),
          )
          return
        }
        // out of attempts: the note goes back to the vault and the rows (or
        // the whole subtree's rows) stay queued for the lane path
        ledger.release(pin)
        for (const r of leafRows) {
          if (r.status === "proving") r.status = "queued"
        }
      }

      this.setStatus(
        startLane
          ? `Funding ${root.size} payout lanes with exact notes (${internal} splits)…`
          : `Fanning out payout notes: ${internal} splits, then two employees per proof…`,
      )
      let idleSince = this.deps.now()
      let lastIdleScan = 0
      while (!this.cancelled) {
        waiting.sort((a, b) => b.size - a.size)
        for (let k = 0; k < waiting.length && inFlight < cap; ) {
          const pin = ledger.reserveExact(waiting[k].amount, preRunNotes)
          if (!pin) {
            k++
            continue
          }
          const node = waiting.splice(k, 1)[0]
          if (node.lane !== undefined) {
            startLane?.(node.lane, pin)
            continue
          }
          inFlight++
          void runNode(node, pin)
            .catch(() => {})
            .finally(() => {
              inFlight--
              wake()
            })
        }
        if (waiting.length === 0 && inFlight === 0) break
        if (inFlight > 0) idleSince = this.deps.now()
        // nothing proving and the notes the waiting nodes need never showed
        // up: stop here and let the lane path pay those rows
        else if (this.deps.now() - idleSince > 20_000) break
        // idle with notes still missing: rescan at most twice a second (a
        // landed scan wakes this loop, so an unthrottled one spins)
        if (inFlight === 0 && this.deps.now() - lastIdleScan > 500) {
          lastIdleScan = this.deps.now()
          void gatedKick()
          void refreshTree()
        }
        await Promise.race([woken(), ledgerChanged(), this.deps.sleep(RESERVE_POLL_MS)])
      }
      await Promise.allSettled(leafConfirms)
      this.setStatus(undefined)
    }

    // Fan the funding note out before lanes start claiming pieces of it; a
    // tree run pays through the tree and leaves lanes only its leftovers.
    if (payoutTree) await payTree(payoutTree)
    else if (laneTree && laneRows && ledger) {
      // each lane starts the moment its exact note exists
      const running: Array<Promise<void>> = []
      this.laneCount = laneRows.length
      payoutsStart = this.deps.now()
      const runLane = async (lane: number, first: PinnedNotes): Promise<void> => {
        let preset: PinnedNotes | undefined = first
        for (const i of laneRows[lane]) {
          if (rows[i].status !== "queued") continue
          await payOne(rows[i], plan.rows[i], lane, { preset, own: true })
          preset = undefined
        }
        if (preset) ledger.release(preset)
      }
      await payTree(laneTree, (lane, pin) => running.push(runLane(lane, pin)))
      await Promise.all(running)
    } else await splitForLanes()
    this.setStatus(undefined)
    this.emit("paying", funding?.txSignature)
    let next = 0
    // rows the payout tree settled (or left mid-flight) are not lane work
    const laneOrder = order.filter((i) => rows[i].status === "queued")
    const worker = async (lane: number): Promise<void> => {
      for (;;) {
        if (this.cancelled) return
        const k = next++
        if (k >= laneOrder.length) return
        const i = laneOrder[k]
        await payOne(rows[i], plan.rows[i], lane)
      }
    }
    const laneCount = ledger ? Math.min(Math.max(1, req.lanes ?? LANES), LANES, rows.length) : 1
    this.laneCount = laneCount
    payoutsStart = this.deps.now()
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
      timing: r.timing,
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
      fundingTiming: this.fundingTiming,
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
  const sum: Required<RowTiming> = { queueMs: 0, reserveMs: 0, prepMs: 0, proveRelayMs: 0, confirmMs: 0 }
  const n: Required<RowTiming> = { queueMs: 0, reserveMs: 0, prepMs: 0, proveRelayMs: 0, confirmMs: 0 }
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
  if (n.queueMs + n.reserveMs + n.prepMs + n.proveRelayMs + n.confirmMs === 0) return undefined
  const mean = (k: keyof RowTiming): number | undefined =>
    n[k] === 0 ? undefined : Math.round(sum[k] / n[k]!)
  return {
    queueMs: mean("queueMs"),
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

// One websocket for every confirm (a Connection per payout opened 100 sockets).
let confirmConn: Connection | null = null
function confirmConnection(): Connection {
  const url = config.confirmRpcUrl()
  if (!confirmConn || confirmConn.rpcEndpoint !== url) confirmConn = new Connection(url, "confirmed")
  return confirmConn
}

async function defaultConfirm(sig: string): Promise<ConfirmOutcome> {
  const conn = confirmConnection()
  // Push, not poll: Alpenglow finality is sub-second on devnet. Subscribe
  // FIRST, then read the status: the relay answers on broadcast, so a tx can
  // confirm between a status read and the subscription — that notification
  // never comes and the row idled out at 45s. A slow status poll backs the
  // websocket up.
  return new Promise((resolve) => {
    let done = false
    const finish = (outcome: ConfirmOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      void conn.removeSignatureListener(subId).catch(() => {})
      resolve(outcome)
    }
    const subId = conn.onSignature(sig, (result) => finish(result.err ? "failed" : "confirmed"), "confirmed")
    const check = async () => {
      try {
        const st = (await conn.getSignatureStatuses([sig])).value?.[0]
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized")
          finish(st.err ? "failed" : "confirmed")
        else if (st?.err) finish("failed")
      } catch {
        /* the websocket or the next poll decides */
      }
    }
    const poll = setInterval(check, 2000)
    const timer = setTimeout(() => finish("unknown"), 45_000)
    void check()
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
    leafIndexOf: (treeKey, commitment) =>
      fetchCommitmentLeaf(commitment, treeKey)
        .then((r) => r.leafIndex)
        .catch(() => null),
    now: () => Date.now(),
    newId: () =>
      Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
}
