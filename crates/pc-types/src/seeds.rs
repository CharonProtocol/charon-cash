//! PDA seeds.
//!
//! Off-chain services derive the same addresses the program does. Keeping one definition means
//! a seed rename is a compile error on both sides rather than a silent address mismatch.

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const TREE_ACCOUNT_SEED: &[u8] = b"merkle_tree";
pub const TREE_TOKEN_ACCOUNT_SEED: &[u8] = b"tree_token";
pub const NULLIFIER0_SEED: &[u8] = b"nullifier0";
pub const NULLIFIER1_SEED: &[u8] = b"nullifier1";

/// Merkle tree height. The circuit is compiled for exactly this depth
/// (`Transaction(26, 2, 2)`), so it is not independently tunable — changing it requires
/// recompiling the circuit and running a new trusted setup.
pub const MERKLE_TREE_HEIGHT: u8 = 26;

/// Number of historical roots retained on-chain.
///
/// Note `append` records a root per leaf and every `transact` appends two, so this is roughly
/// a *50*-transaction staleness window, not 100. A client whose root ages out gets
/// `UnknownRoot`.
pub const ROOT_HISTORY_SIZE: u8 = 100;

/// Number of leaves appended by a single `transact` / `transact_spl`.
pub const LEAVES_PER_TRANSACT: u32 = 2;
