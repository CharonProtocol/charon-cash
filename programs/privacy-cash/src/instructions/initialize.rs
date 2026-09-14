use crate::{
    constants::{
        ADMIN_PUBKEY, GLOBAL_CONFIG_ADDRESS, GLOBAL_CONFIG_SEED, TREE_ACCOUNT_ADDRESS,
        TREE_ACCOUNT_SEED, TREE_TOKEN_ACCOUNT_ADDRESS, TREE_TOKEN_ACCOUNT_SEED,
    },
    error::PrivacyCashError,
    helper::{verify_address, verify_program_id, verify_signer, verify_uninitialized},
    merkle_tree::MerkleTree,
    state::{GlobalConfig, MerkleTreeAccount, TreeTokenAccount},
};
use bytemuck::{from_bytes_mut, Pod, Zeroable};
use light_hasher::Poseidon;
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct InitiailizeParams {
    pub tree_account_bump: u8,
    pub tree_token_account_bump: u8,
    pub global_config_bump: u8,
}

pub fn process_initialize(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [tree_account, tree_token_account, global_config, authority, system_program, _remaining @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(authority)?;

    verify_uninitialized(tree_account)?;
    verify_uninitialized(tree_token_account)?;
    verify_uninitialized(global_config)?;

    verify_program_id(system_program, &pinocchio_system::ID)?;

    let params = bytemuck::try_pod_read_unaligned::<InitiailizeParams>(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if let Some(admin_key) = ADMIN_PUBKEY {
        if *authority.address().as_array() != admin_key {
            return Err(PrivacyCashError::Unauthorized.into());
        }
    }

    let tree_account_bump = [params.tree_account_bump];
    let tree_token_account_bump = [params.tree_token_account_bump];
    let global_bump = [params.global_config_bump];
    // These three are singletons at compile-time-known addresses. Checking
    // against the constants -- rather than re-deriving from whatever bumps the
    // caller supplied -- also rejects the non-canonical bumps that would
    // otherwise let a second SOL tree or global config be created alongside
    // the real one. `CreateAccount` below still needs the caller's bumps to
    // sign, and they must equal the canonical ones for that to succeed.
    {
        verify_address(tree_account, &TREE_ACCOUNT_ADDRESS)?;
        verify_address(tree_token_account, &TREE_TOKEN_ACCOUNT_ADDRESS)?;
        verify_address(global_config, &GLOBAL_CONFIG_ADDRESS)?;
    }

    let rent = Rent::get()?;

    let tree_account_seed = [
        Seed::from(TREE_ACCOUNT_SEED),
        Seed::from(&tree_account_bump),
    ];
    let tree_account_signer = Signer::from(&tree_account_seed);

    CreateAccount {
        from: authority,
        to: tree_account,
        lamports: rent.try_minimum_balance(MerkleTreeAccount::LEN)?,
        space: MerkleTreeAccount::LEN as u64,
        owner: &Address::from(crate::ID),
    }
    .invoke_signed(&[tree_account_signer])?;

    let mut tree_account_data = tree_account.try_borrow_mut()?;
    let tree_account =
        from_bytes_mut::<MerkleTreeAccount>(&mut tree_account_data[..MerkleTreeAccount::LEN]);

    tree_account.authority = *authority.address().as_array();
    tree_account.next_index = 0;
    tree_account.root_index = 0;
    tree_account.max_deposit_amount = 1_000_000_000_000;
    tree_account.bump = params.tree_account_bump;

    MerkleTree::intialize::<Poseidon>(tree_account)?;

    let tree_token_account_seed = [
        Seed::from(TREE_TOKEN_ACCOUNT_SEED),
        Seed::from(&tree_token_account_bump),
    ];
    let tree_token_account_signer = Signer::from(&tree_token_account_seed);

    CreateAccount {
        from: authority,
        to: tree_token_account,
        lamports: rent.try_minimum_balance(TreeTokenAccount::LEN)?,
        space: TreeTokenAccount::LEN as u64,
        owner: &Address::from(crate::ID),
    }
    .invoke_signed(&[tree_token_account_signer])?;

    let mut token_account_data = tree_token_account.try_borrow_mut()?;
    let token_account =
        from_bytes_mut::<TreeTokenAccount>(&mut token_account_data[..TreeTokenAccount::LEN]);

    token_account.authority = *authority.address().as_array();
    token_account.bump = params.tree_token_account_bump;

    let global_config_seed = [Seed::from(GLOBAL_CONFIG_SEED), Seed::from(&global_bump)];
    let global_config_signer = Signer::from(&global_config_seed);

    CreateAccount {
        from: authority,
        to: global_config,
        lamports: rent.try_minimum_balance(GlobalConfig::LEN)?,
        space: GlobalConfig::LEN as u64,
        owner: &Address::from(crate::ID),
    }
    .invoke_signed(&[global_config_signer])?;

    let mut global_config_data = global_config.try_borrow_mut()?;
    let global_config =
        from_bytes_mut::<GlobalConfig>(&mut global_config_data[..GlobalConfig::LEN]);

    global_config.authority = *authority.address().as_array();
    global_config.deposit_fee_rate = 0; // 0% - Free deposits
    global_config.withdrawal_fee_rate = 25; // 0.25% (25 basis points)
    global_config.fee_error_margin = 500; // 5% (500 basis points)
    global_config.bump = params.global_config_bump;

    Ok(())
}
