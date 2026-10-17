use pinocchio_pubkey::{derive_address_const, pubkey};

pub const ROOT_HISTORY_SIZE: u8 = 100;

pub const MERKLE_TREE_HEIGHT: u8 = 26;

pub const ADMIN_PUBKEY: Option<[u8; 32]> = None;

// pub const ADMIN_PUBKEY: Option<[u8; 32]> =
//     Some(pubkey!("97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf"));

pub const ALLOW_ALL_SPL_TOKENS: bool = true;

pub const ALLOWED_TOKENS: &[[u8; 32]] = &[
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
    pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), // USDT
    pubkey!("oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp"),  // ORE
    pubkey!("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"), // ZEC
    pubkey!("sTorERYB6xAZ1SSbwpK3zoK2EEwbBrc7TZAzg1uCGiH"),  // stORE (legacy)
    pubkey!("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"), // jlUSDC
    pubkey!("2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU"), // jlWSOL
    pubkey!("storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR"),  // stORE
];

pub const SOL_ADDRESS: [u8; 32] = pubkey!("11111111111111111111111111111112");

/// Jupiter v6 aggregator. Swap remaining accounts are a CPI into this program.
pub const JUPITER_PROGRAM_ID: [u8; 32] = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Native mint used when wrapping/unwrapping SOL for Jupiter.
pub const WSOL_MINT: [u8; 32] = pubkey!("So11111111111111111111111111111111111111112");

/// Domain-separated SHA-256 prefixes for the two swap Groth16 legs.
pub const SWAP_IN_DOMAIN: &[u8] = b"privacy_cash:swap_in:v1";
pub const SWAP_OUT_DOMAIN: &[u8] = b"privacy_cash:swap_out:v1";

// For the Global Config update mask
pub const UPDATE_DEPOSIT_FEE: u8 = 1 << 0;
pub const UPDATE_WITHDRAWAL_FEE: u8 = 1 << 1;
pub const UPDATE_FEE_ERROR_MARGIN: u8 = 1 << 2;
pub const VALID_MASK: u8 = UPDATE_DEPOSIT_FEE | UPDATE_WITHDRAWAL_FEE | UPDATE_FEE_ERROR_MARGIN;

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const TREE_ACCOUNT_SEED: &[u8] = b"merkle_tree";
pub const TREE_TOKEN_ACCOUNT_SEED: &[u8] = b"tree_token";
pub const NULLIFIER0_SEED: &[u8] = b"nullifier0";
pub const NULLIFIER1_SEED: &[u8] = b"nullifier1";

// The SOL merkle tree, its lamport vault, and the global config are singletons:
// their seeds are fixed strings. Their canonical addresses are known at compile
// time, so instructions compare 32 bytes instead of re-deriving from a bump
// stored in the account. A non-canonical bump is a second valid PDA, which
// would be a second SOL tree or a second global config.
//
// `tests::singleton_pdas_are_canonical` pins each bump to
// `Address::find_program_address` for this program id.

pub const TREE_ACCOUNT_BUMP: u8 = 255;
pub const TREE_TOKEN_ACCOUNT_BUMP: u8 = 253;
pub const GLOBAL_CONFIG_BUMP: u8 = 253;

pub const TREE_ACCOUNT_ADDRESS: [u8; 32] =
    derive_address_const(&[TREE_ACCOUNT_SEED], Some(TREE_ACCOUNT_BUMP), &crate::ID);

pub const TREE_TOKEN_ACCOUNT_ADDRESS: [u8; 32] = derive_address_const(
    &[TREE_TOKEN_ACCOUNT_SEED],
    Some(TREE_TOKEN_ACCOUNT_BUMP),
    &crate::ID,
);

pub const GLOBAL_CONFIG_ADDRESS: [u8; 32] =
    derive_address_const(&[GLOBAL_CONFIG_SEED], Some(GLOBAL_CONFIG_BUMP), &crate::ID);

#[cfg(test)]
mod tests {
    use super::*;
    use solana_address::Address;

    /// The singleton addresses above are compiled in with a hardcoded bump.
    /// If any of them is not the canonical (highest) bump, the program would
    /// reject the accounts a standard client derives.
    #[test]
    fn singleton_pdas_are_canonical() {
        let program_id = Address::from(crate::ID);

        for (name, seed, address, bump) in [
            (
                "merkle_tree",
                TREE_ACCOUNT_SEED,
                TREE_ACCOUNT_ADDRESS,
                TREE_ACCOUNT_BUMP,
            ),
            (
                "tree_token",
                TREE_TOKEN_ACCOUNT_SEED,
                TREE_TOKEN_ACCOUNT_ADDRESS,
                TREE_TOKEN_ACCOUNT_BUMP,
            ),
            (
                "global_config",
                GLOBAL_CONFIG_SEED,
                GLOBAL_CONFIG_ADDRESS,
                GLOBAL_CONFIG_BUMP,
            ),
        ] {
            let (expected_address, expected_bump) =
                Address::find_program_address(&[seed], &program_id);

            assert_eq!(expected_bump, bump, "{name} bump");
            assert_eq!(expected_address.to_bytes(), address, "{name} address");
        }
    }
}
