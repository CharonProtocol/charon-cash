import { Connection } from "@solana/web3.js"
import { fetchTreeState, solTreeKey, splTreeKey } from "privacy-cash-sdk"

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
    opts?: { relay?: boolean },
  ): Promise<{ signature: string }>
  withdrawSPL(
    mint: string,
    raw: number | string,
    recipient: string,
    opts?: { relay?: boolean },
  ): Promise<{ signature: string }>
  transferNoteSOL(
    recipient: string,
    netLamports: number,
    opts?: { relay?: boolean },
  ): Promise<{ signature: string; leafIndex: number; commitment: string }>
  transferNoteSPL(
    mint: string,
    recipient: string,
    netRaw: number,
    opts?: { relay?: boolean },
  ): Promise<{ signature: string; leafIndex: number; commitment: string }>
}

export interface EngineDeps {
  client: EngineClient
  waitUntilIndexed(treeKey: string, minLeafIndex: number): Promise<void>
  confirmSignature(sig: string): Promise<boolean>
  now(): number
  newId(): string
  sleep(ms: number): Promise<void>
}

const ATTEMPTS = 3

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
    const plan = planRun(req.entries, decimals, req.bps, req.vaultRaw)
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

    this.emit("paying", funding?.txSignature)
    for (let i = 0; i < rows.length; i++) {
      if (this.cancelled) {
        for (const r of rows.slice(i)) {
          r.status = "failed"
          r.error = "cancelled"
        }
        break
      }
      const row = rows[i]
      const gross = plan.rows[i].gross
      const amount = Number(gross)
      if (!Number.isSafeInteger(amount)) {
        row.status = "failed"
        row.error = "amount exceeds safe integer range"
        continue
      }
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        row.attempts = attempt
        row.status = "proving"
        this.emit("paying", funding?.txSignature)
        try {
          let sig: string
          if (req.mode === "shielded") {
            // Exact net in the note; the SDK takes its fee from the sender's
            // remaining notes, so no gross solve is needed here.
            const net = Number(plan.rows[i].net)
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.transferNoteSOL(row.address, net, { relay: true })
                : await this.deps.client.transferNoteSPL(req.asset.mint, row.address, net, { relay: true })
            sig = res.signature
            row.txSignature = res.signature
            row.noteLeafIndex = res.leafIndex
            row.noteCommitment = res.commitment
          } else {
            const res =
              req.asset.kind === "sol"
                ? await this.deps.client.withdrawSOL(amount, row.address, { relay: true })
                : await this.deps.client.withdrawSPL(req.asset.mint, amount, row.address, { relay: true })
            sig = res.signature
            row.txSignature = res.signature
          }
          row.error = undefined
          row.status = "relayed"
          this.emit("paying", funding?.txSignature)
          row.status = (await this.deps.confirmSignature(sig)) ? "confirmed" : "confirming"
          this.emit("paying", funding?.txSignature)
          break
        } catch (e) {
          row.error = (e as Error).message
          if (attempt === ATTEMPTS) row.status = "failed"
          else await this.deps.sleep(500 * 2 ** (attempt - 1))
        }
      }
      await this.deps.client.refreshNotes()
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
