use bytemuck::{from_bytes_mut, Pod, Zeroable};
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    constants::{ADMIN_PUBKEY, TREE_ACCOUNT_SEED},
    error::PrivacyCashError,
    helper::{verify_authority, verify_initialized, verify_pda, verify_signer},
    state::MerkleTreeAccount,
};

#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct UpdateDepositLimitSplParams {
    pub new_limit: [u8; 8],
    pub tree_account_bump: u8,
}

pub fn process_update_deposit_limit_for_spl(
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [tree_account, mint, authority] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(authority)?;
    verify_initialized(tree_account)?;

    if !tree_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    let params = bytemuck::try_pod_read_unaligned::<UpdateDepositLimitSplParams>(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let tree_account_bump = [params.tree_account_bump];

    verify_pda(
        tree_account,
        &[
            TREE_ACCOUNT_SEED,
            mint.address().as_array(),
            &tree_account_bump,
        ],
        &crate::ID,
    )?;

    let mut tree_account_data = tree_account.try_borrow_mut()?;
    let tree_account =
        from_bytes_mut::<MerkleTreeAccount>(&mut tree_account_data[..MerkleTreeAccount::LEN]);

    verify_authority(&tree_account.authority, authority)?;

    tree_account.max_deposit_amount = u64::from_le_bytes(params.new_limit);

    Ok(())
}
