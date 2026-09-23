//! PDA derivation and on-chain account reads.
//!
//! Layouts mirror `programs/privacy-cash/src/state/initialize.rs`. The program is
//! Pinocchio and casts account data with `bytemuck` from offset zero, so there is
//! no discriminator prefix to skip.

use solana_sdk::pubkey::Pubkey;

use crate::rpc::RpcClient;

use crate::error::{ErrorCode, RelayerError, RelayerResult};

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const TREE_ACCOUNT_SEED: &[u8] = b"merkle_tree";
pub const TREE_TOKEN_ACCOUNT_SEED: &[u8] = b"tree_token";
pub const NULLIFIER0_SEED: &[u8] = b"nullifier0";
pub const NULLIFIER1_SEED: &[u8] = b"nullifier1";

pub const MERKLE_TREE_HEIGHT: usize = 26;
pub const ROOT_HISTORY_SIZE: usize = 100;

/// The mint string the protocol uses to mean native SOL.
pub const WRAPPED_SOL_MINT: &str = "11111111111111111111111111111112";

pub const SYSTEM_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("11111111111111111111111111111111");
pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const NATIVE_MINT: Pubkey =
    solana_sdk::pubkey!("So11111111111111111111111111111111111111112");
pub const JUPITER_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// The six PDAs a `transact` instruction needs, plus the two nullifier bumps the
/// instruction data carries.
pub struct TransactPdas {
    pub tree_account: Pubkey,
    pub tree_token_account: Pubkey,
    pub global_config: Pubkey,
    pub nullifier0: Pubkey,
    pub nullifier1: Pubkey,
    /// Cross-nullifier guards: the same hashes under the opposite seed. The program
    /// checks these to stop the two inputs being swapped to dodge the spent markers.
    pub nullifier2: Pubkey,
    pub nullifier3: Pubkey,
    pub bump0: u8,
    pub bump1: u8,
}

pub fn derive_transact_pdas(
    program_id: &Pubkey,
    nullifier0_hash: &[u8; 32],
    nullifier1_hash: &[u8; 32],
) -> TransactPdas {
    let (tree_account, _) = Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], program_id);
    let (tree_token_account, _) =
        Pubkey::find_program_address(&[TREE_TOKEN_ACCOUNT_SEED], program_id);
    let (global_config, _) = Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], program_id);
    let (nullifier0, bump0) =
        Pubkey::find_program_address(&[NULLIFIER0_SEED, nullifier0_hash], program_id);
    let (nullifier1, bump1) =
        Pubkey::find_program_address(&[NULLIFIER1_SEED, nullifier1_hash], program_id);
    let (nullifier2, _) =
        Pubkey::find_program_address(&[NULLIFIER0_SEED, nullifier1_hash], program_id);
    let (nullifier3, _) =
        Pubkey::find_program_address(&[NULLIFIER1_SEED, nullifier0_hash], program_id);

    TransactPdas {
        tree_account,
        tree_token_account,
        global_config,
        nullifier0,
        nullifier1,
        nullifier2,
        nullifier3,
        bump0,
        bump1,
    }
}

/// SPL trees are per-mint: PDA(["merkle_tree", mint]).
pub fn derive_spl_tree_account(program_id: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TREE_ACCOUNT_SEED, mint.as_ref()], program_id).0
}

pub fn derive_ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

pub fn is_sol_mixer_mint(mint: &str) -> bool {
    mint == WRAPPED_SOL_MINT
        || mint == NATIVE_MINT.to_string()
        || mint == Pubkey::default().to_string()
}

/// Fee rates from the `global_config` PDA, in basis points.
#[derive(Clone, Copy, Debug)]
pub struct FeeRates {
    pub deposit_fee_rate_bps: u16,
    pub withdrawal_fee_rate_bps: u16,
    pub fee_error_margin_bps: u16,
}

/// `GlobalConfig` is `authority[32] | deposit u16 | withdrawal u16 | margin u16 | pad u8 | bump u8`.
pub fn parse_fee_rates(data: &[u8]) -> RelayerResult<FeeRates> {
    if data.len() < 38 {
        return Err(RelayerError::upstream(format!(
            "global_config account is {} bytes, expected at least 38",
            data.len()
        )));
    }
    Ok(FeeRates {
        deposit_fee_rate_bps: u16::from_le_bytes([data[32], data[33]]),
        withdrawal_fee_rate_bps: u16::from_le_bytes([data[34], data[35]]),
        fee_error_margin_bps: u16::from_le_bytes([data[36], data[37]]),
    })
}

/// Live tree state: the next leaf slot and every root still inside the history ring.
pub struct TreeSnapshot {
    pub next_index: u32,
    pub roots: Vec<[u8; 32]>,
}

/// `MerkleTreeAccount` is
/// `max_deposit u64 | next_index u32 | root_index u8 | bump u8 | pad[2] | subtrees[26][32] | root_history[100][32] | authority[32]`.
pub fn parse_tree_account(data: &[u8]) -> RelayerResult<TreeSnapshot> {
    const SUBTREES_OFFSET: usize = 16;
    const ROOTS_OFFSET: usize = SUBTREES_OFFSET + MERKLE_TREE_HEIGHT * 32;
    const MIN_LEN: usize = ROOTS_OFFSET + ROOT_HISTORY_SIZE * 32;

    if data.len() < MIN_LEN {
        return Err(RelayerError::upstream(format!(
            "merkle tree account is {} bytes, expected at least {MIN_LEN}",
            data.len()
        )));
    }

    let next_index = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
    let mut roots = Vec::with_capacity(ROOT_HISTORY_SIZE);
    for i in 0..ROOT_HISTORY_SIZE {
        let start = ROOTS_OFFSET + i * 32;
        let mut root = [0u8; 32];
        root.copy_from_slice(&data[start..start + 32]);
        // Slots the ring has not reached yet are all-zero and are not spendable roots.
        if root != [0u8; 32] {
            roots.push(root);
        }
    }

    Ok(TreeSnapshot { next_index, roots })
}

pub async fn fetch_fee_rates(rpc: &RpcClient, program_id: &Pubkey) -> RelayerResult<FeeRates> {
    let (global_config, _) = Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], program_id);
    let data = rpc
        .get_account_data(&global_config)
        .await?
        .ok_or_else(|| RelayerError::upstream("global_config PDA does not exist yet"))?;
    parse_fee_rates(&data)
}

pub async fn fetch_tree_snapshot(
    rpc: &RpcClient,
    tree_account: &Pubkey,
) -> RelayerResult<TreeSnapshot> {
    let data = rpc
        .get_account_data(tree_account)
        .await?
        .ok_or_else(|| {
            RelayerError::upstream(format!("merkle tree account {tree_account} is not initialized"))
        })?;
    parse_tree_account(&data)
}

/// A nullifier is spent exactly when its marker PDA exists. Reading the chain
/// directly avoids trusting the indexer for a check that gates spending money.
pub async fn nullifiers_spent(
    rpc: &RpcClient,
    nullifier0: &Pubkey,
    nullifier1: &Pubkey,
) -> RelayerResult<bool> {
    let accounts = rpc
        .get_multiple_account_data(&[*nullifier0, *nullifier1])
        .await?;
    Ok(accounts.into_iter().any(|a| a.is_some()))
}

/// Reporting the live leaf count alongside the rejection lets the client tell a
/// slightly-stale proof apart from one built against the wrong tree entirely.
pub fn unknown_root(root: &[u8; 32], next_index: u32) -> RelayerError {
    RelayerError::new(
        ErrorCode::UnknownRoot,
        format!(
            "merkle root {} is not in the on-chain history ring (tree is now at leaf \
             {next_index}); the tree advanced past the snapshot this proof was built against. \
             Re-sync and re-prove.",
            hex::encode(root)
        ),
    )
}
