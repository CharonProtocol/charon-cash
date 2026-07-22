import type { LightWasm } from "@lightprotocol/hasher.rs"
import { Connection, PublicKey } from "@solana/web3.js"

import { MERKLE_TREE_DEPTH } from "./constants"
import { deriveAccounts } from "./program"

// MerkleTreeAccount layout (programs/.../state/initialize.rs), repr(C):
const NEXT_INDEX_OFF = 8 // u32
const ROOT_INDEX_OFF = 12 // u8
const ROOT_HISTORY_OFF = 848 // [[u8;32]; 100]
// GlobalConfig layout: authority[32], deposit_fee_rate u16, withdrawal_fee_rate u16, fee_error_margin u16
const WITHDRAWAL_FEE_OFF = 34
const FEE_MARGIN_OFF = 36

export interface SolTreeState {
  /** Merkle root as a decimal field-element string (circuit-ready). */
  root: string
  nextLeafIndex: number
}

/**
 * Local Poseidon Merkle mirror (zeroElement = 0), matching the on-chain tree.
 * Backed by localStorage (per wallet) so it survives reloads. The browser owns
 * its note set, so this tracks every commitment it created — no shared indexer.
 */
export class LocalMirror {
  private zeros: string[] = ["0"]
  private layers: string[][] = [[]]
  private wasm: LightWasm
  constructor(wasm: LightWasm) {
    this.wasm = wasm
    for (let i = 1; i <= MERKLE_TREE_DEPTH; i++) {
      this.zeros[i] = wasm.poseidonHashString([this.zeros[i - 1], this.zeros[i - 1]])
    }
  }
  static fromLeaves(wasm: LightWasm, leaves: string[]): LocalMirror {
    const m = new LocalMirror(wasm)
    for (const l of leaves) m.insert(l)
    return m
  }
  insert(leaf: string): void {
    const ix = this.layers[0].length
    this.layers[0][ix] = leaf
    let i = ix
    for (let lv = 1; lv <= MERKLE_TREE_DEPTH; lv++) {
      i >>= 1
      const l = this.layers[lv - 1][i * 2]
      const r = i * 2 + 1 < this.layers[lv - 1].length ? this.layers[lv - 1][i * 2 + 1] : this.zeros[lv - 1]
      ;(this.layers[lv] ??= [])[i] = this.wasm.poseidonHashString([l, r])
    }
  }
  indexOf(leaf: string): number {
    return this.layers[0].indexOf(leaf)
  }
  path(index: number): string[] {
    const els: string[] = []
    for (let lv = 0; lv < MERKLE_TREE_DEPTH; lv++) {
      const sib = index ^ 1
      els[lv] = sib < (this.layers[lv]?.length ?? 0) ? this.layers[lv][sib] : this.zeros[lv]
      index >>= 1
    }
    return els
  }
  leaves(): string[] {
    return this.layers[0].slice()
  }
}

function beBytesToDecimal(bytes: Uint8Array): string {
  let r = 0n
  for (const b of bytes) r = (r << 8n) + BigInt(b)
  return r.toString()
}

/** Read current root + next leaf index from the on-chain SOL tree account. */
export async function readSolTreeState(
  connection: Connection,
  programId: PublicKey,
): Promise<SolTreeState> {
  const { treeAccount } = deriveAccounts(programId, new Uint8Array(32), new Uint8Array(32))
  const acct = await connection.getAccountInfo(treeAccount)
  if (!acct) throw new Error("tree account not initialized — call initialize first")
  const rootIndex = acct.data[ROOT_INDEX_OFF]
  const rootBytes = acct.data.subarray(
    ROOT_HISTORY_OFF + rootIndex * 32,
    ROOT_HISTORY_OFF + rootIndex * 32 + 32,
  )
  return { root: beBytesToDecimal(rootBytes), nextLeafIndex: acct.data.readUInt32LE(NEXT_INDEX_OFF) }
}

/** Read withdrawal fee rate + error margin (bps) from the on-chain global config. */
export async function readGlobalFees(
  connection: Connection,
  programId: PublicKey,
): Promise<{ withdrawalFeeRateBps: number; feeErrorMarginBps: number }> {
  const { globalConfig } = deriveAccounts(programId, new Uint8Array(32), new Uint8Array(32))
  const acct = await connection.getAccountInfo(globalConfig)
  if (!acct) throw new Error("global config not initialized")
  return {
    withdrawalFeeRateBps: acct.data.readUInt16LE(WITHDRAWAL_FEE_OFF),
    feeErrorMarginBps: acct.data.readUInt16LE(FEE_MARGIN_OFF),
  }
}

export function isProgramInitialized(
  connection: Connection,
  programId: PublicKey,
): Promise<boolean> {
  return (async () => {
    const { treeAccount } = deriveAccounts(programId, new Uint8Array(32), new Uint8Array(32))
    return !!(await connection.getAccountInfo(treeAccount))
  })()
}
