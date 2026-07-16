use crate::{
    constants::{
        GLOBAL_CONFIG_SEED, NULLIFIER0_SEED, NULLIFIER1_SEED, SOL_ADDRESS, TREE_ACCOUNT_SEED,
        TREE_TOKEN_ACCOUNT_SEED,
    },
    error::PrivacyCashError,
    event::emit_commitment_event,
    helper::{
        init_nullifier_account, verify_cross_nullifier, verify_initialized, verify_pda,
        verify_program_id, verify_signer,
    },
    merkle_tree::MerkleTree,
    state::{GlobalConfig, MerkleTreeAccount, TransactArgs, TreeTokenAccount},
    utils::{
        calculate_complete_ext_data_hash, check_public_amount, ext_data_hash_matches, validate_fee,
        verify_proof, VERIFYING_KEY,
    },
};
use bytemuck::try_from_bytes;
use light_hasher::Poseidon;
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

pub fn process_transact(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [tree_account, nullifier0, nullifier1, nullifier2, nullifier3, tree_token_account, global_config, recipient, fee_recipient_account, signer, system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(signer)?;
    verify_program_id(system_program, &pinocchio_system::ID)?;

    let args = TransactArgs::try_from_bytes(data)?;
    let proof = *args.proof;
    let ext_data_minified = args.ext_data_minified;
    let encrypted_output1 = args.encrypted_output1;
    let encrypted_output2 = args.encrypted_output2;
    let nullifier_bump0 = args.nullifier_bump0;
    let nullifier_bump1 = args.nullifier_bump1;
    verify_initialized(tree_account)?;
    verify_initialized(tree_token_account)?;
    verify_initialized(global_config)?;

    {
        let token_data = tree_token_account.try_borrow()?;
        let token = try_from_bytes::<TreeTokenAccount>(&token_data[..TreeTokenAccount::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        verify_pda(
            tree_token_account,
            &[TREE_TOKEN_ACCOUNT_SEED, &[token.bump]],
            &crate::ID,
        )?;
    }

    let global = {
        let global_data = global_config.try_borrow()?;
        let global = try_from_bytes::<GlobalConfig>(&global_data[..GlobalConfig::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        verify_pda(
            global_config,
            &[GLOBAL_CONFIG_SEED, &[global.bump]],
            &crate::ID,
        )?;
        *global
    };

    verify_cross_nullifier(nullifier2)?;
    verify_cross_nullifier(nullifier3)?;

    init_nullifier_account(
        signer,
        nullifier0,
        NULLIFIER0_SEED,
        &proof.input_nullifiers[0],
        nullifier_bump0,
    )?;
    init_nullifier_account(
        signer,
        nullifier1,
        NULLIFIER1_SEED,
        &proof.input_nullifiers[1],
        nullifier_bump1,
    )?;

    let recipient_key = *recipient.address().as_array();
    let fee_recipient_key = *fee_recipient_account.address().as_array();
    let ext_amount = ext_data_minified.ext_amount;
    let fee = ext_data_minified.fee;

    let mut tree_data = tree_account.try_borrow_mut()?;
    let tree =
        bytemuck::try_from_bytes_mut::<MerkleTreeAccount>(&mut tree_data[..MerkleTreeAccount::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;

    verify_pda(tree_account, &[TREE_ACCOUNT_SEED, &[tree.bump]], &crate::ID)?;

    if !MerkleTree::is_known_root(tree, proof.root) {
        return Err(PrivacyCashError::UnknownRoot.into());
    }

    let calculated_ext_data_hash = calculate_complete_ext_data_hash(
        recipient_key,
        ext_amount,
        encrypted_output1,
        encrypted_output2,
        fee,
        fee_recipient_key,
        SOL_ADDRESS,
    )?;

    if !ext_data_hash_matches(calculated_ext_data_hash, proof.ext_data_hash) {
        return Err(PrivacyCashError::ExtDataHashMismatch.into());
    }

    if !check_public_amount(ext_amount, fee, proof.public_amount) {
        return Err(PrivacyCashError::InvalidPublicAmountData.into());
    }

    validate_fee(
        ext_amount,
        fee,
        global.deposit_fee_rate,
        global.withdrawal_fee_rate,
        global.fee_error_margin,
    )?;

    if !verify_proof(&proof, &VERIFYING_KEY) {
        return Err(PrivacyCashError::InvalidProof.into());
    }

    // A fee may only be paid to the configured recipient. Without this a withdrawer could name
    // themselves and reclaim the fee, making the protocol's cut zero. Only matters when a fee is
    // actually moved; fee-free deposits leave the recipient untouched.
    if fee > 0 && fee_recipient_key != global.fee_recipient {
        return Err(PrivacyCashError::InvalidFeeRecipient.into());
    }

    let rent = Rent::get()?;
    let rent_exempt_minimum = rent.try_minimum_balance(tree_token_account.data_len())?;

    if ext_amount > 0 {
        let deposit_amount = ext_amount as u64;

        if deposit_amount > tree.max_deposit_amount {
            return Err(PrivacyCashError::DepositLimitExceeded.into());
        }

        Transfer {
            from: signer,
            to: tree_token_account,
            lamports: deposit_amount,
        }
        .invoke()?;
    } else if ext_amount < 0 {
        let abs_amount = ext_amount
            .checked_neg()
            .ok_or(ProgramError::ArithmeticOverflow)? as u64;

        let total_needed = abs_amount
            .checked_add(fee)
            .and_then(|x| x.checked_add(rent_exempt_minimum))
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if tree_token_account.lamports() < total_needed {
            return Err(PrivacyCashError::InsufficientFundsForWithdrawal.into());
        }

        let new_tree_balance = tree_token_account
            .lamports()
            .checked_sub(abs_amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let new_recipient_balance = recipient
            .lamports()
            .checked_add(abs_amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        tree_token_account.set_lamports(new_tree_balance);
        recipient.set_lamports(new_recipient_balance);
    }

    if fee > 0 {
        if ext_amount >= 0 {
            let needed = fee
                .checked_add(rent_exempt_minimum)
                .ok_or(ProgramError::ArithmeticOverflow)?;

            if tree_token_account.lamports() < needed {
                return Err(PrivacyCashError::InsufficientFundsForFee.into());
            }
        }

        let new_tree_balance = tree_token_account
            .lamports()
            .checked_sub(fee)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let new_fee_recipient_balance = fee_recipient_account
            .lamports()
            .checked_add(fee)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        tree_token_account.set_lamports(new_tree_balance);
        fee_recipient_account.set_lamports(new_fee_recipient_balance);
    }

    // Sampled before the appends: this is the leaf index of output_commitments[0].
    // output_commitments[1] lands at leaf_index + 1.
    let leaf_index = tree.next_index;

    MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree)?;
    MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree)?;

    // The leaves are gone from account state the moment they are absorbed into the tree, so
    // this event is the only record an indexer can rebuild Merkle paths from.
    emit_commitment_event(leaf_index, tree.current_root());

    Ok(())
}
