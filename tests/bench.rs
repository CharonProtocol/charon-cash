mod common;

use mollusk_svm::{Mollusk, result::Check};
use mollusk_svm_bencher;

use pinocchio::error::ProgramError;
use solana_clock::Clock;
use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction,
    account::Account,
    rent::Rent
};
use common::{
    prover::{DepositProofToSubmit, DepositProofArtifacts, ProofInput, prove, deposit_artifacts_to_submit },
    utils::{get_ext_data_hash, ExtData, calculate_deposit_fee, get_mint_address_field},
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
    constants, instructions::{self, IntiailizeTreeTokenAccountParams, PrivacyCashInstructions},
    state::{
        GlobalConfig, MerkleTreeAccount, transact::{ExtDataMinified, Proof, TransactArgs}
    },
};

use bytemuck::{
    bytes_of, from_bytes, NoUninit, Pod, Zeroable
};

use solana_address::Address;
use light_hasher::zero_bytes::poseidon::ZERO_BYTES;
use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_program::{example_mocks::solana_sdk::system_instruction, pubkey::Pubkey};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use spl_associated_token_account::get_associated_token_address;
use spl_token::state::{Mint, Account as SplTokenAccount, AccountState};
// double check these two against your exact SDK version if they don't resolve —
// this is the one part of this diff I haven't seen confirmed working in your file yet.
use solana_program_pack::Pack;
use solana_sdk::program_option::COption;

const PROGRAM_ID: &str = "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV";

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

// --- new: update_deposit_limit / update_deposit_limit_for_spl ---
// UpdateDepositLimitParams/UpdateDepositLimitSplParams aren't re-exported at
// the instructions:: level (only their submodules are pub), so these are
// local copies matching your on-chain struct layout byte-for-byte.

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct UpdateDepositLimitParams {
    pub new_limit: [u8; 8],
    pub tree_account_bump: u8,
}

pub fn build_update_deposit_limit_ix(
    program_id: Pubkey, tree_account: Pubkey, authority: Pubkey, new_limit: u64, tree_account_bump: u8,
) -> Instruction {
    let params = UpdateDepositLimitParams { new_limit: new_limit.to_le_bytes(), tree_account_bump };
    let mut data = vec![PrivacyCashInstructions::UpdateDepositLimit as u8];
    data.extend_from_slice(bytemuck::bytes_of(&params));

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(tree_account, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct UpdateDepositLimitSplParams {
    pub new_limit: [u8; 8],
    pub tree_account_bump: u8,
}

pub fn build_update_deposit_limit_for_spl_ix(
    program_id: Pubkey, tree_account: Pubkey, mint: Pubkey, authority: Pubkey, new_limit: u64, tree_account_bump: u8,
) -> Instruction {
    let params = UpdateDepositLimitSplParams { new_limit: new_limit.to_le_bytes(), tree_account_bump };
    let mut data = vec![PrivacyCashInstructions::UpdateDepositLimitForSpl as u8];
    data.extend_from_slice(bytemuck::bytes_of(&params));

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(tree_account, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

// --- new: initialize_tree_account_for_spl_token ---
// build_initialize_for_spl_ix and build_transact_spl_ix below are lifted from
// your spl_mint_tests.rs almost verbatim — that file's already proven to build
// correct accounts/instructions, no reason to redo it differently here.

pub fn build_initialize_for_spl_ix(
    program_id: Pubkey, authority: Pubkey, spl_tree_account: Pubkey, mint: Pubkey,
    global_config: Pubkey, tree_account_bump: u8, max_deposit_amount: u64,
) -> Instruction {
    let params = IntiailizeTreeTokenAccountParams {
        max_deposit_amount,
        tree_account_bump,
        padding: [0u8; 7],
    };
    let mut data = vec![PrivacyCashInstructions::InitializeTreeAccountForSplToken as u8];
    data.extend_from_slice(bytemuck::bytes_of(&params));

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(spl_tree_account, false),
            AccountMeta::new(mint, false),
            AccountMeta::new(global_config, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

// --- new: transact_spl ---

pub fn build_transact_spl_ix(
    program_id: Pubkey, proof: &Proof, ext_data_minified: &ExtDataMinified,
    encrypted_output1: &[u8], encrypted_output2: &[u8], nullifier_bump0: u8, nullifier_bump1: u8,
    spl_tree_account: Pubkey, nullifier0: Pubkey, nullifier1: Pubkey, nullifier2: Pubkey, nullifier3: Pubkey,
    global_config: Pubkey, signer: Pubkey, mint: Pubkey, signer_ata: Pubkey,
    recipient: Pubkey, recipient_ata: Pubkey, spl_tree_ata: Pubkey, fee_recipient_ata: Pubkey,
) -> Instruction {
    let mut data = Vec::new();
    data.push(PrivacyCashInstructions::TransactSpl as u8);
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
            AccountMeta::new(spl_tree_account, false),
            AccountMeta::new(nullifier0, false),
            AccountMeta::new(nullifier1, false),
            AccountMeta::new(nullifier2, false),
            AccountMeta::new(nullifier3, false),
            AccountMeta::new(global_config, false),
            AccountMeta::new(signer, true),
            AccountMeta::new(mint, false),
            AccountMeta::new(signer_ata, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(recipient_ata, false),
            AccountMeta::new(spl_tree_ata, false),
            AccountMeta::new(fee_recipient_ata, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(spl_associated_token_account::ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

fn setup() -> BenchContext {
    let program_id = Pubkey::from_str_const(PROGRAM_ID);
    let mut mollusk = Mollusk::new(&program_id , "target/deploy/privacy_cash");

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
        tree_bump, tree_token_bump, global_config_bump, merkle_tree,
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

    let data = bytemuck::bytes_of(&tree).to_vec();
    Account {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: Pubkey::from_str_const(PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn global_config_account(
    authority: Pubkey, bump: u8, deposit_fee_rate: u16, withdrawal_fee_rate: u16, fee_error_margin: u16,
) -> Account {
    let cfg = GlobalConfig {
        authority: authority.to_bytes(), deposit_fee_rate, withdrawal_fee_rate, fee_error_margin, _padding: 0, bump,
    };
    let data = bytemuck::bytes_of(&cfg).to_vec();
    Account {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: Pubkey::from_str_const(PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TreeTokenAccountState {
    authority: Pubkey,
    bump: u8,
}

fn tree_token_account_account(authority: Pubkey, bump: u8) -> Account {
    let state = TreeTokenAccountState { authority, bump };
    let mut data = Vec::with_capacity(32 + 1);
    data.extend_from_slice(&state.authority.to_bytes());
    data.push(state.bump);

    Account {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: Pubkey::from_str_const(PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }
}

// --- new: SPL mint/token account construction ---
// Mollusk has no ledger to run CreateMint/MintTo/CreateAssociatedTokenAccount
// through (that's what litesvm_token gives you) — these build the equivalent
// packed byte state directly.

fn mint_account(mint_authority: Pubkey) -> Account {
    let mint = Mint {
        mint_authority: COption::Some(mint_authority),
        supply: 1_000_000_000_000,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    Account { lamports: Rent::default().minimum_balance(data.len()), data: data.to_vec(), owner: spl_token::ID, executable: false, rent_epoch: 0 }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let acct = SplTokenAccount {
        mint, owner, amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; SplTokenAccount::LEN];
    SplTokenAccount::pack(acct, &mut data).unwrap();
    Account { lamports: Rent::default().minimum_balance(data.len()), data: data.to_vec(), owner: spl_token::ID, executable: false, rent_epoch: 0 }
}

#[test]
fn bench_initialize() {
    let ctx = setup();

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

    ctx.mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
}

#[test]
fn bench_update_global_config() {
    let ctx = setup();

    let global_config_account = global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, 0, 25, 500);

    let ix = build_update_global_config_ix(ctx.program_id, ctx.global_config, ctx.authority.pubkey(), None, Some(50), None);

    let accounts = vec![
        (ctx.global_config, global_config_account),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];

    ctx.mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
}

// --- new: update_deposit_limit / update_deposit_limit_for_spl, with real checks ---
// Check::success() alone would pass even if the write silently no-op'd — building
// the expected post-update account byte-for-byte and diffing it is what actually
// confirms max_deposit_amount moved (and that nothing else in the account did).

#[test]
fn bench_update_deposit_limit() {
    let ctx = setup();
    let new_limit: u64 = 5_000_000_000_000;

    let before = genesis_tree_account(ctx.authority.pubkey(), ctx.tree_bump);
    let mut expected_tree = *bytemuck::from_bytes::<MerkleTreeAccount>(&before.data[..MerkleTreeAccount::LEN]);
    expected_tree.max_deposit_amount = new_limit;
    let expected_data = bytemuck::bytes_of(&expected_tree).to_vec();

    let ix = build_update_deposit_limit_ix(ctx.program_id, ctx.tree_account, ctx.authority.pubkey(), new_limit, ctx.tree_bump);
    let accounts = vec![
        (ctx.tree_account, before),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];

    ctx.mollusk.process_and_validate_instruction(
        &ix, &accounts,
        &[Check::success(), Check::account(&ctx.tree_account).data(&expected_data).build()],
    );
}

#[test]
fn bench_update_deposit_limit_for_spl() {
    let ctx = setup();
    let mint = Pubkey::new_unique();
    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);
    let new_limit: u64 = 7_000_000_000_000;

    let before = genesis_tree_account(ctx.authority.pubkey(), spl_tree_bump);
    let mut expected_tree = *bytemuck::from_bytes::<MerkleTreeAccount>(&before.data[..MerkleTreeAccount::LEN]);
    expected_tree.max_deposit_amount = new_limit;
    let expected_data = bytemuck::bytes_of(&expected_tree).to_vec();

    let ix = build_update_deposit_limit_for_spl_ix(ctx.program_id, spl_tree_account, mint, ctx.authority.pubkey(), new_limit, spl_tree_bump);
    let accounts = vec![
        (spl_tree_account, before),
        (mint, mint_account(ctx.authority.pubkey())),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];

    ctx.mollusk.process_and_validate_instruction(
        &ix, &accounts,
        &[Check::success(), Check::account(&spl_tree_account).data(&expected_data).build()],
    );
}

// --- new: initialize_tree_account_for_spl_token ---

#[test]
fn bench_initialize_tree_account_for_spl_token() {
    let ctx = setup();
    let mint = Pubkey::new_unique();
    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);

    let ix = build_initialize_for_spl_ix(
        ctx.program_id, ctx.authority.pubkey(), spl_tree_account, mint, ctx.global_config, spl_tree_bump, 50_000_000_000_000,
    );

    let accounts = vec![
        (spl_tree_account, uninitialized_account()),
        (mint, mint_account(ctx.authority.pubkey())),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.authority.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];

    ctx.mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
}

#[test]
fn bench_transact_deposit_first() {
    let ctx = setup();

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

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();
    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee_big = BigInt::from(deposit_fee_u64);
    let public_amount_number = (ext_amount - deposit_fee_big + &field_size) % &field_size;

    let output_index = ctx.merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_index(public_amount_number.clone().try_into().expect("Public amount should fit in u64"), output_index),
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
        deposit_outputs[0].get_commitment().expect("failed to compute output commitment"),
        deposit_outputs[1].get_commitment().expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number.clone().to_biguint().expect("public amount should be non-negative"),
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

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("artifacts").join("circuits").join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();
    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);

    let transact_ix = build_transact_ix(
        Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit, &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1, &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0, deposit_nullifiers.bump1,
        ctx.tree_account, deposit_nullifiers.nullifier0, deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0, deposit_cross_check_nullifiers.1,
        ctx.tree_token_account, ctx.global_config, ctx.recipient.pubkey(), FEE_RECIPIENT_ACCOUNT, ctx.random_user.pubkey(),
    );

    let tree_account = genesis_tree_account(ctx.authority.pubkey(), ctx.tree_bump);
    let tree_token_account = tree_token_account_account(ctx.authority.pubkey(), ctx.tree_token_bump);
    let global_config_account = global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN);

    let initial_signer_lamports = 10 * LAMPORTS_PER_SOL;

    let accounts = vec![
        (ctx.tree_account, tree_account),
        (deposit_nullifiers.nullifier0, uninitialized_account()),
        (deposit_nullifiers.nullifier1, uninitialized_account()),
        (deposit_cross_check_nullifiers.0, uninitialized_account()),
        (deposit_cross_check_nullifiers.1, uninitialized_account()),
        (ctx.tree_token_account, tree_token_account),
        (ctx.global_config, global_config_account),
        (ctx.recipient.pubkey(), uninitialized_account()),
        (FEE_RECIPIENT_ACCOUNT, uninitialized_account()),
        (ctx.random_user.pubkey(), funded_account(initial_signer_lamports)),
        system_program_keyed_account(),
    ];

    ctx.mollusk.process_and_validate_instruction(&transact_ix, &accounts, &[Check::success()]);
}

// --- new: transact_spl deposit ---
// Shared by both ATA-state variants below — everything except tree_ata's
// starting state is identical, so this stays one function rather than two
// near-duplicates.

fn run_bench_transact_spl_deposit(tree_ata_exists: bool) {
    let ctx = setup();
    let mint = Pubkey::new_unique();

    let deposit_amount: u64 = 100;
    let deposit_fee_u64 = calculate_deposit_fee(deposit_amount, DEPOSIT_FEE_RATE);

    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &mint);
    let fee_recipient_ata = get_associated_token_address(&ctx.fee_recipient.pubkey(), &mint);
    let spl_tree_ata = get_associated_token_address(&ctx.global_config, &mint);

    // recipient/fee_recipient here are the token accounts, matching how
    // process_transact_spl hashes recipient_token_account.address(), not the wallet.
    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: deposit_fee_u64,
        fee_recipient: fee_recipient_ata.to_bytes(),
        mint_address: mint.to_bytes(),
    };

    // dummies must share the transaction's mint — Utxo::empty() defaults to the
    // SOL mint, which would desync from the SPL mint fed as the circuit's shared
    // mintAddress input.
    let deposit_inputs = [Utxo::with_mint(0, mint), Utxo::with_mint(0, mint)];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();
    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee_big = BigInt::from(deposit_fee_u64);
    let public_amount_number = (ext_amount - deposit_fee_big + &field_size) % &field_size;

    let mut spl_merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());
    let output_index = spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(public_amount_number.clone().try_into().expect("Public amount should fit in u64"), mint)
            .with_index(output_index),
        Utxo::new_with_mint(0, mint),
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];
    let deposit_output_commitments = [
        deposit_outputs[0].get_commitment().expect("failed to compute output commitment"),
        deposit_outputs[1].get_commitment().expect("failed to compute output commitment"),
    ];

    let deposit_root = spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number.clone().to_biguint().expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,
        in_amount: deposit_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: deposit_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: deposit_inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: mint.to_string(),
        in_path_indices: [0usize; 2],
        in_path_elements: vec![
            vec![[0u8; 32]; spl_merkle_tree.levels],
            vec![[0u8; 32]; spl_merkle_tree.levels],
        ],
        out_amount: deposit_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: deposit_outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: deposit_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("artifacts").join("circuits").join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();
    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);

    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);

    let transact_ix = build_transact_spl_ix(
        ctx.program_id, &deposit_proof_to_submit, &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1, &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0, deposit_nullifiers.bump1,
        spl_tree_account, deposit_nullifiers.nullifier0, deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0, deposit_cross_check_nullifiers.1,
        ctx.global_config, ctx.random_user.pubkey(), mint,
        get_associated_token_address(&ctx.random_user.pubkey(), &mint),
        ctx.recipient.pubkey(), recipient_ata, spl_tree_ata, fee_recipient_ata,
    );

    let spl_tree_ata_account = if tree_ata_exists {
        token_account(mint, ctx.global_config, 0)
    } else {
        uninitialized_account()
    };

    let accounts = vec![
        (spl_tree_account, genesis_tree_account(ctx.authority.pubkey(), spl_tree_bump)),
        (deposit_nullifiers.nullifier0, uninitialized_account()),
        (deposit_nullifiers.nullifier1, uninitialized_account()),
        (deposit_cross_check_nullifiers.0, uninitialized_account()),
        (deposit_cross_check_nullifiers.1, uninitialized_account()),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.random_user.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        (mint, mint_account(ctx.authority.pubkey())),
        (get_associated_token_address(&ctx.random_user.pubkey(), &mint), token_account(mint, ctx.random_user.pubkey(), deposit_amount * 10)),
        (ctx.recipient.pubkey(), uninitialized_account()),
        (recipient_ata, uninitialized_account()), // unread on the deposit path, only its address matters
        (spl_tree_ata, spl_tree_ata_account),
        (fee_recipient_ata, uninitialized_account()), // fee = 0 here, never actually transferred to
        mollusk_svm_programs_token::token::keyed_account(),
        mollusk_svm_programs_token::associated_token::keyed_account(),
        system_program_keyed_account(),
    ];

    ctx.mollusk.process_and_validate_instruction(&transact_ix, &accounts, &[Check::success()]);
}

#[test]
fn bench_transact_spl_deposit_ata_exists() {
    run_bench_transact_spl_deposit(true);
}

#[test]
fn bench_transact_spl_deposit_ata_missing() {
    run_bench_transact_spl_deposit(false);
}