use crate::{
    constants::{
        ADMIN_PUBKEY, ALLOWED_TOKENS, ALLOW_ALL_SPL_TOKENS, MERKLE_TREE_HEIGHT, TREE_ACCOUNT_SEED,
    },
    error::PrivacyCashError,
    helper::{
        verify_initialized, verify_pda, verify_program_id, verify_signer, verify_uninitialized,
    },
    merkle_tree::MerkleTree,
    state::MerkleTreeAccount,
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
    if !ALLOW_ALL_SPL_TOKENS && !ALLOWED_TOKENS.contains(mint.address().as_array()) {
        return Err(PrivacyCashError::InvalidMintAddress.into());
    }

    let tree_account_bump = [params.tree_account_bump];
    {
        verify_pda(
            tree_account,
            &[
                TREE_ACCOUNT_SEED,
                mint.address().as_ref(),
                &tree_account_bump,
            ],
            &crate::ID,
        )?;
    }

    let tree_account_seed = [
        Seed::from(TREE_ACCOUNT_SEED),
        Seed::from(mint.address().as_ref()),
        Seed::from(&tree_account_bump),
    ];
    let tree_account_signer = Signer::from(&tree_account_seed);

    CreateAccount {
        from: authority,
        to: tree_account,
        lamports: Rent::get()?.try_minimum_balance(MerkleTreeAccount::LEN)?,
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
    tree_account.max_deposit_amount = params.max_deposit_amount;
    tree_account.height = MERKLE_TREE_HEIGHT;
    tree_account.bump = params.tree_account_bump;
    tree_account.root_history_size = 100;

    MerkleTree::intialize::<Poseidon>(tree_account)?;

    Ok(())
}
