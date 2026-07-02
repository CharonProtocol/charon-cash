use crate::{
    constants::{ADMIN_PUBKEY, ALLOWED_TOKENS, ALLOW_ALL_SPL_TOKENS, MERKLE_TREE_HEIGHT},
    error::PrivacyCashError,
    helper::{verify_initialized, verify_program_id, verify_signer, verify_uninitialized},
    merkle_tree::MerkleTree,
    states::MerkleTreeAccount,
};
use bytemuck::{from_bytes_mut, Pod, Zeroable};
use light_hasher::Poseidon;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct IntiailizeTreeTokenAccountParams {
    pub max_deposit_amount: u64,
    pub tree_account_bump: u8,
    pub padding: [u8; 7],
}

pub fn process_initialize_tree_account_for_spl_token(
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [tree_account, mint, global_config, authority, system_program, _remaining @ ..] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(authority)?;

    verify_uninitialized(tree_account)?;
    verify_initialized(global_config)?;

    verify_program_id(system_program, &pinocchio_system::ID)?;

    let params = bytemuck::try_pod_read_unaligned::<IntiailizeTreeTokenAccountParams>(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if let Some(admin_key) = ADMIN_PUBKEY {
        if *authority.address().as_array() != admin_key {
            return Err(PrivacyCashError::Unauthorized.into());
        }
    }

    if ALLOW_ALL_SPL_TOKENS || !ALLOWED_TOKENS.contains(mint.address().as_array()) {
        return Err(PrivacyCashError::InvalidMintAddress.into());
    }

    let mut tree_account_data = tree_account.try_borrow_mut()?;
    let tree_account =
        from_bytes_mut::<MerkleTreeAccount>(&mut tree_account_data[..MerkleTreeAccount::LEN]);

    tree_account.authority = *authority.address().as_array();
    tree_account.next_index = 0;
    tree_account.root_index = 0;
    tree_account.max_deposit_amount = params.max_deposit_amount;
    tree_account.height = MERKLE_TREE_HEIGHT;
    tree_account.bump = params.tree_account_bump;
    tree_account.root_history_size = 100;

    MerkleTree::intialize::<Poseidon>(tree_account)?;

    Ok(())
}
