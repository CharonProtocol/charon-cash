//! Program id and PDA derivations, mirroring the on-chain seeds in [`pc_types::seeds`].

use pc_types::seeds::{
    GLOBAL_CONFIG_SEED, NULLIFIER0_SEED, NULLIFIER1_SEED, TREE_ACCOUNT_SEED, TREE_TOKEN_ACCOUNT_SEED,
};
use solana_pubkey::Pubkey;

/// The program id (`declare_id!` in the program's `lib.rs`).
pub const PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV");

pub fn tree_account_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], &PROGRAM_ID)
}

pub fn tree_token_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREE_TOKEN_ACCOUNT_SEED], &PROGRAM_ID)
}

pub fn global_config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], &PROGRAM_ID)
}

/// The four nullifier PDAs a transact touches: the two "own-slot" accounts that get initialized
/// (returned with their bumps), and the two "cross-slot" accounts that guard against reuse in the
/// opposite slot. See the program's `Transact` accounts.
pub struct NullifierPdas {
    pub nullifier0: Pubkey,
    pub bump0: u8,
    pub nullifier1: Pubkey,
    pub bump1: u8,
    pub nullifier2: Pubkey, // PDA(["nullifier0", n1])
    pub nullifier3: Pubkey, // PDA(["nullifier1", n0])
}

pub fn nullifier_pdas(n0: &[u8; 32], n1: &[u8; 32]) -> NullifierPdas {
    let (nullifier0, bump0) = Pubkey::find_program_address(&[NULLIFIER0_SEED, n0], &PROGRAM_ID);
    let (nullifier1, bump1) = Pubkey::find_program_address(&[NULLIFIER1_SEED, n1], &PROGRAM_ID);
    let (nullifier2, _) = Pubkey::find_program_address(&[NULLIFIER0_SEED, n1], &PROGRAM_ID);
    let (nullifier3, _) = Pubkey::find_program_address(&[NULLIFIER1_SEED, n0], &PROGRAM_ID);
    NullifierPdas {
        nullifier0,
        bump0,
        nullifier1,
        bump1,
        nullifier2,
        nullifier3,
    }
}
