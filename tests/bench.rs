mod common;

use mollusk_svm::{Mollusk, result::Check};

use light_hasher::{Poseidon, zero_bytes::poseidon::ZERO_BYTES};

use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction,
    account::Account,
    rent::Rent
};
use common::{
    prover::{DepositProofToSubmit, DepositProofArtifacts, ProofInput, prove, deposit_artifacts_to_submit },
    utils::{get_ext_data_hash, ExtData, calculate_deposit_fee, calculate_withdrawal_fee},
    constants::{DEPOSIT_FEE_RATE, FEE_ERROR_MARGIN, FEE_RECIPIENT_ACCOUNT, FIELD_SIZE_DECIMAL, WITHDRAW_FEE_RATE, SOL_ADDRESS, DEFAULT_HEIGHT},
    utxo::Utxo,
    merkle_tree::MerkleTree
};
use solana_transaction::{Transaction, AccountMeta};
use ethers::{
    core::{k256::schnorr::CryptoRngCore, rand::{RngCore, thread_rng}}, utils::hex,
};

use std::{dbg, ops::{Add, Rem, Sub}, path::PathBuf, str::FromStr};
use num_bigint::{BigInt, BigUint};
use num_traits::ToPrimitive;
use privacy_cash::{
    constants, instructions::{self, PrivacyCashInstructions},
    merkle_tree::MerkleTree as OnChainMerkleTree,
    state::{
        GlobalConfig, MerkleTreeAccount, transact::{ExtDataMinified, Proof, TransactArgs}
    },
};

use bytemuck::{
    bytes_of, from_bytes, NoUninit, Pod, Zeroable
};

use solana_address::Address;
use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_program::{example_mocks::solana_sdk::system_instruction, pubkey::Pubkey};
use solana_compute_budget_interface::ComputeBudgetInstruction;

const PROGRAM_ID: &str = "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV";
const BENCH_HISTORY_PATH: &str = "../target/bench_history/compute_units.txt";

pub fn generate_random_nullifier() -> [u8; 32] {
    let mut nullifier = [0u8; 32];
    thread_rng().fill_bytes(&mut nullifier);
    nullifier
}

pub fn create_ext_data_minified(ext_data: &ExtData) -> ExtDataMinified {
    ExtDataMinified { ext_amount: ext_data.ext_amount, fee: ext_data.fee }
}

pub fn bn_to_bytes(value: u128) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[16..].copy_from_slice(&value.to_be_bytes());
    bytes
}

pub fn format_proof(proof: DepositProofToSubmit) -> Proof {
    Proof {
        proof_a: proof.proof_a.try_into().expect("proof_a must be 64 bytes"),
        proof_b: proof.proof_b.try_into().expect("proof_b must be 128 bytes"),
        proof_c: proof.proof_c.try_into().expect("proof_c must be 64 bytes"),
        root: proof.root,
        public_amount: proof.public_amount,
        ext_data_hash: proof.ext_data_hash,
        input_nullifiers: proof.input_nullifiers,
        output_commitments: proof.output_commitments,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NullifierPdas {
    pub nullifier0: Pubkey,
    pub nullifier1: Pubkey,
    pub bump0: u8,
    pub bump1: u8,
}

pub fn find_nullifier_pdas(program_id: &Pubkey, proof: &Proof) -> NullifierPdas {
    let (nullifier0, bump0) = Pubkey::find_program_address(&[b"nullifier0", &proof.input_nullifiers[0]], program_id);
    let (nullifier1, bump1) = Pubkey::find_program_address(&[b"nullifier1", &proof.input_nullifiers[1]], program_id);
    NullifierPdas { nullifier0, nullifier1, bump0, bump1 }
}

pub fn find_cross_check_nullifier_pdas(program_id: &Pubkey, proof: &Proof) -> (Pubkey, Pubkey) {
    let (nullifier2_pda, _) = Pubkey::find_program_address(&[b"nullifier0", &proof.input_nullifiers[1]], program_id);
    let (nullifier3_pda, _) = Pubkey::find_program_address(&[b"nullifier1", &proof.input_nullifiers[0]], program_id);
    (nullifier2_pda, nullifier3_pda)
}

pub struct BenchContext {
    pub mollusk: Mollusk,
    pub program_id: Pubkey,
    pub authority: Keypair,
    pub funding_account: Keypair,
    pub recipient: Keypair,
    pub fee_recipient: Keypair,
    pub random_user: Keypair,
    pub attacker: Keypair,
    pub tree_account: Pubkey,
    pub tree_token_account: Pubkey,
    pub global_config: Pubkey,
    pub tree_bump: u8,
    pub tree_token_bump: u8,
    pub global_config_bump: u8,
    pub merkle_tree: MerkleTree,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct InitiailizeParams {
    pub tree_account_bump: u8,
    pub tree_token_account_bump: u8,
    pub global_config_bump: u8,
}

pub fn build_initialize_ix(
    program_id: Pubkey, authority: Pubkey, tree_account: Pubkey, tree_token_account: Pubkey,
    global_config: Pubkey, tree_account_bump: u8, tree_token_account_bump: u8, global_config_bump: u8,
) -> Instruction {
    let params = InitiailizeParams { tree_account_bump, tree_token_account_bump, global_config_bump };
    let mut data = vec![PrivacyCashInstructions::Initialize as u8];
    data.extend_from_slice(bytemuck::bytes_of(&params));

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(tree_account, false),
            AccountMeta::new(tree_token_account, false),
            AccountMeta::new(global_config, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data
    }
}

pub fn build_transact_ix(
    program_id: Pubkey, proof: &Proof, ext_data_minified: &ExtDataMinified,
    encrypted_output1: &[u8], encrypted_output2: &[u8], nullifier_bump0: u8, nullifier_bump1: u8,
    tree_account: Pubkey, nullifier0: Pubkey, nullifier1: Pubkey, nullifier2: Pubkey, nullifier3: Pubkey,
    tree_token_account: Pubkey, global_config: Pubkey, recipient: Pubkey, fee_recipient: Pubkey, signer: Pubkey,
) -> Instruction {
    let mut data = Vec::new();
    data.push(PrivacyCashInstructions::Transact as u8);
    data.extend_from_slice(bytemuck::bytes_of(proof));
    data.extend_from_slice(bytemuck::bytes_of(ext_data_minified));
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.push(nullifier_bump0);
    data.push(nullifier_bump1);

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(tree_account, false),
            AccountMeta::new(nullifier0, false),
            AccountMeta::new(nullifier1, false),
            AccountMeta::new(nullifier2, false),
            AccountMeta::new(nullifier3, false),
            AccountMeta::new(tree_token_account, false),
            AccountMeta::new(global_config, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(fee_recipient, false),
            AccountMeta::new(signer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

fn build_update_global_config_ix(
    program_id: Pubkey, global_config: Pubkey, authority: Pubkey,
    deposit_fee_rate: Option<u64>, withdrawal_fee_rate: Option<u64>, fee_error_margin: Option<u64>,
) -> Instruction {
    let mut data = Vec::new();
    data.push(PrivacyCashInstructions::UpdateGlobalConfig as u8);

    let update_mask =
        match deposit_fee_rate { Some(_) => constants::UPDATE_DEPOSIT_FEE, None => 0 } |
        match withdrawal_fee_rate { Some(_) => constants::UPDATE_WITHDRAWAL_FEE, None => 0 } |
        match fee_error_margin { Some(_) => constants::UPDATE_FEE_ERROR_MARGIN, None => 0 };

    data.extend_from_slice(&(deposit_fee_rate.unwrap_or(0) as u16).to_le_bytes());
    data.extend_from_slice(&(withdrawal_fee_rate.unwrap_or(0) as u16).to_le_bytes());
    data.extend_from_slice(&(fee_error_margin.unwrap_or(0) as u16).to_le_bytes());
    data.push(update_mask);
    data.push(0);

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(global_config, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

fn setup() -> BenchContext {
    let program_id = Pubkey::from_str_const(PROGRAM_ID);

    // silence Mollusk's stable_log spam; if a test still shows logs (logger
    // already latched by something earlier in the same process), run with
    // `RUST_LOG=off cargo test` instead — that's guaranteed to work.
    std::env::set_var("RUST_LOG", "off");
    let mut mollusk = Mollusk::new(&program_id, "target/deploy/privacy_cash");

    let authority = Keypair::new();
    let funding_account = Keypair::new();
    let recipient = Keypair::new();
    let fee_recipient = Keypair::new();
    let random_user = Keypair::new();
    let attacker = Keypair::new();

    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk_svm_programs_token::associated_token::add_program(&mut mollusk);

    let merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());

    let (tree_account, tree_bump) = Pubkey::find_program_address(&[b"merkle_tree"], &program_id);
    let (tree_token_account, tree_token_bump) = Pubkey::find_program_address(&[b"tree_token"], &program_id);
    let (global_config, global_config_bump) = Pubkey::find_program_address(&[b"global_config"], &program_id);

    BenchContext {
        mollusk,
        program_id: Pubkey::from_str_const(PROGRAM_ID),
        authority, funding_account, recipient, fee_recipient, random_user, attacker,
        tree_account, tree_token_account, global_config,
        tree_bump, tree_token_bump, global_config_bump,
        merkle_tree,
    }
}

fn uninitialized_account() -> Account {
    Account::new(0, 0, &SYSTEM_PROGRAM)
}

fn funded_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &SYSTEM_PROGRAM)
}

fn system_program_keyed_account() -> (Pubkey, Account) {
    (
        SYSTEM_PROGRAM,
        Account { lamports: 1, data: vec![], owner: solana_sdk_ids::native_loader::ID, executable: true, rent_epoch: 0 },
    )
}

fn account_with_data(owner: Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn genesis_tree_account(authority: Pubkey, bump: u8) -> Account {
    let mut subtrees = [[0u8; 32]; constants::MERKLE_TREE_HEIGHT as usize];
    subtrees.copy_from_slice(&ZERO_BYTES[..constants::MERKLE_TREE_HEIGHT as usize]);

    let mut root_history = [[0u8; 32]; constants::ROOT_HISTORY_SIZE as usize];
    root_history[0] = ZERO_BYTES[constants::MERKLE_TREE_HEIGHT as usize];

    let tree = MerkleTreeAccount {
        max_deposit_amount: 1_000_000_000_000,
        next_index: 0,
        root_index: 0,
        bump,
        _padding: [0; 2],
        subtrees,
        root_history,
        authority: authority.to_bytes(),
    };

    account_with_data(Pubkey::from_str_const(PROGRAM_ID), bytemuck::bytes_of(&tree).to_vec())
}

fn global_config_account(
    authority: Pubkey, bump: u8, deposit_fee_rate: u16, withdrawal_fee_rate: u16, fee_error_margin: u16,
) -> Account {
    let cfg = GlobalConfig {
        authority: authority.to_bytes(), deposit_fee_rate, withdrawal_fee_rate, fee_error_margin, _padding: 0, bump,
    };
    account_with_data(Pubkey::from_str_const(PROGRAM_ID), bytemuck::bytes_of(&cfg).to_vec())
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TreeTokenAccountState {
    authority: Pubkey,
    bump: u8,
}

fn tree_token_account_account(authority: Pubkey, bump: u8) -> Account {
    let state = TreeTokenAccountState { authority, bump };
    let mut data = Vec::with_capacity(33);
    data.extend_from_slice(&state.authority.to_bytes());
    data.push(state.bump);
    account_with_data(Pubkey::from_str_const(PROGRAM_ID), data)
}

/// Same as tree_token_account_account, but pre-funded above the rent-exempt
/// minimum — needed for withdrawal scenarios, since the account has to have
/// enough spare balance to cover the payout and still clear the rent check
/// afterward. Deposits don't need this (they only ever credit the account).
fn funded_tree_token_account(authority: Pubkey, bump: u8, extra_lamports: u64) -> Account {
    let mut acct = tree_token_account_account(authority, bump);
    acct.lamports += extra_lamports;
    acct
}

// Shared proof-input math

fn field_size() -> BigInt {
    BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap()
}

/// public_amount = (ext_amount - fee) mod field_size, valid for both signs of
/// ext_amount (deposit: positive, withdrawal: negative) — verified against
/// check_public_amount's two branches algebraically, not just copied.
fn compute_public_amount(ext_amount: &BigInt, fee: u64) -> BigUint {
    let fs = field_size();
    ((ext_amount - BigInt::from(fee)) + &fs)
        .rem_euclid(&fs)
        .to_biguint()
        .expect("public amount should be non-negative after field wrap")
}

trait RemEuclidBigInt {
    fn rem_euclid(&self, m: &BigInt) -> BigInt;
}
impl RemEuclidBigInt for BigInt {
    fn rem_euclid(&self, m: &BigInt) -> BigInt {
        ((self % m) + m) % m
    }
}

/// Builds the on-chain MerkleTreeAccount state for "one deposit already
/// happened", by calling the real on-chain MerkleTree::append directly —
/// it's plain Rust, no SVM context needed, so this is exact and doesn't cost
/// a Mollusk call (or a proof) on a deposit we're not even measuring.
/// Also advances `off_chain_tree` the same way, so `.path()` on it afterward
/// gives a real Merkle path for whatever a withdrawal needs to spend.
fn seed_one_deposit(ctx: &BenchContext, amount: u64, off_chain_tree: &mut MerkleTree) -> (Utxo, MerkleTreeAccount) {
    let output_index = off_chain_tree.elements().len() as u64;
    let deposited = Utxo::new_with_index(amount, output_index);
    let change = Utxo::new(0);

    let commitment0 = deposited.get_commitment().expect("commitment");
    let commitment1 = change.get_commitment().expect("commitment");

    off_chain_tree.insert(commitment0);
    off_chain_tree.insert(commitment1);

    let mut on_chain_tree = MerkleTreeAccount {
        max_deposit_amount: 1_000_000_000_000,
        next_index: 0,
        root_index: 0,
        bump: ctx.tree_bump,
        _padding: [0; 2],
        subtrees: [[0u8; 32]; constants::MERKLE_TREE_HEIGHT as usize],
        root_history: [[0u8; 32]; constants::ROOT_HISTORY_SIZE as usize],
        authority: ctx.authority.pubkey().to_bytes(),
    };
    OnChainMerkleTree::intialize::<Poseidon>(&mut on_chain_tree).unwrap();
    OnChainMerkleTree::append::<Poseidon>(commitment0, &mut on_chain_tree).unwrap();
    OnChainMerkleTree::append::<Poseidon>(commitment1, &mut on_chain_tree).unwrap();

    (deposited, on_chain_tree)
}

fn key_base_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("artifacts").join("circuits").join("transaction2")
}

// Scenario builders — each returns a ready-to-run (Instruction, accounts) pair

fn scenario_initialize(ctx: &BenchContext) -> (Instruction, Vec<(Pubkey, Account)>) {
    let ix = build_initialize_ix(
        ctx.program_id, ctx.authority.pubkey(), ctx.tree_account, ctx.tree_token_account,
        ctx.global_config, ctx.tree_bump, ctx.tree_token_bump, ctx.global_config_bump,
    );
    let accounts = vec![
        (ctx.tree_account, uninitialized_account()),
        (ctx.tree_token_account, uninitialized_account()),
        (ctx.global_config, uninitialized_account()),
        (ctx.authority.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];
    (ix, accounts)
}

fn scenario_update_global_config(
    ctx: &BenchContext,
    deposit_fee_rate: Option<u64>, withdrawal_fee_rate: Option<u64>, fee_error_margin: Option<u64>,
) -> (Instruction, Vec<(Pubkey, Account)>) {
    let ix = build_update_global_config_ix(
        ctx.program_id, ctx.global_config, ctx.authority.pubkey(),
        deposit_fee_rate, withdrawal_fee_rate, fee_error_margin,
    );
    let accounts = vec![
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, 0, 25, 500)),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];
    (ix, accounts)
}

fn scenario_transact_deposit_first(ctx: &BenchContext) -> (Instruction, Vec<(Pubkey, Account)>) {
    let deposit_amount: u64 = 1_000;
    let deposit_fee_u64 = calculate_deposit_fee(deposit_amount, DEPOSIT_FEE_RATE);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: deposit_fee_u64,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112").unwrap().to_bytes(),
    };

    let deposit_inputs = [Utxo::empty(), Utxo::empty()];
    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let public_amount_number = compute_public_amount(&ext_amount, deposit_fee_u64);

    let output_index = ctx.merkle_tree.elements().len() as u64;
    let deposit_outputs = [
        Utxo::new_with_index(
            public_amount_number.clone().try_into().expect("public amount should fit in u64"),
            output_index,
        ),
        Utxo::new(0),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];
    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.merkle_tree.levels],
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];
    let deposit_output_commitments = [
        deposit_outputs[0].get_commitment().expect("output commitment"),
        deposit_outputs[1].get_commitment().expect("output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number,
        ext_data_hash: deposit_ext_data_hash,
        in_amount: deposit_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: deposit_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: deposit_inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: deposit_inputs[0].mint_address.to_string(),
        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,
        out_amount: deposit_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: deposit_outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: deposit_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let proof_result = prove(&deposit_input, &key_base_path()).unwrap();
    let proof_to_submit = format_proof(deposit_artifacts_to_submit(&proof_result, false).unwrap());

    let nullifiers = find_nullifier_pdas(&ctx.program_id, &proof_to_submit);
    let cross_check = find_cross_check_nullifier_pdas(&ctx.program_id, &proof_to_submit);

    let ix = build_transact_ix(
        ctx.program_id, &proof_to_submit, &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1, &deposit_ext_data.encrypted_output2,
        nullifiers.bump0, nullifiers.bump1,
        ctx.tree_account, nullifiers.nullifier0, nullifiers.nullifier1, cross_check.0, cross_check.1,
        ctx.tree_token_account, ctx.global_config, ctx.recipient.pubkey(), FEE_RECIPIENT_ACCOUNT, ctx.random_user.pubkey(),
    );

    let accounts = vec![
        (ctx.tree_account, genesis_tree_account(ctx.authority.pubkey(), ctx.tree_bump)),
        (nullifiers.nullifier0, uninitialized_account()),
        (nullifiers.nullifier1, uninitialized_account()),
        (cross_check.0, uninitialized_account()),
        (cross_check.1, uninitialized_account()),
        (ctx.tree_token_account, tree_token_account_account(ctx.authority.pubkey(), ctx.tree_token_bump)),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.recipient.pubkey(), uninitialized_account()),
        (FEE_RECIPIENT_ACCOUNT, uninitialized_account()),
        (ctx.random_user.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];

    (ix, accounts)
}

fn scenario_transact_withdraw(ctx: &BenchContext) -> (Instruction, Vec<(Pubkey, Account)>) {
    let deposit_amount: u64 = 1_000;
    let mut off_chain_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());
    let (target_utxo, on_chain_tree) = seed_one_deposit(ctx, deposit_amount, &mut off_chain_tree);

    let withdraw_inputs = [target_utxo.clone(), Utxo::empty()];
    let withdraw_outputs = [Utxo::new(800), Utxo::new(0)];

    let inputs_sum: u64 = withdraw_inputs.iter().map(|x| x.amount).sum();
    let outputs_sum: u64 = withdraw_outputs.iter().map(|x| x.amount).sum();
    let withdraw_fee = calculate_withdrawal_fee(inputs_sum);

    let ext_amount = BigInt::from(withdraw_fee) + BigInt::from(outputs_sum) - BigInt::from(inputs_sum);
    let public_amount = compute_public_amount(&ext_amount, withdraw_fee);

    let output_index = 0usize; // target_utxo was the first thing ever inserted
    let path = off_chain_tree.path(output_index);

    let input_merkle_path_indices = [output_index, 0usize];
    let input_merkle_path_elements = vec![
        path.path_elements.clone(),
        vec![[0u8; 32]; off_chain_tree.levels],
    ];

    let input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];
    let output_commitments = [
        withdraw_outputs[0].get_commitment().unwrap(),
        withdraw_outputs[1].get_commitment().unwrap(),
    ];

    let ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: withdraw_fee,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112").unwrap().to_bytes(),
    };
    let ext_data_hash = get_ext_data_hash(&ext_data);

    let proof_input = ProofInput {
        root: off_chain_tree.root(),
        input_nullifier: input_nullifiers,
        output_commitment: output_commitments,
        public_amount,
        ext_data_hash,
        in_amount: withdraw_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: withdraw_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: withdraw_inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: withdraw_inputs[0].mint_address.to_string(),
        in_path_indices: input_merkle_path_indices,
        in_path_elements: input_merkle_path_elements,
        out_amount: withdraw_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: withdraw_outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: withdraw_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let proof_result = prove(&proof_input, &key_base_path()).unwrap();
    let proof_to_submit = format_proof(deposit_artifacts_to_submit(&proof_result, false).unwrap());

    let nullifiers = find_nullifier_pdas(&ctx.program_id, &proof_to_submit);
    let cross_check = find_cross_check_nullifier_pdas(&ctx.program_id, &proof_to_submit);

    let ix = build_transact_ix(
        ctx.program_id, &proof_to_submit, &create_ext_data_minified(&ext_data),
        &ext_data.encrypted_output1, &ext_data.encrypted_output2,
        nullifiers.bump0, nullifiers.bump1,
        ctx.tree_account, nullifiers.nullifier0, nullifiers.nullifier1, cross_check.0, cross_check.1,
        ctx.tree_token_account, ctx.global_config, ctx.recipient.pubkey(), FEE_RECIPIENT_ACCOUNT, ctx.random_user.pubkey(),
    );

    let accounts = vec![
        (ctx.tree_account, account_with_data(ctx.program_id, bytemuck::bytes_of(&on_chain_tree).to_vec())),
        (nullifiers.nullifier0, uninitialized_account()),
        (nullifiers.nullifier1, uninitialized_account()),
        (cross_check.0, uninitialized_account()),
        (cross_check.1, uninitialized_account()),
        (ctx.tree_token_account, funded_tree_token_account(ctx.authority.pubkey(), ctx.tree_token_bump, 10 * LAMPORTS_PER_SOL)),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.recipient.pubkey(), uninitialized_account()),
        (FEE_RECIPIENT_ACCOUNT, uninitialized_account()),
        (ctx.random_user.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];

    (ix, accounts)
}

// Reporting — clean table + persisted delta from the previous run

fn run_and_report(mollusk: &Mollusk, entries: Vec<(&'static str, Instruction, Vec<(Pubkey, Account)>)>) {
    use std::collections::HashMap;
    use std::io::Write;

    let previous: HashMap<String, u64> = std::fs::read_to_string(BENCH_HISTORY_PATH)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (name, cu) = line.split_once(':')?;
            Some((name.trim().to_string(), cu.trim().parse().ok()?))
        })
        .collect();

    println!("\n{:<38} {:>12} {:>10}", "scenario", "CU", "delta");
    println!("{}", "-".repeat(62));

    let mut new_history = String::new();
    for (name, ix, accounts) in &entries {
        let result = mollusk.process_instruction(ix, accounts);
        let cu = result.compute_units_consumed;

        let delta_str = match previous.get(*name) {
            Some(prev) if cu as i64 - *prev as i64 == 0 => "±0".to_string(),
            Some(prev) => format!("{:+}", cu as i64 - *prev as i64),
            None => "new".to_string(),
        };

        println!("{:<38} {:>12} {:>10}", name, cu, delta_str);
        new_history.push_str(&format!("{}: {}\n", name, cu));
    }
    println!();

    if let Some(parent) = std::path::Path::new(BENCH_HISTORY_PATH).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::File::create(BENCH_HISTORY_PATH) {
        let _ = f.write_all(new_history.as_bytes());
    }
}

// Individual tests — fast to run one at a time while iterating

#[test]
fn bench_initialize() {
    let ctx = setup();
    let (ix, accounts) = scenario_initialize(&ctx);
    run_and_report(&ctx.mollusk, vec![("initialize", ix, accounts)]);
}

#[test]
fn bench_update_global_config_one_field() {
    let ctx = setup();
    let (ix, accounts) = scenario_update_global_config(&ctx, None, Some(50), None);
    run_and_report(&ctx.mollusk, vec![("update_global_config_one_field", ix, accounts)]);
}

#[test]
fn bench_update_global_config_all_fields() {
    let ctx = setup();
    let (ix, accounts) = scenario_update_global_config(&ctx, Some(10), Some(60), Some(300));
    run_and_report(&ctx.mollusk, vec![("update_global_config_all_fields", ix, accounts)]);
}

#[test]
fn bench_update_global_config_no_fields() {
    let ctx = setup();
    let (ix, accounts) = scenario_update_global_config(&ctx, None, None, None);
    run_and_report(&ctx.mollusk, vec![("update_global_config_no_fields", ix, accounts)]);
}

#[test]
fn bench_transact_deposit_first() {
    let ctx = setup();
    let (ix, accounts) = scenario_transact_deposit_first(&ctx);
    run_and_report(&ctx.mollusk, vec![("transact_deposit_first", ix, accounts)]);
}

#[test]
fn bench_transact_withdraw() {
    let ctx = setup();
    let (ix, accounts) = scenario_transact_withdraw(&ctx);
    run_and_report(&ctx.mollusk, vec![("transact_withdraw_partial", ix, accounts)]);
}

#[test]
fn bench_all() {
    let ctx = setup();

    let init = scenario_initialize(&ctx);
    let cfg_one = scenario_update_global_config(&ctx, None, Some(50), None);
    let cfg_all = scenario_update_global_config(&ctx, Some(10), Some(60), Some(300));
    let cfg_none = scenario_update_global_config(&ctx, None, None, None);
    let deposit = scenario_transact_deposit_first(&ctx);
    let withdraw = scenario_transact_withdraw(&ctx);

    run_and_report(&ctx.mollusk, vec![
        ("initialize", init.0, init.1),
        ("update_global_config_one_field", cfg_one.0, cfg_one.1),
        ("update_global_config_all_fields", cfg_all.0, cfg_all.1),
        ("update_global_config_no_fields", cfg_none.0, cfg_none.1),
        ("transact_deposit_first", deposit.0, deposit.1),
        ("transact_withdraw_partial", withdraw.0, withdraw.1),
    ]);
}