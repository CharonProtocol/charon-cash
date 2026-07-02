use pinocchio_pubkey::pubkey;

pub const ROOT_HISTORY_SIZE: u8 = 100;

pub const MERKLE_TREE_HEIGHT: u8 = 26;

// pub const ADMIN_PUBKEY: Option<Address> = None;

pub const ADMIN_PUBKEY: Option<[u8; 32]> =
    Some(pubkey!("97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf"));

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
