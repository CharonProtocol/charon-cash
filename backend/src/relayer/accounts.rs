use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

pub const TREE_ACCOUNT_SEED: &[u8] = b"merkle_tree";
pub const TREE_TOKEN_ACCOUNT_SEED: &[u8] = b"tree_token";
pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const NULLIFIER0_SEED: &[u8] = b"nullifier0";
pub const NULLIFIER1_SEED: &[u8] = b"nullifier1";

pub const MERKLE_TREE_HEIGHT: usize = 26;

pub fn sol_address() -> Pubkey {
    Pubkey::from_str("11111111111111111111111111111112").expect("valid sol sentinel pubkey")
}

pub fn system_program_id() -> Pubkey {
    Pubkey::from_str("11111111111111111111111111111111").expect("valid system program")
}

pub fn token_program_id() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").expect("valid token program")
}

pub fn associated_token_program_id() -> Pubkey {
    Pubkey::from_str("ATokenGPvbdVyxrTBbPXh5vrfqDpjLCzPRKkJEpXGBbN").expect("valid ata program")
}

pub fn tree_account_sol(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], program_id)
}

pub fn tree_account_spl(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREE_ACCOUNT_SEED, mint.as_ref()], program_id)
}

pub fn tree_token_account(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREE_TOKEN_ACCOUNT_SEED], program_id)
}

pub fn global_config(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], program_id)
}

pub fn nullifier0(program_id: &Pubkey, nullifier_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[NULLIFIER0_SEED, nullifier_hash.as_ref()], program_id)
}

pub fn nullifier1(program_id: &Pubkey, nullifier_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[NULLIFIER1_SEED, nullifier_hash.as_ref()], program_id)
}

pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    let token_program = token_program_id();
    let ata_program = associated_token_program_id();
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ata_program,
    )
    .0
}
