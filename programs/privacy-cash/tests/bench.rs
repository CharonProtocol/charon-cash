mod common;

use mollusk_svm::{Mollusk, result::Check};

use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction,
    account::Account,
    rent::Rent
};
use common::{
    prover::{DepositProofToSubmit, ProofInput, prove, deposit_artifacts_to_submit },
    utils::{get_ext_data_hash, ExtData, calculate_deposit_fee, calculate_withdrawal_fee},
    constants::{DEPOSIT_FEE_RATE, FEE_ERROR_MARGIN, FEE_RECIPIENT_ACCOUNT, FIELD_SIZE_DECIMAL, WITHDRAW_FEE_RATE, DEFAULT_HEIGHT},
    utxo::Utxo,
    merkle_tree::MerkleTree
};
use solana_transaction::AccountMeta;

use std::{path::PathBuf, str::FromStr};
use num_bigint::{BigInt, BigUint};
use privacy_cash::{
    constants, instructions::{IntiailizeTreeTokenAccountParams, PrivacyCashInstructions},
    merkle_tree::MerkleTree as OnChainMerkleTree,
    state::{
        GlobalConfig, MerkleTreeAccount, transact::{ExtDataMinified, Proof},
    },
};

use light_hasher::{Poseidon, zero_bytes::poseidon::ZERO_BYTES};
use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_program::pubkey::Pubkey;
use spl_associated_token_account::get_associated_token_address;
use spl_token::state::{Mint, Account as SplTokenAccount, AccountState};
use solana_program_pack::Pack;
use solana_sdk::program_option::COption;

const PROGRAM_ID: &str = "Dz8MTy797RkN55JhgLCuKQ3sWDs4YHBipEoThADFFf58";

pub fn create_ext_data_minified(ext_data: &ExtData) -> ExtDataMinified {
    ExtDataMinified { ext_amount: ext_data.ext_amount, fee: ext_data.fee }
}

pub fn format_proof(proof: DepositProofToSubmit) -> Proof {
    Proof {
        proof_a: proof.proof_a.try_into().expect("proof_a must be 32 bytes"),
        proof_b: proof.proof_b.try_into().expect("proof_b must be 64 bytes"),
        proof_c: proof.proof_c.try_into().expect("proof_c must be 32 bytes"),
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

    std::env::set_var("RUST_LOG", "off");
    std::env::set_var(
        "SBF_OUT_DIR",
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy"),
    );
    let mut mollusk = Mollusk::new(&program_id, "privacy_cash");

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
        program_id,
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

fn funded_tree_token_account(authority: Pubkey, bump: u8, extra_lamports: u64) -> Account {
    let mut acct = tree_token_account_account(authority, bump);
    acct.lamports += extra_lamports;
    acct
}

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
    account_with_data(spl_token::ID, data.to_vec())
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
    account_with_data(spl_token::ID, data.to_vec())
}

fn field_size() -> BigInt {
    BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap()
}

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

fn key_base_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("artifacts").join("circuits").join("transaction2")
}

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
    OnChainMerkleTree::append_pair::<Poseidon>(&[commitment0, commitment1], &mut on_chain_tree)
        .unwrap();

    (deposited, on_chain_tree)
}

// ============================================================================
// Reporting: Pinocchio CU (measured) vs Anchor CU (hardcoded from SolScan)
// ============================================================================

enum Verify {
    Success,
    SuccessAndAccountData { pubkey: Pubkey, expected_data: Vec<u8> },
}

struct Entry {
    name: &'static str,
    instruction: Instruction,
    accounts: Vec<(Pubkey, Account)>,
    verify: Verify,
    anchor_cu: u64,
}

fn run_and_report(mollusk: &Mollusk, entries: Vec<Entry>) {
    println!(
        "\n{:<42} {:>14} {:>12} {:>28}",
        "scenario", "Pinocchio CU", "Anchor CU", "improvement"
    );
    println!("{}", "-".repeat(100));

    for entry in &entries {
        let checks = match &entry.verify {
            Verify::Success => vec![Check::success()],
            Verify::SuccessAndAccountData { pubkey, expected_data } => vec![
                Check::success(),
                Check::account(pubkey).data(expected_data).build(),
            ],
        };

        let result = if entry.name.starts_with("transact") {
            let r = mollusk.process_instruction(&entry.instruction, &entry.accounts);
            println!(
                "DIAG {} program_result={:?} cu={} raw={:?}",
                entry.name, r.program_result, r.compute_units_consumed, r.raw_result
            );
            if !r.program_result.is_ok() {
                panic!(
                    "{} failed: {:?} cu={}",
                    entry.name, r.program_result, r.compute_units_consumed
                );
            }
            r
        } else {
            mollusk.process_and_validate_instruction(&entry.instruction, &entry.accounts, &checks)
        };
        let pinocchio_cu = result.compute_units_consumed;
        let anchor_cu = entry.anchor_cu;

        if entry.name == "transact_deposit_first" {
            assert!(
                pinocchio_cu < 250_000,
                "CU gate: compressed transact {} CU exceeds 250k — abort Swap, use 3-tx",
                pinocchio_cu
            );
            let swap_est = pinocchio_cu.saturating_mul(2).saturating_add(400_000);
            assert!(
                swap_est < 1_200_000,
                "CU gate: estimated swap {} CU exceeds 1.2M headroom under 1.4M",
                swap_est
            );
            println!(
                "CU gate transact_deposit_first={} estimated_swap={}",
                pinocchio_cu, swap_est
            );
        }

        let improvement = if anchor_cu > 0 {
            let saved = anchor_cu as i64 - pinocchio_cu as i64;
            let pct = saved as f64 / anchor_cu as f64 * 100.0;
            format!("{:+} CUs, {:+.1}%", saved, pct)
        } else {
            "n/a".to_string()
        };

        println!(
            "{:<42} {:>14} {:>12} {:>28}",
            entry.name, pinocchio_cu, anchor_cu, improvement
        );
    }
    println!();
}

// ============================================================================
// Scenario builders
// ============================================================================

fn scenario_initialize(ctx: &BenchContext) -> Entry {
    let instruction = build_initialize_ix(
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
    Entry { name: "initialize", instruction, accounts, verify: Verify::Success, anchor_cu: 29917 }
}

fn scenario_update_global_config(
    ctx: &BenchContext,
    deposit_fee_rate: Option<u64>, withdrawal_fee_rate: Option<u64>, fee_error_margin: Option<u64>,
    name: &'static str,
    anchor_cu: u64,
) -> Entry {
    let instruction = build_update_global_config_ix(
        ctx.program_id, ctx.global_config, ctx.authority.pubkey(),
        deposit_fee_rate, withdrawal_fee_rate, fee_error_margin,
    );
    let accounts = vec![
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, 0, 25, 500)),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];
    Entry { name, instruction, accounts, verify: Verify::Success, anchor_cu }
}

fn scenario_update_deposit_limit(ctx: &BenchContext) -> Entry {
    let new_limit: u64 = 5_000_000_000_000;

    let before = genesis_tree_account(ctx.authority.pubkey(), ctx.tree_bump);
    let mut expected_tree = *bytemuck::from_bytes::<MerkleTreeAccount>(&before.data[..MerkleTreeAccount::LEN]);
    expected_tree.max_deposit_amount = new_limit;
    let expected_data = bytemuck::bytes_of(&expected_tree).to_vec();

    let instruction = build_update_deposit_limit_ix(ctx.program_id, ctx.tree_account, ctx.authority.pubkey(), new_limit, ctx.tree_bump);
    let accounts = vec![
        (ctx.tree_account, before),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];

    Entry {
        name: "update_deposit_limit",
        instruction,
        accounts,
        verify: Verify::SuccessAndAccountData { pubkey: ctx.tree_account, expected_data },
        anchor_cu: 3461,
    }
}

fn scenario_update_deposit_limit_for_spl(ctx: &BenchContext) -> Entry {
    let mint = Pubkey::new_unique();
    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);
    let new_limit: u64 = 7_000_000_000_000;

    let before = genesis_tree_account(ctx.authority.pubkey(), spl_tree_bump);
    let mut expected_tree = *bytemuck::from_bytes::<MerkleTreeAccount>(&before.data[..MerkleTreeAccount::LEN]);
    expected_tree.max_deposit_amount = new_limit;
    let expected_data = bytemuck::bytes_of(&expected_tree).to_vec();

    let instruction = build_update_deposit_limit_for_spl_ix(ctx.program_id, spl_tree_account, mint, ctx.authority.pubkey(), new_limit, spl_tree_bump);
    let accounts = vec![
        (spl_tree_account, before),
        (mint, mint_account(ctx.authority.pubkey())),
        (ctx.authority.pubkey(), funded_account(LAMPORTS_PER_SOL)),
    ];

    Entry {
        name: "update_deposit_limit_for_spl",
        instruction,
        accounts,
        verify: Verify::SuccessAndAccountData { pubkey: spl_tree_account, expected_data },
        anchor_cu: 0,
    }
}

fn scenario_initialize_tree_account_for_spl_token(ctx: &BenchContext) -> Entry {
    let mint = Pubkey::new_unique();
    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);

    let instruction = build_initialize_for_spl_ix(
        ctx.program_id, ctx.authority.pubkey(), spl_tree_account, mint, ctx.global_config, spl_tree_bump, 50_000_000_000_000,
    );
    let accounts = vec![
        (spl_tree_account, uninitialized_account()),
        (mint, mint_account(ctx.authority.pubkey())),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.authority.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];
    Entry { name: "initialize_tree_account_for_spl_token", instruction, accounts, verify: Verify::Success, anchor_cu: 0 }
}

fn scenario_transact_deposit_first(ctx: &BenchContext) -> Entry {
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
        deposit_outputs[0].get_commitment().expect("failed to compute output commitment"),
        deposit_outputs[1].get_commitment().expect("failed to compute output commitment"),
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

    let deposit_proof_result = prove(&deposit_input, &key_base_path()).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap());

    let deposit_nullifiers = find_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);

    let instruction = build_transact_ix(
        ctx.program_id, &deposit_proof_to_submit, &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1, &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0, deposit_nullifiers.bump1,
        ctx.tree_account, deposit_nullifiers.nullifier0, deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0, deposit_cross_check_nullifiers.1,
        ctx.tree_token_account, ctx.global_config, ctx.recipient.pubkey(), FEE_RECIPIENT_ACCOUNT, ctx.random_user.pubkey(),
    );

    let accounts = vec![
        (ctx.tree_account, genesis_tree_account(ctx.authority.pubkey(), ctx.tree_bump)),
        (deposit_nullifiers.nullifier0, uninitialized_account()),
        (deposit_nullifiers.nullifier1, uninitialized_account()),
        (deposit_cross_check_nullifiers.0, uninitialized_account()),
        (deposit_cross_check_nullifiers.1, uninitialized_account()),
        (ctx.tree_token_account, tree_token_account_account(ctx.authority.pubkey(), ctx.tree_token_bump)),
        (ctx.global_config, global_config_account(ctx.authority.pubkey(), ctx.global_config_bump, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_ERROR_MARGIN)),
        (ctx.recipient.pubkey(), uninitialized_account()),
        (FEE_RECIPIENT_ACCOUNT, uninitialized_account()),
        (ctx.random_user.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        system_program_keyed_account(),
    ];

    Entry { name: "transact_deposit_first", instruction, accounts, verify: Verify::Success, anchor_cu: 246876 }
}

fn scenario_transact_withdraw(ctx: &BenchContext) -> Entry {
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

    let output_index = 0usize;
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

    let instruction = build_transact_ix(
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

    Entry { name: "transact_withdraw_partial", instruction, accounts, verify: Verify::Success, anchor_cu: 246876 }
}

fn scenario_transact_spl_deposit(ctx: &BenchContext, tree_ata_exists: bool) -> Entry {
    let mint = Pubkey::new_unique();

    let deposit_amount: u64 = 100;
    let deposit_fee_u64 = calculate_deposit_fee(deposit_amount, DEPOSIT_FEE_RATE);

    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &mint);
    let fee_recipient_ata = get_associated_token_address(&ctx.fee_recipient.pubkey(), &mint);
    let spl_tree_ata = get_associated_token_address(&ctx.global_config, &mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: deposit_fee_u64,
        fee_recipient: fee_recipient_ata.to_bytes(),
        mint_address: mint.to_bytes(),
    };

    let deposit_inputs = [Utxo::with_mint(0, mint), Utxo::with_mint(0, mint)];

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let public_amount_number = compute_public_amount(&ext_amount, deposit_fee_u64);

    let mut spl_merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());
    let output_index = spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(public_amount_number.clone().try_into().expect("public amount should fit in u64"), mint)
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
        public_amount: public_amount_number,
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

    let deposit_proof_result = prove(&deposit_input, &key_base_path()).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap());

    let deposit_nullifiers = find_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&ctx.program_id, &deposit_proof_to_submit);

    let (spl_tree_account, spl_tree_bump) = Pubkey::find_program_address(&[b"merkle_tree", mint.as_ref()], &ctx.program_id);

    let instruction = build_transact_spl_ix(
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
        (recipient_ata, uninitialized_account()),
        (spl_tree_ata, spl_tree_ata_account),
        (fee_recipient_ata, uninitialized_account()),
        mollusk_svm_programs_token::token::keyed_account(),
        mollusk_svm_programs_token::associated_token::keyed_account(),
        system_program_keyed_account(),
    ];

    Entry {
        name: if tree_ata_exists { "transact_spl_deposit_ata_exists" } else { "transact_spl_deposit_ata_missing" },
        instruction,
        accounts,
        verify: Verify::Success,
        anchor_cu: 0,
    }
}

fn native_mint_account() -> Account {
    let mint = Mint {
        mint_authority: COption::None,
        supply: 0,
        decimals: 9,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    account_with_data(spl_token::ID, data)
}

fn native_token_account(owner: Pubkey) -> Account {
    let rent = Rent::default().minimum_balance(SplTokenAccount::LEN);
    let acct = SplTokenAccount {
        mint: spl_token::native_mint::ID,
        owner,
        amount: 0,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::Some(rent),
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; SplTokenAccount::LEN];
    SplTokenAccount::pack(acct, &mut data).unwrap();
    Account {
        lamports: rent,
        data,
        owner: spl_token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn wrap_sol_set_lamports_balances() {
    let ctx = setup();
    let wrap_amount = LAMPORTS_PER_SOL;
    let vault = funded_tree_token_account(
        ctx.authority.pubkey(),
        ctx.tree_token_bump,
        wrap_amount,
    );
    let vault_before = vault.lamports;
    let pool_wsol_key = Pubkey::new_unique();
    let pool_wsol = native_token_account(ctx.global_config);
    let pool_before = pool_wsol.lamports;
    let native_mint = spl_token::native_mint::ID;

    let mut data = vec![PrivacyCashInstructions::WrapSol as u8];
    data.extend_from_slice(&wrap_amount.to_le_bytes());

    let instruction = Instruction {
        program_id: ctx.program_id,
        accounts: vec![
            AccountMeta::new(ctx.tree_token_account, false),
            AccountMeta::new(pool_wsol_key, false),
            AccountMeta::new_readonly(native_mint, false),
            AccountMeta::new(ctx.random_user.pubkey(), true),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    };

    let accounts = vec![
        (ctx.tree_token_account, vault),
        (pool_wsol_key, pool_wsol),
        (native_mint, native_mint_account()),
        (ctx.random_user.pubkey(), funded_account(10 * LAMPORTS_PER_SOL)),
        mollusk_svm_programs_token::token::keyed_account(),
        system_program_keyed_account(),
    ];

    let amount_le = wrap_amount.to_le_bytes();
    let sync_native = Instruction {
        program_id: spl_token::ID,
        accounts: vec![AccountMeta::new(pool_wsol_key, false)],
        data: vec![17],
    };

    ctx.mollusk.process_and_validate_instruction_chain(
        &[
            (
                &instruction,
                &[
                    Check::success(),
                    Check::account(&ctx.tree_token_account)
                        .lamports(vault_before - wrap_amount)
                        .owner(&ctx.program_id)
                        .build(),
                    Check::account(&pool_wsol_key)
                        .lamports(pool_before + wrap_amount)
                        .owner(&spl_token::ID)
                        .build(),
                ],
            ),
            (
                &sync_native,
                &[
                    Check::success(),
                    Check::account(&pool_wsol_key)
                        .lamports(pool_before + wrap_amount)
                        .data_slice(64, &amount_le)
                        .build(),
                ],
            ),
        ],
        &accounts,
    );
}

#[test]
fn bench_all() {
    let ctx = setup();

    run_and_report(&ctx.mollusk, vec![
        scenario_initialize(&ctx),
        scenario_update_global_config(&ctx, None, Some(50), None, "update_global_config_one_field", 3659),
        scenario_update_deposit_limit(&ctx),
        scenario_update_deposit_limit_for_spl(&ctx),
        scenario_initialize_tree_account_for_spl_token(&ctx),
        scenario_transact_deposit_first(&ctx),
        scenario_transact_withdraw(&ctx),
        scenario_transact_spl_deposit(&ctx, true),
        scenario_transact_spl_deposit(&ctx, false),
    ]);
}