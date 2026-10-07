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
];

pub const SOL_ADDRESS: [u8; 32] = pubkey!("11111111111111111111111111111112");

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

// Three PDAs of this program are singletons: their seeds are fixed strings
// with no runtime component, so their canonical addresses are known at compile
// time. Comparing 32 bytes against these replaces a `sol_sha256` derivation on
// every instruction that touches them.
//
// Only the canonical bump is accepted. A non-canonical bump derives a
// different, equally valid PDA, which would be a second SOL tree or a second
// global config -- state this program has no way to reconcile.
//
// `tests::singleton_pdas_are_canonical` pins each bump to
// `Pubkey::find_program_address`.

pub const TREE_ACCOUNT_BUMP: u8 = 255;
pub const TREE_TOKEN_ACCOUNT_BUMP: u8 = 255;
pub const GLOBAL_CONFIG_BUMP: u8 = 255;

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
