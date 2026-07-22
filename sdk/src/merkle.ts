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

// Backend URL is configurable; defaults to the Vite env var the frontend sets.
let BACKEND_URL: string = (((import.meta as any).env?.VITE_BACKEND_URL) ?? "").replace(/\/$/, "")
export function setBackendUrl(url: string): void {
  BACKEND_URL = url.replace(/\/$/, "")
}
export function getBackendUrl(): string {
  return BACKEND_URL
}

function bytesToHex(bytes: ArrayLike<number>): string {
  let out = "0x"
  for (let i = 0; i < bytes.length; i++) out += (bytes as number[])[i].toString(16).padStart(2, "0")
  return out
}
function hexToDecimal(hex: string): string {
  return BigInt(hex).toString()
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(BACKEND_URL + path)
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string } } | null)?.error
    throw new Error(err?.message ?? `HTTP ${res.status}`)
  }
  return data
}

export async function fetchRelayerInfo(): Promise<RelayerInfo> {
  const r = await getJson("/api/relayer/info")
  return {
    programId: r.program_id,
    feeRecipient: r.fee_recipient,
    withdrawalFeeRateBps: r.withdrawal_fee_rate_bps,
    feeErrorMarginBps: r.fee_error_margin_bps,
    supportedMints: (r.supported_mints ?? []).map((m: any) => ({ mint: m.mint, feeAta: m.fee_ata })),
  }
}

export async function fetchTreeState(treeKey: string): Promise<TreeState> {
  const s = await getJson(`/api/merkle/${encodeURIComponent(treeKey)}`)
  return {
    nextLeafIndex: s.next_leaf_index,
    root: hexToDecimal("0x" + s.current_root),
    knownRoots: (s.known_roots ?? []).map((h: string) => hexToDecimal("0x" + h)),
  }
}

export async function fetchMerkleProof(treeKey: string, leafIndex: number): Promise<MerkleProof> {
  const p = await getJson(`/api/merkle/${encodeURIComponent(treeKey)}/proof/${leafIndex}`)
  const raw = p.path_elements
  const isNested = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])
  const asHex = isNested ? (raw as ArrayLike<number>[]).map((b) => bytesToHex(b)) : (raw as string[])
  return { pathElements: asHex.map(hexToDecimal), pathIndices: p.path_indices }
}

export async function isNullifierSpent(hashHex: string): Promise<boolean> {
  try {
    const r = await getJson(`/api/nullifier/${encodeURIComponent(hashHex)}`)
    return !!r.spent
  } catch {
    return false
  }
}

export function solTreeKey(): string {
  return SOL_TREE_KEY
}
