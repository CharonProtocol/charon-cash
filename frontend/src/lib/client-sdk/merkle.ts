import { api } from "@/lib/api"
import { SOL_TREE_KEY } from "./constants"

export interface RelayerInfo {
  programId: string
  feeRecipient: string
  withdrawalFeeRateBps: number
  feeErrorMarginBps: number
  supportedMints: { mint: string; feeAta: string }[]
}

export interface TreeState {
  nextLeafIndex: number
  /** Merkle root as a decimal field-element string (circuit-ready). */
  root: string
  knownRoots: string[]
}

export interface MerkleProof {
  /** 26 sibling hashes as decimal field-element strings (circuit-ready). */
  pathElements: string[]
  /** 26 direction bits (0 = left, 1 = right). */
  pathIndices: number[]
}

function bytesHexToDecimal(hex: string): string {
  return BigInt(hex).toString()
}

export async function fetchRelayerInfo(): Promise<RelayerInfo> {
  const r = await api.relayerInfo()
  return {
    programId: r.program_id,
    feeRecipient: r.fee_recipient,
    withdrawalFeeRateBps: r.withdrawal_fee_rate_bps,
    feeErrorMarginBps: r.fee_error_margin_bps,
    supportedMints: r.supported_mints.map((m) => ({
      mint: m.mint,
      feeAta: m.fee_ata,
    })),
  }
}

export async function fetchTreeState(treeKey: string): Promise<TreeState> {
  const s = await api.merkleState(treeKey)
  return {
    nextLeafIndex: s.next_leaf_index,
    root: bytesHexToDecimal("0x" + s.current_root),
    knownRoots: s.known_roots.map((h) => bytesHexToDecimal("0x" + h)),
  }
}

export async function fetchMerkleProof(
  treeKey: string,
  leafIndex: number,
): Promise<MerkleProof> {
  const p = await api.merkleProof(treeKey, leafIndex)
  return {
    pathElements: p.path_elements.map(bytesHexToDecimal),
    pathIndices: p.path_indices,
  }
}

export async function isNullifierSpent(hashHex: string): Promise<boolean> {
  try {
    const r = await api.nullifier(hashHex)
    return !!r.spent
  } catch {
    return false
  }
}

export function solTreeKey(): string {
  return SOL_TREE_KEY
}
