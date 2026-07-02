use crate::{
    constants::{ADMIN_PUBKEY, MERKLE_TREE_HEIGHT},
    error::PrivacyCashError,
    helper::{verify_program_id, verify_signer, verify_uninitialized},
    merkle_tree::MerkleTree,
    states::{GlobalConfig, MerkleTreeAccount, TreeTokenAccount},
};
use bytemuck::{from_bytes_mut, Pod, Zeroable};
use light_hasher::Poseidon;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct IntiailizeParams {
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

    let params = bytemuck::try_pod_read_unaligned::<IntiailizeParams>(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if let Some(admin_key) = ADMIN_PUBKEY {
        if *authority.address().as_array() != admin_key {
            return Err(PrivacyCashError::Unauthorized.into());
        }
    }

    let mut tree_account_data = tree_account.try_borrow_mut()?;
    let tree_account =
        from_bytes_mut::<MerkleTreeAccount>(&mut tree_account_data[..MerkleTreeAccount::LEN]);

    tree_account.authority = *authority.address().as_array();
    tree_account.next_index = 0;
    tree_account.root_index = 0;
    tree_account.max_deposit_amount = 1_000_000_000_000;
    tree_account.height = MERKLE_TREE_HEIGHT;
    tree_account.bump = params.tree_account_bump;
    tree_account.root_history_size = 100;

    MerkleTree::intialize::<Poseidon>(tree_account)?;

    let mut token_account_data = tree_token_account.try_borrow_mut()?;
    let token_account =
        from_bytes_mut::<TreeTokenAccount>(&mut token_account_data[..TreeTokenAccount::LEN]);

    token_account.authority = *authority.address().as_array();
    token_account.bump = params.tree_token_account_bump;

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
