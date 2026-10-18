export type Asset =
  | { kind: "sol" }
  | { kind: "spl"; mint: string; decimals: number; symbol?: string }

/** One row of an uploaded payroll file. amountHuman is the EXACT net the employee must receive. */
export interface PayrollEntry {
  address: string
  amountHuman: string
  memo?: string
}

export interface ParsedFile {
  entries: PayrollEntry[]
  fileHash: string
}

export type EntryStatus =
  | "queued"
  | "proving"
  | "relayed"
  | "confirmed"
  | "confirming"
  | "failed"

export type RunMode = "public" | "shielded"

export interface ReceiptEntry {
  address: string
  amountHuman: string
  memo?: string
  status: "sent" | "failed" | "confirming"
  txSignature?: string
  error?: string
  attempts: number
  /** Shielded mode only: tree leaf of the recipient's note. */
  noteLeafIndex?: number
  /** Shielded mode only: commitment of the recipient's note (hex). */
  noteCommitment?: string
  /** Epoch ms: prove/relay began for this row, relay accepted it, chain confirmed. */
  startedAt?: number
  relayedAt?: number
  confirmedAt?: number
  /** Stage timings (queue / reserve / prep / prove+relay / confirm) in ms. */
  timing?: {
    queueMs?: number
    reserveMs?: number
    prepMs?: number
    proveRelayMs?: number
    confirmMs?: number
  }
}

export interface RunReceipt {
  id: string
  createdAt: number
  fileHash: string
  asset: Asset
  mode: RunMode
  totalPlanned: bigint
  entries: ReceiptEntry[]
  funding?: { depositedRaw: bigint; txSignature: string; depositedAt?: number } | null
  /** Epoch ms the run started, the deposit confirmed, and the last row settled. */
  startedAt?: number
  fundedAt?: number
  finishedAt?: number
  /** Fragment-merge self-transfers the engine ran to keep rows payable. */
  merges?: number
  /** Funding-note splits the engine ran up front so lanes prove in parallel. */
  splits?: number
  /** Where the funding phase went: vault check, deposit (prove + send + land), index + note scan. */
  fundingTiming?: { verifyMs: number; depositMs: number; indexMs: number }
  /** Mean stage durations across paid rows (queue / reserve / prep / prove+relay / confirm). */
  timing?: {
    queueMs?: number
    reserveMs?: number
    prepMs?: number
    proveRelayMs?: number
    confirmMs?: number
  }
  summary: { sent: number; failed: number; total: number }
}
