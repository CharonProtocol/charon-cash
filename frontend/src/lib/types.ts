export interface RelayResponse {
  signature: string
  slot: number | null
  status: string
}

export interface MintFeeInfo {
  mint: string
  fee_ata: string
}

export interface RelayerInfo {
  program_id: string
  fee_recipient: string
  fee_rate_bps: number
  withdrawal_fee_rate_bps: number
  fee_error_margin_bps: number
  supported_mints: MintFeeInfo[]
}

export interface TreeState {
  tree_key: string
  next_leaf_index: number
  current_root: string
  known_roots: string[]
  leaf_count: number
}

export interface MerklePath {
  path_elements: string[]
  path_indices: number[]
}

export interface NullifierStatus {
  nullifier: string
  spent: boolean
}

export interface IndexerStatus {
  last_signature: string | null
  last_slot: number
  sol_utxo_count: number
}

export interface HealthStatus {
  status: string
}

export type WithdrawKind = "sol" | "spl"

export interface WithdrawRequest {
  kind: string
  proof_a: string
  proof_b: string
  proof_c: string
  root: string
  public_amount: string
  ext_data_hash: string
  input_nullifiers: [string, string]
  output_commitments: [string, string]
  ext_amount: number
  fee: number
  encrypted_output1: string
  encrypted_output2: string
  recipient: string
  mint?: string
}

export interface InitializeSplRequest {
  mint: string
  max_deposit_amount?: number
}

export interface UpdateConfigRequest {
  deposit_fee_rate?: number
  withdrawal_fee_rate?: number
  fee_error_margin?: number
}

export interface UpdateDepositLimitRequest {
  new_limit: number
}

export interface UpdateDepositLimitSplRequest {
  mint: string
  new_limit: number
}
