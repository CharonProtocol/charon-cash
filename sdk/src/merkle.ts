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

export interface IndexedUtxo {
  leafIndex: number
  commitment: string
  encryptedOutputHex: string
  signature: string
  slot: number
}

export interface UtxoRangePage {
  treeKey: string
  start: number
  end: number
  total: number
  nextIndex: number
  hasMore: boolean
  utxos: IndexedUtxo[]
}

export interface UtxoCheckResult {
  exists: boolean
  treeKey?: string
  leafIndex?: number
  commitment?: string
  signature?: string
  slot?: number
}

// Backend URL is configurable; defaults to the Vite env var the frontend sets.
let BACKEND_URL: string = (
  ((import.meta as any).env?.VITE_BACKEND_URL as string | undefined) ?? ""
).replace(/\/$/, "")

export function setBackendUrl(url: string): void {
  BACKEND_URL = url.replace(/\/$/, "")
}
export function getBackendUrl(): string {
  return BACKEND_URL
}

function u8ToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0")
  }
  return out
}

export async function submitTransaction(
  serializedTx: Uint8Array,
): Promise<string> {
  if (!BACKEND_URL) {
    throw new Error(
      "backend URL not set — call setBackendUrl() or set VITE_BACKEND_URL",
    )
  }
  const res = await fetch(BACKEND_URL + "/api/relayer/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: u8ToHex(serializedTx) }),
  })
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
  const payload = data as { signature?: string; status?: string } | null
  if (!payload?.signature) {
    throw new Error("relayer returned no signature")
  }
  if (
    payload.status &&
    payload.status !== "confirmed" &&
    payload.status !== "submitted" &&
    payload.status !== "ok"
  ) {
    throw new Error(`relayer status: ${payload.status}`)
  }
  return payload.signature
}

/** Relayer-signed withdraw: POST proof fields; backend builds + signs + submits. */
export async function relayWithdraw(req: {
  kind: "sol" | "spl"
  proofA: number[]
  proofB: number[]
  proofC: number[]
  root: number[]
  publicAmount: number[]
  extDataHash: number[]
  inputNullifiers: number[][]
  outputCommitments: number[][]
  extAmount: number
  fee: number
  encryptedOutput1: Uint8Array
  encryptedOutput2: Uint8Array
  /** SOL: wallet. SPL: recipient ATA. */
  recipient: string
  mint?: string
  /** SPL: wallet that owns the recipient ATA. */
  recipientOwner?: string
}): Promise<string> {
  if (!BACKEND_URL) {
    throw new Error(
      "backend URL not set — call setBackendUrl() or set VITE_BACKEND_URL",
    )
  }
  const body = {
    kind: req.kind,
    proof_a: bytesToHex(req.proofA),
    proof_b: bytesToHex(req.proofB),
    proof_c: bytesToHex(req.proofC),
    root: bytesToHex(req.root),
    public_amount: bytesToHex(req.publicAmount),
    ext_data_hash: bytesToHex(req.extDataHash),
    input_nullifiers: req.inputNullifiers.map((n) => bytesToHex(n)),
    output_commitments: req.outputCommitments.map((n) => bytesToHex(n)),
    ext_amount: req.extAmount,
    fee: req.fee,
    encrypted_output1: bytesToHex(req.encryptedOutput1),
    encrypted_output2: bytesToHex(req.encryptedOutput2),
    recipient: req.recipient,
    mint: req.mint,
    recipient_owner: req.recipientOwner,
  }
  const res = await fetch(BACKEND_URL + "/api/relayer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
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
  const payload = data as { signature?: string; status?: string } | null
  if (!payload?.signature) {
    throw new Error("relayer returned no signature")
  }
  if (
    payload.status &&
    payload.status !== "confirmed" &&
    payload.status !== "submitted" &&
    payload.status !== "ok"
  ) {
    throw new Error(`relayer status: ${payload.status}`)
  }
  return payload.signature
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = "0x"
  for (let i = 0; i < bytes.length; i++)
    out += (bytes as number[])[i].toString(16).padStart(2, "0")
  return out
}
function hexToDecimal(hex: string): string {
  return BigInt(hex).toString()
}

/** Poseidon / Fr decimal string → 32-byte big-endian hex (no 0x). */
export function fieldToHex32(dec: string): string {
  let hex = BigInt(dec).toString(16)
  if (hex.length % 2) hex = "0" + hex
  return hex.padStart(64, "0")
}

async function getJson(path: string): Promise<any> {
  if (!BACKEND_URL) {
    throw new Error(
      "backend URL not set — call setBackendUrl() or set VITE_BACKEND_URL",
    )
  }
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
    supportedMints: (r.supported_mints ?? []).map((m: any) => ({
      mint: m.mint,
      feeAta: m.fee_ata,
    })),
  }
}

export async function fetchTreeState(treeKey: string): Promise<TreeState> {
  const s = await getJson(`/api/merkle/${encodeURIComponent(treeKey)}`)
  return {
    nextLeafIndex: s.next_leaf_index,
    root: hexToDecimal("0x" + s.current_root),
    knownRoots: (s.known_roots ?? []).map((h: string) =>
      hexToDecimal("0x" + h),
    ),
  }
}

export async function fetchMerkleProof(
  treeKey: string,
  leafIndex: number,
): Promise<MerkleProof> {
  const p = await getJson(
    `/api/merkle/${encodeURIComponent(treeKey)}/proof/${leafIndex}`,
  )
  const raw = p.path_elements
  const isNested = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])
  const asHex = isNested
    ? (raw as ArrayLike<number>[]).map((b) => bytesToHex(b))
    : (raw as string[])
  return {
    pathElements: asHex.map(hexToDecimal),
    pathIndices: p.path_indices,
  }
}

export async function isNullifierSpent(hashHex: string): Promise<boolean> {
  try {
    const r = await getJson(`/api/nullifier/${encodeURIComponent(hashHex)}`)
    return !!r.spent
  } catch {
    return false
  }
}

export async function fetchUtxoRange(
  treeKey: string,
  start: number,
  end: number,
): Promise<UtxoRangePage> {
  const q = new URLSearchParams({
    tree_key: treeKey,
    start: String(start),
    end: String(end),
  })
  const r = await getJson(`/api/utxos/range?${q}`)
  return {
    treeKey: r.tree_key,
    start: r.start,
    end: r.end,
    total: Number(r.total),
    nextIndex: Number(r.next_index ?? r.total),
    hasMore: !!r.has_more,
    utxos: (r.utxos ?? []).map((u: any) => ({
      leafIndex: Number(u.leaf_index),
      commitment: u.commitment as string,
      encryptedOutputHex: u.encrypted_output_hex as string,
      signature: u.signature as string,
      slot: Number(u.slot),
    })),
  }
}

export async function checkEncryptedOutput(
  encryptedHex: string,
  treeKey?: string,
): Promise<UtxoCheckResult> {
  const hex = encryptedHex.replace(/^0x/i, "").toLowerCase()
  const q = treeKey
    ? `?tree_key=${encodeURIComponent(treeKey)}`
    : ""
  const r = await getJson(`/api/utxos/check/${encodeURIComponent(hex)}${q}`)
  if (!r.exists) return { exists: false }
  return {
    exists: true,
    treeKey: r.tree_key,
    leafIndex: Number(r.leaf_index),
    commitment: r.commitment,
    signature: r.signature,
    slot: Number(r.slot),
  }
}

export interface WaitOpts {
  timeoutMs?: number
  intervalMs?: number
}

/** Poll until `next_leaf_index > minLeafIndex` (i.e. leaves through minLeafIndex exist). */
export async function waitForLeafIndex(
  treeKey: string,
  minLeafIndex: number,
  opts: WaitOpts = {},
): Promise<TreeState> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 750
  const deadline = Date.now() + timeoutMs
  let last: TreeState | null = null
  while (Date.now() < deadline) {
    last = await fetchTreeState(treeKey)
    if (last.nextLeafIndex > minLeafIndex) return last
    await sleep(intervalMs)
  }
  throw new Error(
    `indexer timeout waiting for leaf ${minLeafIndex} on tree ${treeKey}` +
      (last ? ` (next=${last.nextLeafIndex})` : ""),
  )
}

/** Poll until an encrypted output hex appears in the indexer. */
export async function waitForEncryptedOutput(
  encryptedHex: string,
  treeKey?: string,
  opts: WaitOpts = {},
): Promise<UtxoCheckResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 750
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await checkEncryptedOutput(encryptedHex, treeKey)
    if (r.exists) return r
    await sleep(intervalMs)
  }
  throw new Error("indexer timeout waiting for encrypted output")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function solTreeKey(): string {
  return SOL_TREE_KEY
}

export function splTreeKey(mint: string): string {
  return mint
}
