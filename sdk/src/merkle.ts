import { SOL_TREE_KEY, backendUrl, relayerUrl } from "./constants"

export interface RelayerInfo {
  programId: string
  feeRecipient: string
  withdrawalFeeRateBps: number
  feeErrorMarginBps: number
  supportedMints: { mint: string; feeAta: string }[]
  /**
   * Unrecoverable rent for the two nullifier marker accounts every transact
   * creates. The relayer fronts this and is reimbursed the fee in the same
   * transaction, so it is the floor a fee has to clear — not the ~5,000 lamport
   * transaction fee, which it dwarfs by roughly 250x.
   */
  transactRentLamports: number
  /** The minimum fee `/api/relayer/transact` will accept, rent and margin included. */
  minTransactFeeLamports: number
  /** False when the relayer has no lookup table configured, so SPL cannot be relayed. */
  splRelayAvailable: boolean
}

export interface TreeState {
  nextLeafIndex: number
  /** Merkle root as a decimal field-element string (circuit-ready). */
  root: string
  knownRoots: string[]
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

// Backend URL override set by the host app via setBackendUrl(). When empty,
// getBackendUrl() falls back to the zero-config default in constants.backendUrl()
// (VITE_BACKEND_URL, or http://localhost:8080 if that is unset), so the SDK runs
// with no environment configuration at all.
let BACKEND_URL = ""
let RELAYER_URL = ""

export function setBackendUrl(url: string): void {
  BACKEND_URL = url.replace(/\/$/, "")
}
export function getBackendUrl(): string {
  return BACKEND_URL || backendUrl()
}

/** Point `/api/relayer/*` at a separate origin. Defaults to the backend URL. */
export function setRelayerUrl(url: string): void {
  RELAYER_URL = url.replace(/\/$/, "")
}
export function getRelayerUrl(): string {
  return RELAYER_URL || relayerUrl()
}

/**
 * Relayer paths go to the relayer, everything else to the indexer. Routing by path
 * rather than making callers pick keeps the split in one place, so a deployment that
 * runs them separately does not need every call site updated.
 */
function originFor(path: string): string {
  return path.startsWith("/api/relayer/") ? getRelayerUrl() : getBackendUrl()
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
  const res = await fetch(getRelayerUrl() + "/api/relayer/submit", {
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

/** Shim-signed atomic v1 swap. Does not use Phantom. */
export async function relaySwap(req: {
  proofIn: {
    proofA: number[]
    proofB: number[]
    proofC: number[]
    root: number[]
    publicAmount: number[]
    extDataHash: number[]
    inputNullifiers: number[][]
    outputCommitments: number[][]
  }
  proofOut: {
    proofA: number[]
    proofB: number[]
    proofC: number[]
    root: number[]
    publicAmount: number[]
    extDataHash: number[]
    inputNullifiers: number[][]
    outputCommitments: number[][]
  }
  extAmountIn: number | string
  extAmountOut: number | string
  encryptedOutputIn1: Uint8Array
  encryptedOutputIn2: Uint8Array
  encryptedOutputOut1: Uint8Array
  encryptedOutputOut2: Uint8Array
  fromMint: string
  outMint: string
  routeData: Uint8Array
  routeAccounts: { pubkey: string; isWritable: boolean }[]
}): Promise<string> {
  const pack = (p: typeof req.proofIn) => ({
    proof_a: bytesToHex(p.proofA),
    proof_b: bytesToHex(p.proofB),
    proof_c: bytesToHex(p.proofC),
    root: bytesToHex(p.root),
    public_amount: bytesToHex(p.publicAmount),
    ext_data_hash: bytesToHex(p.extDataHash),
    input_nullifiers: p.inputNullifiers.map((n) => bytesToHex(n)),
    output_commitments: p.outputCommitments.map((n) => bytesToHex(n)),
  })
  const res = await fetch(getRelayerUrl() + "/api/relayer/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proof_in: pack(req.proofIn),
      proof_out: pack(req.proofOut),
      ext_amount_in: req.extAmountIn,
      ext_amount_out: req.extAmountOut,
      encrypted_output_in1: bytesToHex(req.encryptedOutputIn1),
      encrypted_output_in2: bytesToHex(req.encryptedOutputIn2),
      encrypted_output_out1: bytesToHex(req.encryptedOutputOut1),
      encrypted_output_out2: bytesToHex(req.encryptedOutputOut2),
      from_mint: req.fromMint,
      out_mint: req.outMint,
      route_data: bytesToHex(req.routeData),
      route_accounts: req.routeAccounts,
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
  if (!json.signature) throw new Error("relayer swap returned no signature")
  return json.signature as string
}

export interface JupiterRoute {
  minOut: string
  outAmount: string
  routeData: Uint8Array
  routeAccounts: { pubkey: string; isWritable: boolean }[]
}

/** Quote + swap-instructions via the backend shim (avoids browser CORS to Jupiter). */
export async function fetchJupiterRoute(req: {
  inputMint: string
  outputMint: string
  amount: string | number
  userPublicKey: string
  slippageBps?: number
}): Promise<JupiterRoute> {
  const res = await fetch(getBackendUrl() + "/api/jupiter/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: String(req.amount),
      userPublicKey: req.userPublicKey,
      slippageBps: req.slippageBps ?? 100,
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
  const data = json.data ?? json
  const hex = String(data.route_data ?? data.routeData ?? "").replace(/^0x/i, "")
  if (!hex || hex.length % 2 !== 0) throw new Error("jupiter route returned no instruction data")
  const routeData = new Uint8Array(hex.length / 2)
  for (let i = 0; i < routeData.length; i++) {
    routeData[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  const accounts = (data.route_accounts ?? data.routeAccounts ?? []) as {
    pubkey: string
    isWritable?: boolean
    is_writable?: boolean
  }[]
  return {
    minOut: String(data.minOut ?? data.min_out ?? data.otherAmountThreshold ?? ""),
    outAmount: String(data.outAmount ?? data.out_amount ?? ""),
    routeData,
    routeAccounts: accounts.map((a) => ({
      pubkey: a.pubkey,
      isWritable: !!(a.isWritable ?? a.is_writable),
    })),
  }
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

/**
 * The Rust backend wraps successes as `{ success, data, meta }` while the relayer
 * and the dev shim return payloads flat. Unwrap one envelope so callers below only
 * ever see the payload.
 */
function unwrap(data: unknown): any {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>
    if ("success" in record && "data" in record) return record.data
  }
  return data
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(originFor(path) + path)
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
  return unwrap(data)
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(originFor(path) + path, {
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
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error
    const message = err?.message ?? `HTTP ${res.status}`
    // Surface the relayer's machine-readable code so callers can branch on it
    // (FEE_TOO_LOW, UNKNOWN_ROOT, NULLIFIER_SPENT, …) without parsing prose.
    const error = new Error(message) as Error & { code?: string }
    if (err?.code) error.code = err.code
    throw error
  }
  return unwrap(data)
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
    transactRentLamports: Number(r.transact_rent_lamports ?? 0),
    minTransactFeeLamports: Number(r.min_transact_fee_lamports ?? 0),
    splRelayAvailable: r.spl_relay_available !== false,
  }
}

export interface RelayProofPayload {
  proofA: number[]
  proofB: number[]
  proofC: number[]
  root: number[]
  publicAmount: number[]
  extDataHash: number[]
  inputNullifiers: number[][]
  outputCommitments: number[][]
}

export interface RelayTransactRequest {
  proof: RelayProofPayload
  /** Negative for a withdrawal, zero for a shielded transfer. */
  extAmount: string
  fee: string
  encryptedOutput1: Uint8Array
  encryptedOutput2: Uint8Array
  recipient: string
  feeRecipient: string
  mint: string
  isSpl: boolean
  recipientTokenAccount?: string
}

export interface RelayTransactResult {
  signature: string
  /** What the relayer paid out of its own float, for fee-transparency in the UI. */
  rentLamports: number
  feeLamports: number
}

/**
 * Hand a proof to the relayer and let it build, sign and submit.
 *
 * This is the privacy-critical path. A wallet-signed withdrawal names the
 * withdrawing wallet as fee payer and signer directly beside the recipient and the
 * amount, which links them without breaking any cryptography. Sending a pre-signed
 * transaction cannot fix that, because the fee payer is part of the signed message —
 * so the relayer has to be the one compiling it.
 *
 * The relayer cannot tamper with any of this: recipient, amount, fee, fee recipient,
 * mint and both ciphertexts are hashed into `extDataHash`, a Groth16 public input the
 * program verifies. It can refuse, delay, reorder and observe. Nothing else.
 */
export async function relayTransact(
  req: RelayTransactRequest,
): Promise<RelayTransactResult> {
  const p = req.proof
  const r = await postJson("/api/relayer/transact", {
    proof: {
      proof_a: bytesToHex(p.proofA),
      proof_b: bytesToHex(p.proofB),
      proof_c: bytesToHex(p.proofC),
      root: bytesToHex(p.root),
      public_amount: bytesToHex(p.publicAmount),
      ext_data_hash: bytesToHex(p.extDataHash),
      input_nullifiers: p.inputNullifiers.map((n) => bytesToHex(n)),
      output_commitments: p.outputCommitments.map((n) => bytesToHex(n)),
    },
    ext_amount: req.extAmount,
    fee: req.fee,
    encrypted_output1: bytesToHex(req.encryptedOutput1),
    encrypted_output2: bytesToHex(req.encryptedOutput2),
    recipient: req.recipient,
    fee_recipient: req.feeRecipient,
    mint: req.mint,
    is_spl: req.isSpl,
    ...(req.recipientTokenAccount
      ? { recipient_token_account: req.recipientTokenAccount }
      : {}),
  })
  if (!r?.signature) throw new Error("relayer returned no signature")
  return {
    signature: r.signature as string,
    rentLamports: Number(r.rent_lamports ?? 0),
    feeLamports: Number(r.fee_lamports ?? 0),
  }
}

export interface BlockhashInfo {
  blockhash: string
  slot: number
}

/** Latest blockhash + slot from the backend — no client RPC needed to build a tx. */
export async function fetchBlockhash(): Promise<BlockhashInfo> {
  const r = await getJson("/api/relayer/blockhash")
  return { blockhash: r.blockhash, slot: Number(r.slot) }
}

/** Raw Address Lookup Table account bytes (hex), or null if it doesn't exist. */
export async function fetchAltAccount(address: string): Promise<string | null> {
  const r = await getJson(`/api/relayer/alt/${encodeURIComponent(address)}`)
  return r.exists ? (r.data_hex as string) : null
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

// There is deliberately no `fetchMerkleProof` here. `GET /api/merkle/{tree}/proof/
// {leafIndex}` still exists behind a dev-only backend flag for debugging, but asking
// for it in production names the leaf you are about to spend, which is the one fact
// the pool is built to hide. Paths come from a locally rebuilt tree instead — see the
// note above `merkleForSpend` in `client.ts`.
//
// Same reasoning removed `checkEncryptedOutput`: asking "is this exact ciphertext
// indexed yet" identifies the ciphertext as yours. `waitForLeafIndex` answers the
// same question with a leaf count, which is identical for every caller.

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function solTreeKey(): string {
  return SOL_TREE_KEY
}

export function splTreeKey(mint: string): string {
  return mint
}

/** Hex (with or without 0x, 64 nybbles) or already-decimal field element → decimal. */
export function commitmentToDecimal(c: string): string {
  const s = c.trim()
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s).toString()
  if (/^[0-9a-fA-F]{64}$/.test(s)) return BigInt("0x" + s).toString()
  return s
}

/**
 * Commitments from `from` onward, in leaf-index order (decimal field elements).
 *
 * Deliberately not parameterized by which leaf you care about. The request is
 * identical for everyone at the same sync position, so it tells the backend nothing
 * about which note is yours — see the note above `merkleForSpend` in `client.ts`.
 * `/api/merkle/{tree}/leaves` returns bare commitments, roughly an order of
 * magnitude less bandwidth than `/api/utxos/range`, which also ships the ciphertext
 * and signature per leaf only for this caller to discard them.
 */
export async function fetchTreeLeavesFrom(
  treeKey: string,
  from = 0,
): Promise<{ leaves: string[]; from: number; nextIndex: number }> {
  const byIndex = new Map<number, string>()
  let start = from
  let nextIndex = from
  while (true) {
    const q = new URLSearchParams({ from: String(start) })
    const r = await getJson(
      `/api/merkle/${encodeURIComponent(treeKey)}/leaves?${q}`,
    )
    nextIndex = Number(r.next_leaf_index ?? r.nextLeafIndex ?? nextIndex)
    const rows = (r.leaves ?? []) as { leaf_index: number; commitment: string }[]
    for (const row of rows) {
      byIndex.set(Number(row.leaf_index), commitmentToDecimal(row.commitment))
    }
    const hasMore = !!(r.has_more ?? r.hasMore)
    if (!hasMore || rows.length === 0) break
    start = Number(r.next_from ?? r.nextFrom ?? start + rows.length)
  }

  const leaves: string[] = []
  for (let i = from; i < nextIndex; i++) {
    const c = byIndex.get(i)
    if (c === undefined) {
      // A hole means the indexer is mid-write. Rebuilding on a gapped tree would
      // produce a root that matches nothing, so fail loudly instead.
      throw new Error(
        `merkle indexer gap at leaf ${i} (have ${byIndex.size} leaves from ${from} to ${nextIndex})`,
      )
    }
    leaves.push(c)
  }
  return { leaves, from, nextIndex }
}

/** All tree commitments in leaf-index order (decimal field elements). */
export async function fetchTreeLeaves(treeKey: string): Promise<string[]> {
  return (await fetchTreeLeavesFrom(treeKey, 0)).leaves
}

export async function registerPrivacyKeys(args: {
  wallet: string
  spendPubkey: string
  viewingPubkeyHex: string
}): Promise<void> {
  const res = await fetch(getBackendUrl() + "/api/registration/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: args.wallet,
      spend_pubkey: args.spendPubkey,
      viewing_pubkey: args.viewingPubkeyHex,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `register failed HTTP ${res.status}`)
  }
}

export async function lookupPrivacyKeys(
  wallet: string,
): Promise<{ spendPubkey: string; viewingPubkeyHex: string } | null> {
  const res = await fetch(
    getBackendUrl() + `/api/registration/lookup/${encodeURIComponent(wallet)}`,
  )
  if (res.status === 404) return null
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  }
  const spend = String(data?.spend_pubkey ?? data?.spendPubkey ?? "")
  const view = String(data?.viewing_pubkey ?? data?.viewingPubkey ?? "").replace(/^0x/i, "")
  if (!spend || !view) return null
  if (!/^[0-9a-fA-F]{64}$/.test(view)) return null
  return { spendPubkey: spend, viewingPubkeyHex: view }
}
