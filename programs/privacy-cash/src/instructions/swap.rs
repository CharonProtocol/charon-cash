use crate::{
    constants::{
        ALLOWED_TOKENS, ALLOW_ALL_SPL_TOKENS, GLOBAL_CONFIG_ADDRESS, GLOBAL_CONFIG_BUMP,
        GLOBAL_CONFIG_SEED, JUPITER_PROGRAM_ID, NULLIFIER_SEED, SOL_ADDRESS,
        TREE_ACCOUNT_ADDRESS, TREE_ACCOUNT_SEED, TREE_TOKEN_ACCOUNT_ADDRESS, WSOL_MINT,
    },
    error::PrivacyCashError,
    helper::{
        emit_transact_event, init_nullifier_account, verify_address,
        verify_initialized, verify_pda, verify_program_id, verify_signer,
    },
    merkle_tree::MerkleTree,
    state::{MerkleTreeAccount, SwapArgs},
    utils::{
        calculate_swap_in_ext_data_hash, calculate_swap_out_ext_data_hash, check_public_amount,
        ext_data_hash_matches, verify_proof, VERIFYING_KEY,
    },
};
use light_hasher::Poseidon;
use pinocchio::{
    cpi::{invoke_signed_with_slice, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_associated_token_account::instructions::CreateIdempotent;
use pinocchio_log::log;
use pinocchio_token::{
    instructions::{CloseAccount, SyncNative},
    state::TokenAccount,
};

/// Fixed accounts before Jupiter remaining accounts.
/// 4 nullifiers (in 0/1, out 0/1) plus vault/trees/mints/signer/programs.
const FIXED_ACCOUNTS: usize = 17;

enum SwapDir {
    SolToSpl,
    SplToSol,
}

/// Atomic shielded swap: two Groth16 joinsplits + Jupiter ExactIn CPI.
///
/// Account layout (17 fixed, then Jupiter remaining):
/// 0 in_tree,
/// 1–2 in-leg nullifiers (0/1),
/// 3–4 out-leg nullifiers (0/1),
/// 5 sol_vault, 6 out_tree, 7 global_config,
/// 8 wsol_mint, 9 pool_wsol, 10 spl_mint, 11 pool_spl,
/// 12 signer, 13 jupiter, 14 token_program, 15 ata_program, 16 system_program.
///
/// Direction is inferred from `in_tree`: the SOL tree is the singleton at
/// `TREE_ACCOUNT_ADDRESS`; an SPL tree is `[merkle_tree, mint, bump]`.
#[inline(never)]
pub fn process_swap(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < FIXED_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (fixed, _) = accounts.split_at(FIXED_ACCOUNTS);
    let [in_tree_account, in_nullifier0, in_nullifier1, out_nullifier0, out_nullifier1, sol_vault, out_tree_account, global_config, wsol_mint, pool_wsol_account, spl_mint, pool_spl_account, signer, jupiter_program, token_program, associated_token_program, system_program] =
        fixed
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(signer)?;
    verify_program_id(system_program, &pinocchio_system::ID)?;
    verify_program_id(token_program, &pinocchio_token::ID)?;
    verify_program_id(
        associated_token_program,
        &pinocchio_associated_token_account::ID,
    )?;
    verify_program_id(jupiter_program, &Address::from(JUPITER_PROGRAM_ID))?;

    verify_initialized(in_tree_account)?;
    verify_initialized(out_tree_account)?;
    verify_initialized(sol_vault)?;
    verify_initialized(global_config)?;

    let args = SwapArgs::try_from_bytes(data)?;
    let proof_in = *args.proof_in;
    let proof_out = *args.proof_out;
    let jupiter_data = args.jupiter_data;
    let jupiter_indices = args.jupiter_account_indices;
    let ext_amount_in = args.ext_amount_in;
    let ext_amount_out = args.ext_amount_out;

    if ext_amount_in >= 0 || ext_amount_out <= 0 {
        return Err(PrivacyCashError::InvalidSwapAmount.into());
    }
    let amount_in = ext_amount_in
        .checked_neg()
        .ok_or(ProgramError::ArithmeticOverflow)? as u64;
    let min_amount_out = ext_amount_out as u64;

    if wsol_mint.address().as_array() != &WSOL_MINT {
        return Err(PrivacyCashError::InvalidMintAddress.into());
    }
    let spl_mint_address = *spl_mint.address().as_array();
    if spl_mint_address == WSOL_MINT || spl_mint_address == SOL_ADDRESS {
        return Err(PrivacyCashError::InvalidSwapMintPair.into());
    }
    if !ALLOW_ALL_SPL_TOKENS && !ALLOWED_TOKENS.contains(&spl_mint_address) {
        return Err(PrivacyCashError::InvalidMintAddress.into());
    }

    verify_address(sol_vault, &TREE_TOKEN_ACCOUNT_ADDRESS)?;
    verify_address(global_config, &GLOBAL_CONFIG_ADDRESS)?;

    let dir = if in_tree_account.address().as_array() == &TREE_ACCOUNT_ADDRESS {
        SwapDir::SolToSpl
    } else {
        SwapDir::SplToSol
    };

    let (in_mint, out_mint): ([u8; 32], [u8; 32]) = match dir {
        SwapDir::SolToSpl => (SOL_ADDRESS, spl_mint_address),
        SwapDir::SplToSol => (spl_mint_address, SOL_ADDRESS),
    };

    {
        let mut tree_data = in_tree_account.try_borrow_mut()?;
        let tree = bytemuck::try_from_bytes_mut::<MerkleTreeAccount>(
            &mut tree_data[..MerkleTreeAccount::LEN],
        )
        .map_err(|_| PrivacyCashError::InvalidMerkleTreeAccount)?;

        match dir {
            SwapDir::SolToSpl => verify_address(in_tree_account, &TREE_ACCOUNT_ADDRESS)?,
            SwapDir::SplToSol => verify_pda(
                in_tree_account,
                &[TREE_ACCOUNT_SEED, &spl_mint_address, &[tree.bump]],
                &crate::ID,
            )?,
        }

        if !MerkleTree::is_known_root(tree, proof_in.root) {
            return Err(PrivacyCashError::UnknownRoot.into());
        }
    }

    let expected_in_hash = calculate_swap_in_ext_data_hash(
        ext_amount_in,
        args.encrypted_output_in1,
        args.encrypted_output_in2,
        &in_mint,
        &out_mint,
        ext_amount_out,
        &proof_out.output_commitments,
    )?;
    if !ext_data_hash_matches(expected_in_hash, proof_in.ext_data_hash) {
        return Err(PrivacyCashError::ExtDataHashMismatch.into());
    }
    if !check_public_amount(ext_amount_in, 0, proof_in.public_amount) {
        return Err(PrivacyCashError::InvalidPublicAmountData.into());
    }

    {
        let mut tree_data = out_tree_account.try_borrow_mut()?;
        let tree = bytemuck::try_from_bytes_mut::<MerkleTreeAccount>(
            &mut tree_data[..MerkleTreeAccount::LEN],
        )
        .map_err(|_| PrivacyCashError::InvalidMerkleTreeAccount)?;

        match dir {
            SwapDir::SolToSpl => verify_pda(
                out_tree_account,
                &[TREE_ACCOUNT_SEED, &spl_mint_address, &[tree.bump]],
                &crate::ID,
            )?,
            SwapDir::SplToSol => verify_address(out_tree_account, &TREE_ACCOUNT_ADDRESS)?,
        }

        if !MerkleTree::is_known_root(tree, proof_out.root) {
            return Err(PrivacyCashError::UnknownRoot.into());
        }
        if min_amount_out > tree.max_deposit_amount {
            return Err(PrivacyCashError::DepositLimitExceeded.into());
        }
    }

    let expected_out_hash = calculate_swap_out_ext_data_hash(
        ext_amount_out,
        args.encrypted_output_out1,
        args.encrypted_output_out2,
        &out_mint,
    )?;
    if !ext_data_hash_matches(expected_out_hash, proof_out.ext_data_hash) {
        return Err(PrivacyCashError::ExtDataHashMismatch.into());
    }
    if !check_public_amount(ext_amount_out, 0, proof_out.public_amount) {
        return Err(PrivacyCashError::InvalidPublicAmountData.into());
    }

    // Cheap checks first; pairings next; nullifiers before any CPI so a failed
    // Jupiter route reverts and leaves the notes unspent.
    if !verify_proof(&proof_in, &VERIFYING_KEY) {
        return Err(PrivacyCashError::InvalidProof.into());
    }
    if !verify_proof(&proof_out, &VERIFYING_KEY) {
        return Err(PrivacyCashError::InvalidProof.into());
    }

    let rent = Rent::get()?;
    init_nullifier_account(
        signer,
        in_nullifier0,
        NULLIFIER_SEED,
        &proof_in.input_nullifiers[0],
        args.nullifier_bump_in0,
        &rent,
    )?;
    init_nullifier_account(
        signer,
        in_nullifier1,
        NULLIFIER_SEED,
        &proof_in.input_nullifiers[1],
        args.nullifier_bump_in1,
        &rent,
    )?;
    init_nullifier_account(
        signer,
        out_nullifier0,
        NULLIFIER_SEED,
        &proof_out.input_nullifiers[0],
        args.nullifier_bump_out0,
        &rent,
    )?;
    init_nullifier_account(
        signer,
        out_nullifier1,
        NULLIFIER_SEED,
        &proof_out.input_nullifiers[1],
        args.nullifier_bump_out1,
        &rent,
    )?;

    CreateIdempotent {
        funding_account: signer,
        account: pool_wsol_account,
        wallet: global_config,
        mint: wsol_mint,
        system_program,
        token_program,
    }
    .invoke()?;
    CreateIdempotent {
        funding_account: signer,
        account: pool_spl_account,
        wallet: global_config,
        mint: spl_mint,
        system_program,
        token_program,
    }
    .invoke()?;
    log!("swap atas ready");

    verify_pool_token_account(pool_wsol_account, global_config, wsol_mint)?;
    verify_pool_token_account(pool_spl_account, global_config, spl_mint)?;
    log!("swap pool atas ok");

    let global_bump_seed = [GLOBAL_CONFIG_BUMP];
    let global_seeds = [
        Seed::from(GLOBAL_CONFIG_SEED),
        Seed::from(&global_bump_seed),
    ];

    match dir {
        SwapDir::SolToSpl => {
            // WrapSol already committed extra lamports onto this ATA. SyncNative
            // here (next instruction) can see them; doing it inside WrapSol
            // after set_lamports is UnbalancedInstruction.
            SyncNative {
                native_token: pool_wsol_account,
            }
            .invoke()?;
            let wsol_before = token_amount(pool_wsol_account)?;
            if wsol_before < amount_in {
                return Err(PrivacyCashError::InsufficientFundsForWithdrawal.into());
            }
            let out_before = token_amount(pool_spl_account)?;
            log!("swap prewrapped");

            invoke_route(
                accounts,
                jupiter_program,
                global_config,
                pool_wsol_account,
                pool_spl_account,
                jupiter_indices,
                jupiter_data,
                &global_seeds,
            )?;

            // Exactly amount_in may leave the pool's wSOL: the route spends
            // what this swap's proof released, never other users' funds.
            let wsol_spent = wsol_before
                .checked_sub(token_amount(pool_wsol_account)?)
                .ok_or(PrivacyCashError::SwapInputNotConsumed)?;
            if wsol_spent != amount_in {
                return Err(PrivacyCashError::SwapInputNotConsumed.into());
            }
            let received = token_amount(pool_spl_account)?
                .checked_sub(out_before)
                .ok_or(PrivacyCashError::SwapSlippageExceeded)?;
            if received < min_amount_out {
                return Err(PrivacyCashError::SwapSlippageExceeded.into());
            }
        }
        SwapDir::SplToSol => {
            let spl_before = token_amount(pool_spl_account)?;
            if spl_before < amount_in {
                return Err(PrivacyCashError::InsufficientFundsForWithdrawal.into());
            }
            let wsol_before = token_amount(pool_wsol_account)?;
            let sol_before = sol_vault.lamports();

            invoke_route(
                accounts,
                jupiter_program,
                global_config,
                pool_spl_account,
                pool_wsol_account,
                jupiter_indices,
                jupiter_data,
                &global_seeds,
            )?;

            let spl_after = token_amount(pool_spl_account)?;
            let consumed = spl_before
                .checked_sub(spl_after)
                .ok_or(PrivacyCashError::SwapInputNotConsumed)?;
            // exactly amount_in, as for SOL -> SPL
            if consumed != amount_in {
                return Err(PrivacyCashError::SwapInputNotConsumed.into());
            }

            let received = token_amount(pool_wsol_account)?
                .checked_sub(wsol_before)
                .ok_or(PrivacyCashError::SwapSlippageExceeded)?;
            if received < min_amount_out {
                return Err(PrivacyCashError::SwapSlippageExceeded.into());
            }

            CloseAccount {
                account: pool_wsol_account,
                destination: sol_vault,
                authority: global_config,
            }
            .invoke_signed(&[Signer::from(&global_seeds)])?;

            if sol_vault.lamports().saturating_sub(sol_before) < min_amount_out {
                return Err(PrivacyCashError::SwapSlippageExceeded.into());
            }
        }
    }

    let in_first = append_commitments(in_tree_account, &proof_in.output_commitments)?;
    let out_first = append_commitments(out_tree_account, &proof_out.output_commitments)?;

    // One event per pool the swap writes to, like a transact on that pool.
    let pool_mint = |mint: &[u8; 32]| if *mint == SOL_ADDRESS { None } else { Some(*mint) };
    emit_transact_event(
        in_first,
        pool_mint(&in_mint).as_ref(),
        &proof_in.output_commitments,
        &proof_in.input_nullifiers,
        args.encrypted_output_in1,
        args.encrypted_output_in2,
    );
    emit_transact_event(
        out_first,
        pool_mint(&out_mint).as_ref(),
        &proof_out.output_commitments,
        &proof_out.input_nullifiers,
        args.encrypted_output_out1,
        args.encrypted_output_out2,
    );

    Ok(())
}

fn invoke_route(
    accounts: &[AccountView],
    jupiter_program: &AccountView,
    global_config: &AccountView,
    pool_in_account: &AccountView,
    pool_out_account: &AccountView,
    jupiter_indices: &[u8],
    jupiter_data: &[u8],
    global_seeds: &[Seed],
) -> ProgramResult {
    let program_id = Address::from(crate::ID);
    let authority = global_config.address();

    let mut views: Vec<&AccountView> = Vec::with_capacity(jupiter_indices.len());
    let mut writable: Vec<bool> = Vec::with_capacity(jupiter_indices.len());
    for &raw_index in jupiter_indices {
        let index = (raw_index & 0x7f) as usize;
        let wants_writable = raw_index & 0x80 != 0;
        let account = accounts
            .get(index)
            .ok_or(PrivacyCashError::InvalidSwapRouteAccount)?;
        if account.is_signer() {
            return Err(PrivacyCashError::InvalidSwapRouteAccount.into());
        }
        if account.owned_by(&program_id) && account.address() != authority {
            return Err(PrivacyCashError::InvalidSwapRouteAccount.into());
        }
        if account.address() != pool_in_account.address()
            && account.address() != pool_out_account.address()
            && account.owned_by(&pinocchio_token::ID)
        {
            if let Ok(token) = TokenAccount::from_account_view(account) {
                if token.owner() == authority {
                    return Err(PrivacyCashError::InvalidSwapRouteAccount.into());
                }
            }
        }
        views.push(account);
        writable.push(wants_writable && account.is_writable());
    }

    let metas: Vec<InstructionAccount> = views
        .iter()
        .zip(writable.iter())
        .map(|(account, is_writable)| {
            InstructionAccount::new(
                account.address(),
                *is_writable,
                account.address() == authority,
            )
        })
        .collect();

    let instruction = InstructionView {
        program_id: jupiter_program.address(),
        accounts: &metas,
        data: jupiter_data,
    };

    invoke_signed_with_slice(&instruction, &views, &[Signer::from(global_seeds)])
}

fn verify_pool_token_account(
    account: &AccountView,
    owner: &AccountView,
    mint: &AccountView,
) -> ProgramResult {
    let token = TokenAccount::from_account_view(account)?;
    if token.owner() != owner.address() {
        return Err(PrivacyCashError::InvalidTokenAccount.into());
    }
    if token.mint() != mint.address() {
        return Err(PrivacyCashError::InvalidTokenAccountMintAddress.into());
    }
    Ok(())
}

fn token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    Ok(TokenAccount::from_account_view(account)?.amount())
}

/// Append a pair; returns the first new leaf's index.
fn append_commitments(tree_account: &AccountView, commitments: &[[u8; 32]; 2]) -> Result<u32, ProgramError> {
    let mut tree_data = tree_account.try_borrow_mut()?;
    let tree =
        bytemuck::try_from_bytes_mut::<MerkleTreeAccount>(&mut tree_data[..MerkleTreeAccount::LEN])
            .map_err(|_| PrivacyCashError::InvalidMerkleTreeAccount)?;

    let first_leaf_index = tree.next_index;
    MerkleTree::append_pair::<Poseidon>(commitments, tree)?;

    Ok(first_leaf_index)
}
