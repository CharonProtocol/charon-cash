use crate::{
    constants::{
        ALLOWED_TOKENS, ALLOW_ALL_SPL_TOKENS, GLOBAL_CONFIG_ADDRESS, GLOBAL_CONFIG_BUMP,
        GLOBAL_CONFIG_SEED, NULLIFIER_SEED, TREE_ACCOUNT_SEED,
    },
    error::PrivacyCashError,
    helper::{
        emit_transact_event, init_nullifier_account, verify_address,
        verify_initialized, verify_pda, verify_program_id, verify_signer,
    },
    merkle_tree::MerkleTree,
    state::{GlobalConfig, MerkleTreeAccount, RawProof, TransactArgs},
    utils::{
        calculate_complete_ext_data_hash, check_public_amount, ext_data_hash_matches, validate_fee,
        GrothProof, VERIFYING_KEY,
    },
};
use bytemuck::try_from_bytes;
use light_hasher::Poseidon;
use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_associated_token_account::instructions::CreateIdempotent;
use pinocchio_token::{instructions::Transfer as TokenTransfer, state::TokenAccount};

/// Users deposit or withdraw SPL tokens from the program.
///
/// Reentrant attacks are not possible, because nullifier creation is checked
/// (via `init`) before any transfer occurs.
/// Instruction 3: raw (uncompressed) proof, no on-chain decompression, 13
/// accounts (no unused recipient wallet, no cross-check nullifiers), so a worst-case transfer fits a v0
/// transaction.
#[inline(never)]
pub fn process_transact_spl(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [tree_account, nullifier0, nullifier1, global_config, signer, mint, signer_token_account, recipient_token_account, tree_ata, fee_recipient_ata, token_program, associated_token_program, system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    transact_spl::<RawProof>(
        [
            tree_account, nullifier0, nullifier1, global_config, signer,
            mint, signer_token_account, recipient_token_account, tree_ata, fee_recipient_ata,
            token_program, associated_token_program, system_program,
        ],
        data,
    )
}

#[inline(always)]
fn transact_spl<P: GrothProof>(accounts: [&AccountView; 13], data: &[u8]) -> ProgramResult {
    let [tree_account, nullifier0, nullifier1, global_config, signer, mint, signer_token_account, recipient_token_account, tree_ata, fee_recipient_ata, token_program, associated_token_program, system_program] =
        accounts;

    verify_signer(signer)?;
    verify_program_id(system_program, &pinocchio_system::ID)?;
    verify_program_id(token_program, &pinocchio_token::ID)?;
    verify_program_id(
        associated_token_program,
        &pinocchio_associated_token_account::ID,
    )?;

    let args = TransactArgs::<P>::try_from_bytes(data)?;
    let proof = *args.proof;
    let ext_data_minified = args.ext_data_minified;
    let encrypted_output1 = args.encrypted_output1;
    let encrypted_output2 = args.encrypted_output2;
    let nullifier_bump0 = args.nullifier_bump0;
    let nullifier_bump1 = args.nullifier_bump1;

    verify_initialized(tree_account)?;
    verify_initialized(global_config)?;

    // Validate signer's token account ownership and mint.
    {
        let signer_token = TokenAccount::from_account_view(signer_token_account)?;
        if signer_token.owner() != signer.address() {
            return Err(PrivacyCashError::InvalidTokenAccount.into());
        }
        if signer_token.mint() != mint.address() {
            return Err(PrivacyCashError::InvalidTokenAccountMintAddress.into());
        }
    }

    // Bind `tree_ata` to `mint`. On a first-ever deposit `tree_ata` doesn't
    // exist yet and is validated instead by `CreateIdempotent` below; on
    // every other path (withdrawal, fee payment, or a repeat deposit) it
    // already exists and must belong to this tree's mint, or `global_config`
    // -- the shared SPL-vault authority for every mint's tree -- could be
    // used to sign a transfer out of a completely different mint's vault.
    if !tree_ata.is_data_empty() {
        let tree_ata_account = TokenAccount::from_account_view(tree_ata)?;
        if tree_ata_account.mint() != mint.address() {
            return Err(PrivacyCashError::InvalidMintAddress.into());
        }
    }

    verify_address(global_config, &GLOBAL_CONFIG_ADDRESS)?;

    let global = {
        let global_data = global_config.try_borrow()?;
        let global = try_from_bytes::<GlobalConfig>(&global_data[..GlobalConfig::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        *global
    };


    let mint_address = *mint.address().as_array();
    let recipient_key = *recipient_token_account.address().as_array();
    let fee_recipient_key = *fee_recipient_ata.address().as_array();
    let ext_amount = ext_data_minified.ext_amount;
    let fee = ext_data_minified.fee;

    let max_deposit_amount = {
        let tree_data = tree_account.try_borrow()?;
        let tree = try_from_bytes::<MerkleTreeAccount>(&tree_data[..MerkleTreeAccount::LEN])
            .map_err(|_| PrivacyCashError::InvalidMerkleTreeAccount)?;

        if !ALLOW_ALL_SPL_TOKENS && !ALLOWED_TOKENS.contains(&mint_address) {
            return Err(PrivacyCashError::InvalidMintAddress.into());
        }

        verify_pda(
            tree_account,
            &[TREE_ACCOUNT_SEED, &mint_address, &[tree.bump]],
            &crate::ID,
        )?;

        if !MerkleTree::is_known_root(tree, proof.root()) {
            return Err(PrivacyCashError::UnknownRoot.into());
        }
        tree.max_deposit_amount
    };

    let calculated_ext_data_hash = calculate_complete_ext_data_hash(
        &recipient_key,
        ext_amount,
        encrypted_output1,
        encrypted_output2,
        fee,
        &fee_recipient_key,
        &mint_address,
    )?;

    if !ext_data_hash_matches(calculated_ext_data_hash, proof.ext_data_hash()) {
        return Err(PrivacyCashError::ExtDataHashMismatch.into());
    }

    if !check_public_amount(ext_amount, fee, proof.public_amount()) {
        return Err(PrivacyCashError::InvalidPublicAmountData.into());
    }

    validate_fee(
        ext_amount,
        fee,
        global.deposit_fee_rate,
        global.withdrawal_fee_rate,
        global.fee_error_margin,
    )?;

    if !proof.verify(&VERIFYING_KEY) {
        return Err(PrivacyCashError::InvalidProof.into());
    }

    let rent = Rent::get()?;
    init_nullifier_account(
        signer,
        nullifier0,
        NULLIFIER_SEED,
        &proof.input_nullifiers()[0],
        nullifier_bump0,
        &rent,
    )?;
    init_nullifier_account(
        signer,
        nullifier1,
        NULLIFIER_SEED,
        &proof.input_nullifiers()[1],
        nullifier_bump1,
        &rent,
    )?;

    // PDA signer seeds for the tree's ATA (authority == global_config PDA).
    // The bump is the constant, not `global.bump`: `verify_address` above
    // already pinned this account to the canonical address, so the two agree
    // and the constant cannot be influenced by account data.
    let global_bump = [GLOBAL_CONFIG_BUMP];
    let global_seeds = [Seed::from(GLOBAL_CONFIG_SEED), Seed::from(&global_bump)];

    if ext_amount > 0 {
        let deposit_amount = ext_amount as u64;

        if deposit_amount > max_deposit_amount {
            return Err(PrivacyCashError::DepositLimitExceeded.into());
        }

        // Ensure the tree's ATA exists (mirrors anchor's `init_if_needed`).
        CreateIdempotent {
            funding_account: signer,
            account: tree_ata,
            wallet: global_config,
            mint,
            system_program,
            token_program,
        }
        .invoke()?;

        // Deposit: signer's token account -> tree's ATA, signed by the signer.
        TokenTransfer {
            from: signer_token_account,
            to: tree_ata,
            authority: signer,
            amount: deposit_amount,
        }
        .invoke()?;
    } else if ext_amount < 0 {
        let abs_amount = ext_amount
            .checked_neg()
            .ok_or(ProgramError::ArithmeticOverflow)? as u64;

        // Withdrawal: tree's ATA -> recipient's token account, signed by global_config PDA.
        TokenTransfer {
            from: tree_ata,
            to: recipient_token_account,
            authority: global_config,
            amount: abs_amount,
        }
        .invoke_signed(&[Signer::from(&global_seeds)])?;
    }

    if fee > 0 {
        // Fee payment: tree's ATA -> fee recipient's ATA, signed by global_config PDA.
        TokenTransfer {
            from: tree_ata,
            to: fee_recipient_ata,
            authority: global_config,
            amount: fee,
        }
        .invoke_signed(&[Signer::from(&global_seeds)])?;
    }

    let first_leaf_index = {
        let mut tree_data = tree_account.try_borrow_mut()?;
        let tree = bytemuck::try_from_bytes_mut::<MerkleTreeAccount>(
            &mut tree_data[..MerkleTreeAccount::LEN],
        )
        .map_err(|_| PrivacyCashError::InvalidMerkleTreeAccount)?;
        let first_leaf_index = tree.next_index;
        MerkleTree::append_pair::<Poseidon>(proof.output_commitments(), tree)?;
        first_leaf_index
    };

    emit_transact_event(
        first_leaf_index,
        Some(&mint_address),
        proof.output_commitments(),
        proof.input_nullifiers(),
        encrypted_output1,
        encrypted_output2,
    );

    Ok(())
}
