export type Asset =
  | { kind: "sol" }
  | { kind: "spl"; mint: string; decimals: number }

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
}

export interface RunReceipt {
  id: string
  createdAt: number
  fileHash: string
  asset: Asset
  mode: RunMode
  totalPlanned: bigint
  entries: ReceiptEntry[]
  funding?: { depositedRaw: bigint; txSignature: string } | null
  summary: { sent: number; failed: number; total: number }
}
