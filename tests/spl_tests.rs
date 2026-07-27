mod common;
use ark_ff::field;
use borsh::BorshDeserialize;
use bytemuck::{Pod, Zeroable};
use common::{
    constants::{
        DEFAULT_HEIGHT, DEPOSIT_FEE_RATE, FEE_ERROR_MARGIN, FEE_RECIPIENT_ACCOUNT,
        FIELD_SIZE_DECIMAL, ROOT_HISTORY_SIZE, SOL_ADDRESS, WITHDRAW_FEE_RATE,
    },
    merkle_tree::MerkleTree,
    prover::{
        deposit_artifacts_to_submit, prove, DepositProofArtifacts, DepositProofToSubmit, ProofInput,
    },
    test_alt::{
        create_global_test_alt, create_versioned_tx_with_alt, get_global_test_alt,
        get_test_protocol_addresses, get_test_protocol_addresses_with_mint, reset_global_test_alt,
    },
    utils::{get_ext_data_hash, ExtData},
    utxo::Utxo,
};
use core::panic;
use ethers::{
    core::{
        k256::schnorr::CryptoRngCore,
        rand::{thread_rng, RngCore},
    },
    utils::hex,
};
use light_hasher::zero_bytes::poseidon::ZERO_BYTES;
use litesvm::LiteSVM;
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo, TOKEN_ID};
use num_bigint::{BigInt, BigUint, ToBigUint};
use num_traits::ToPrimitive;
use privacy_cash::{
    instructions::{self, IntiailizeTreeTokenAccountParams, PrivacyCashInstructions},
    state::{
        transact::{ExtDataMinified, Proof, TransactArgs},
        MerkleTreeAccount,
    },
};
use solana_address::Address;
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_program::{example_mocks::solana_sdk::system_instruction, pubkey::Pubkey};
use solana_program_pack::Pack;
use solana_sdk::{
    bs58,
    instruction::Instruction,
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
};
use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_transaction::{AccountMeta, Transaction};
use spl_associated_token_account::get_associated_token_address;
use std::{
    ops::{Add, Rem, Sub},
    path::PathBuf,
    str::FromStr,
};
use wasmer::sys::global;

use crate::common::utxo::default_mint_address;

const PROGRAM_ID: &str = "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV";
const DEFAULT_ZERO: [u8; 32] = ZERO_BYTES[0]; // The default value of elements for initializing a tree

pub fn generate_random_nullifier() -> [u8; 32] {
    let mut nullifier = [0u8; 32];
    thread_rng().fill_bytes(&mut nullifier);
    nullifier
}

pub fn create_ext_data_minified(ext_data: &ExtData) -> ExtDataMinified {
    ExtDataMinified {
        ext_amount: ext_data.ext_amount,
        fee: ext_data.fee,
    }
}

/// Calculates the protocol fee for a given amount using basis points.
///
/// The fee is computed as:
/// `(amount * fee_rate) / 10_000`
///
/// where `fee_rate` is expressed in basis points (bps).
/// For example:
/// - 100 bps = 1%
/// - 50 bps = 0.5%
pub fn calculate_fee(amount: u64, fee_rate: u16) -> u64 {
    (amount * fee_rate as u64) / 10_000
}

/// Calculates the deposit fee using the protocol's configured
/// deposit fee rate.
pub fn calculate_deposit_fee(amount: u64) -> u64 {
    calculate_fee(amount, DEPOSIT_FEE_RATE)
}

/// Calculates the withdrawal fee using the protocol's configured
/// withdrawal fee rate.
pub fn calculate_withdrawal_fee(amount: u64) -> u64 {
    calculate_fee(amount, WITHDRAW_FEE_RATE)
}

/// Converts a 256-bit integer into a 32-byte big-endian array.
///
/// This helper is primarily used when serializing public inputs for
/// Groth16 proofs, where values are expected to be represented as
/// 32-byte big-endian integers.
pub fn bn_to_bytes(value: u128) -> [u8; 32] {
    let mut bytes = [0u8; 32];

    // Store the integer in big-endian format. The upper bytes remain
    // zero for values smaller than 256 bits.
    bytes[16..].copy_from_slice(&value.to_be_bytes());

    bytes
}

// Helper to turn the DepositProofToSubmit struct into the Proof struct we use in next 2 functions
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
    let (nullifier0, bump0) =
        Pubkey::find_program_address(&[b"nullifier0", &proof.input_nullifiers[0]], program_id);

    let (nullifier1, bump1) =
        Pubkey::find_program_address(&[b"nullifier1", &proof.input_nullifiers[1]], program_id);

    NullifierPdas {
        nullifier0,
        nullifier1,
        bump0,
        bump1,
    }
}

pub fn find_cross_check_nullifier_pdas(program_id: &Pubkey, proof: &Proof) -> (Pubkey, Pubkey) {
    let (nullifier2_pda, _) =
        Pubkey::find_program_address(&[b"nullifier0", &proof.input_nullifiers[1]], program_id);

    let (nullifier3_pda, _) =
        Pubkey::find_program_address(&[b"nullifier1", &proof.input_nullifiers[0]], program_id);

    (nullifier2_pda, nullifier3_pda)
}

pub struct TestContextSpl {
    pub svm: LiteSVM,

    pub authority: Keypair, // program authority
    pub funding_account: Keypair,
    pub recipient: Keypair,
    pub fee_recipient: Keypair,
    pub random_user: Keypair, // Signs the transactions
    pub attacker: Keypair,

    pub tree_account: Pubkey,
    pub spl_tree_account: Pubkey,
    pub tree_token_account: Pubkey,     // The Pool
    pub spl_tree_token_account: Pubkey, // THE USDC Pool
    pub global_config: Pubkey,

    // token accounts
    pub spl_token_mint: Pubkey, // USDC

    pub fee_recipient_ata: Pubkey,
    pub random_user_ata: Pubkey,
    pub attacker_ata: Pubkey,
    pub recipient_ata: Pubkey,

    pub tree_bump: u8,
    pub tree_token_bump: u8,
    pub spl_tree_bump: u8,

    pub sol_merkle_tree: MerkleTree, // Indexer
    pub spl_merkle_tree: MerkleTree, // Indexer
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct InitiailizeParams {
    pub tree_account_bump: u8,
    pub tree_token_account_bump: u8,
    pub global_config_bump: u8,
}

pub fn build_initialize_ix(
    program_id: Pubkey,
    authority: Pubkey,
    tree_account: Pubkey,
    tree_token_account: Pubkey,
    global_config: Pubkey,
    tree_account_bump: u8,
    tree_token_account_bump: u8,
    global_config_bump: u8,
) -> Instruction {
    let params = InitiailizeParams {
        tree_account_bump,
        tree_token_account_bump,
        global_config_bump,
    };

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
        data,
    }
}

pub fn build_initialize_for_spl_ix(
    program_id: Pubkey,
    authority: Pubkey,
    spl_tree_account: Pubkey,
    mint: Pubkey,
    global_config: Pubkey,
    tree_account_bump: u8,
    max_deposit_amount: u64,
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

pub fn build_transact_ix(
    program_id: Pubkey,

    proof: &Proof,
    ext_data_minified: &ExtDataMinified,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    nullifier_bump0: u8,
    nullifier_bump1: u8,

    tree_account: Pubkey,
    nullifier0: Pubkey,
    nullifier1: Pubkey,
    nullifier2: Pubkey,
    nullifier3: Pubkey,
    tree_token_account: Pubkey,
    global_config: Pubkey,
    recipient: Pubkey,
    fee_recipient: Pubkey,
    signer: Pubkey,
) -> Instruction {
    let mut data = Vec::new();

    // Instruction discriminator
    data.push(PrivacyCashInstructions::Transact as u8);

    // Fixed-size PODs
    data.extend_from_slice(bytemuck::bytes_of(proof));
    data.extend_from_slice(bytemuck::bytes_of(ext_data_minified));

    // encrypted_output1
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);

    // encrypted_output2
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);

    // bumps
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

pub fn build_transact_spl_ix(
    program_id: Pubkey,

    proof: &Proof,
    ext_data_minified: &ExtDataMinified,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    nullifier_bump0: u8,
    nullifier_bump1: u8,

    spl_tree_account: Pubkey,
    nullifier0: Pubkey,
    nullifier1: Pubkey,
    nullifier2: Pubkey,
    nullifier3: Pubkey,
    global_config: Pubkey,
    signer: Pubkey,
    mint: Pubkey,
    signer_ata: Pubkey,
    recipient: Pubkey,
    recipient_ata: Pubkey,
    spl_tree_ata: Pubkey,
    fee_recipient_ata: Pubkey,
) -> Instruction {
    let mut data = Vec::new();

    // Instruction discriminator
    data.push(PrivacyCashInstructions::TransactSpl as u8);

    // Fixed-size PODs
    data.extend_from_slice(bytemuck::bytes_of(proof));
    data.extend_from_slice(bytemuck::bytes_of(ext_data_minified));

    // encrypted_output1
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);

    // encrypted_output2
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);

    // bumps
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
            AccountMeta::new_readonly(TOKEN_ID, false),
            AccountMeta::new_readonly(spl_associated_token_account::ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

// Helper function, needed right after ALA lookups otherwise it won't work
fn advance_one_slot(svm: &mut LiteSVM) {
    let clock: Clock = svm.get_sysvar();
    svm.warp_to_slot(clock.slot + 1);
    svm.expire_blockhash();
}

fn get_token_account_state(svm: &mut LiteSVM, account: &Address) -> spl_token::state::Account {
    let account_raw = svm
        .get_account(account)
        .expect("Could not get given Account");

    let account_state =
        spl_token::state::Account::unpack(&account_raw.data).expect("Expected Raw Account Data");

    account_state
}

pub fn setup() -> TestContextSpl {
    reset_global_test_alt();
    let mut svm = LiteSVM::new();

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();

    // Load the Anchor program into LiteSVM.
    // Replace the path with your actual built .so.
    svm.add_program(
        program_id,
        include_bytes!("../target/deploy/privacy_cash.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let funding_account = Keypair::new();
    let recipient = Keypair::new();
    let fee_recipient = Keypair::new();
    let random_user = Keypair::new();
    let attacker = Keypair::new();

    let sol_merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());
    let spl_merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());

    let (tree_account, tree_bump) = Pubkey::find_program_address(&[b"merkle_tree"], &program_id);

    let (tree_token_account, tree_token_bump) =
        Pubkey::find_program_address(&[b"tree_token"], &program_id);

    let (global_config, global_config_bump) =
        Pubkey::find_program_address(&[b"global_config"], &program_id);

    // Fund the funding account.
    svm.airdrop(&funding_account.pubkey(), 1_000 * LAMPORTS_PER_SOL)
        .unwrap();

    let balance = svm.get_balance(&funding_account.pubkey()).unwrap();
    assert!(balance > 0);

    // Transfer lamports to authority so it can pay fees / rent.
    let transfer_ix = system_instruction::transfer(
        &funding_account.pubkey(),
        &authority.pubkey(),
        100 * LAMPORTS_PER_SOL,
    );

    let transfer_tx = Transaction::new_signed_with_payer(
        &[transfer_ix],
        Some(&funding_account.pubkey()),
        &[&funding_account],
        svm.latest_blockhash(),
    );

    svm.send_transaction(transfer_tx).unwrap();

    let balance = svm.get_balance(&authority.pubkey()).unwrap();
    assert!(balance > 0);

    // Initialize the program.
    let initialize_ix = build_initialize_ix(
        program_id,
        authority.pubkey(),
        tree_account,
        tree_token_account,
        global_config,
        tree_bump,
        tree_token_bump,
        global_config_bump,
    );

    let initialize_tx = Transaction::new_signed_with_payer(
        &[initialize_ix],
        Some(&authority.pubkey()),
        &[&authority],
        svm.latest_blockhash(),
    );

    svm.send_transaction(initialize_tx).unwrap();

    // Fund the tree token PDA after initialization.
    svm.airdrop(&tree_token_account, 2 * LAMPORTS_PER_SOL)
        .unwrap();

    // Verify the initialized tree account.
    let account = svm
        .get_account(&tree_account)
        .expect("tree account missing");
    let tree_state = bytemuck::from_bytes::<MerkleTreeAccount>(&account.data);

    assert_eq!(tree_state.authority, authority.pubkey().to_bytes());
    assert_eq!(tree_state.next_index, 0);
    assert_eq!(tree_state.root_index, 0);
    assert_eq!(tree_state.root_history.len(), ROOT_HISTORY_SIZE);

    // THIS SECTION IS RELATED TO THE BEFOREEACH PART, NO NEED TO ADAPT THAT SEPARATELY
    svm.airdrop(&recipient.pubkey(), LAMPORTS_PER_SOL / 2)
        .unwrap();
    svm.airdrop(&fee_recipient.pubkey(), LAMPORTS_PER_SOL / 2)
        .unwrap();
    svm.airdrop(&random_user.pubkey(), LAMPORTS_PER_SOL)
        .unwrap();
    svm.airdrop(&attacker.pubkey(), LAMPORTS_PER_SOL).unwrap();

    assert!(svm.get_balance(&recipient.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&fee_recipient.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&random_user.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&attacker.pubkey()).unwrap() > 0);
    // --------------------------------------------------------------------------------

    // Additional Token Accounts for spl_tests
    let spl_token_mint = CreateMint::new(&mut svm, &authority)
        .authority(&authority.pubkey())
        .freeze_authority(&authority.pubkey())
        .decimals(6)
        .send()
        .expect("USDC Mint Creation Failed");

    let (spl_tree_account, spl_tree_bump) = Address::derive_program_address(
        &[b"merkle_tree", spl_token_mint.as_array()],
        &Address::from_str_const(PROGRAM_ID),
    )
    .expect("Spl Tree Account For USDC transactions");

    // Initialise SPL tree
    let initialize_spl_tree_ix = build_initialize_for_spl_ix(
        program_id,
        authority.pubkey(),
        spl_tree_account,
        spl_token_mint,
        global_config,
        spl_tree_bump,
        50_000_000_000_000,
    );

    let initialize_spl_tree_tx = Transaction::new_signed_with_payer(
        &[initialize_spl_tree_ix],
        Some(&authority.pubkey()),
        &[&authority],
        svm.latest_blockhash(),
    );

    svm.send_transaction(initialize_spl_tree_tx).unwrap();

    // Verify the initialized tree account.
    let spl_tree_account_raw = svm
        .get_account(&spl_tree_account)
        .expect("tree account missing");
    let spl_tree_state = bytemuck::from_bytes::<MerkleTreeAccount>(&spl_tree_account_raw.data);

    assert_eq!(spl_tree_state.authority, authority.pubkey().to_bytes());
    assert_eq!(spl_tree_state.next_index, 0);
    assert_eq!(spl_tree_state.root_index, 0);
    assert_eq!(spl_tree_state.root_history.len(), ROOT_HISTORY_SIZE);

    let fee_recipient_ata =
        CreateAssociatedTokenAccount::new(&mut svm, &fee_recipient, &spl_token_mint)
            .send()
            .expect("Fee Recipient Could Not be initialised");
    let random_user_ata =
        CreateAssociatedTokenAccount::new(&mut svm, &random_user, &spl_token_mint)
            .send()
            .expect("Fee Recipient Could Not be initialised");
    let attacker_ata = CreateAssociatedTokenAccount::new(&mut svm, &attacker, &spl_token_mint)
        .send()
        .expect("Fee Recipient Could Not be initialised");

    let recipient_ata = CreateAssociatedTokenAccount::new(&mut svm, &recipient, &spl_token_mint)
        .send()
        .expect("Fee Recipient Could Not be initialised");

    let spl_tree_token_account = get_associated_token_address(&global_config, &spl_token_mint);

    let mint_amount = 100_000_000_000_000;
    MintTo::new(
        &mut svm,
        &authority,
        &spl_token_mint,
        &random_user_ata,
        mint_amount,
    )
    .send()
    .expect("Token Could Not Be Minted to Random User Ata");

    MintTo::new(
        &mut svm,
        &authority,
        &spl_token_mint,
        &attacker_ata,
        mint_amount,
    )
    .send()
    .expect("Token Could Not Be Minted to Attacker  Ata");

    let random_user_ata_state = get_token_account_state(&mut svm, &random_user_ata);

    assert_eq!(random_user_ata_state.amount, mint_amount);

    let attacker_ata_state = get_token_account_state(&mut svm, &attacker_ata);

    assert_eq!(attacker_ata_state.amount, mint_amount);

    TestContextSpl {
        svm,
        authority,
        funding_account,
        recipient,
        fee_recipient,
        random_user,
        attacker,
        tree_account,
        tree_token_account,
        global_config,
        tree_bump,
        tree_token_bump,
        sol_merkle_tree,
        spl_merkle_tree,
        spl_token_mint,
        spl_tree_account,
        spl_tree_bump,
        fee_recipient_ata,
        attacker_ata,
        random_user_ata,
        spl_tree_token_account,
        recipient_ata,
    }
}

#[test]
fn transact_spl_deposit_running_correctly() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 100 - calculated_deposit_fee);
}

#[test]
fn deposit_sol_withdraw_usdc() {
    let mut ctx = setup();

    // ============================================
    // PART 1: SOL DEPOSIT
    // ============================================
    let deposit_amount = 20000;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient.pubkey().to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let deposit_inputs = [Utxo::empty(), Utxo::empty()];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.sol_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_index(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            output_index,
        ),
        Utxo::new(0),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.sol_merkle_tree.levels],
        vec![[0u8; 32]; ctx.sol_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.sol_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient.pubkey(),
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    let sol_tree_token_balance_before = ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let fee_recipient_balance_before = ctx.svm.get_balance(&ctx.fee_recipient.pubkey()).unwrap();
    let recipient_balance_before = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_before = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        ctx.recipient.pubkey(),
        ctx.fee_recipient.pubkey(),
        ctx.random_user.pubkey(),
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our Local Sol Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.sol_merkle_tree.insert(commitment);
    }

    // Check Balances
    let sol_tree_token_balance_after = ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let fee_recipient_balance_after = ctx.svm.get_balance(&ctx.fee_recipient.pubkey()).unwrap();
    let recipient_balance_after = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_after = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    // assert_eq!(
    //     sol_tree_token_balance_after - sol_tree_token_balance_before,
    //     public_amount_number.to_u64().unwrap()
    // );
    // assert_eq!(
    //     fee_recipient_balance_after,
    //     fee_recipient_balance_before + calculated_deposit_fee
    // );
    // assert_eq!(recipient_balance_after, recipient_balance_after);
    // assert_eq!(
    //     random_user_balance_after,
    //     random_user_balance_before - deposit_amount
    // );

    // ============================================
    // PART 2: SPL WITHDRAW
    // ============================================

    // Setup withdrawal amounts

    let withdraw_amount = 15000; // 0.015 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount =
        -BigInt::from(withdraw_amount) + BigInt::from(calculated_withdraw_fee);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(), // This belongs to the Sol Mint
        Utxo::empty(),
    ];

    let change_number = (deposit_outputs[0].amount
        - calculated_withdraw_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        + &field_size)
        % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.sol_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.sol_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    let result = ctx.svm.send_transaction(withdraw_versioned_tx);
    assert!(result.is_err());

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }
}

#[test]
fn spl_double_spend_fails() {
    let mut ctx = setup();

    // ============================================
    // PART 1: SOL DEPOSIT
    // ============================================
    let deposit_amount = 1000; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, deposit_amount);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    // ============================================
    // PART 2: FIRST WITHDRAW
    // ============================================

    // Setup withdrawal amounts

    let first_withdraw_amount = 1000; // 0.015 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_first_withdraw_fee = calculate_withdrawal_fee(first_withdraw_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let first_ext_amount =
        -BigInt::from(first_withdraw_amount) + BigInt::from(calculated_first_withdraw_fee);
    let first_withdraw_public_number =
        (&first_ext_amount - BigInt::from(calculated_first_withdraw_fee) + &field_size)
            % &field_size;

    let first_withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(first_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_first_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let first_withdraw_inputs = [
        deposit_outputs[0].clone(), // This belongs to the Sol Mint
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_outputs[0].amount
        - calculated_first_withdraw_fee
        - (first_withdraw_ext_data.ext_amount.abs() as u64)
        + &field_size)
        % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let first_withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut first_withdraw_input_merkle_path_indices = [0usize; 2];

    let mut first_withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in first_withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            first_withdraw_input_merkle_path_indices[index] = note_index as usize;
            first_withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let first_withdraw_input_nullifiers = [
        first_withdraw_inputs[0].get_nullifier().unwrap(),
        first_withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let first_withdraw_output_commitments = [
        first_withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        first_withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let first_withdraw_root = ctx.spl_merkle_tree.root();
    let first_withdraw_ext_data_hash = get_ext_data_hash(&first_withdraw_ext_data);

    let first_withdraw_input = ProofInput {
        root: first_withdraw_root,
        input_nullifier: first_withdraw_input_nullifiers,
        output_commitment: first_withdraw_output_commitments,
        public_amount: first_withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: first_withdraw_ext_data_hash,

        in_amount: first_withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: first_withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: first_withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: first_withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: first_withdraw_input_merkle_path_indices,
        in_path_elements: first_withdraw_input_merkle_path_elements,

        out_amount: first_withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: first_withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: first_withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let first_withdraw_proof_result = prove(&first_withdraw_input, &key_base_path).unwrap();

    let first_withdraw_artifacts =
        deposit_artifacts_to_submit(&first_withdraw_proof_result, false).unwrap();

    let first_withdraw_proof_to_submit = format_proof(first_withdraw_artifacts);

    let first_withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &first_withdraw_proof_to_submit,
    );
    let first_withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &first_withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let first_withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let first_withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &first_withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let first_transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &first_withdraw_proof_to_submit,
        &create_ext_data_minified(&first_withdraw_ext_data),
        &first_withdraw_ext_data.encrypted_output1,
        &first_withdraw_ext_data.encrypted_output2,
        first_withdraw_nullifiers.bump0,
        first_withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        first_withdraw_nullifiers.nullifier0,
        first_withdraw_nullifiers.nullifier1,
        first_withdraw_cross_check_nullifiers.0,
        first_withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let first_withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), first_transact_ix],
        &first_withdraw_lookup_table_address,
    );

    ctx.svm
        .send_transaction(first_withdraw_versioned_tx)
        .unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // ============================================
    // PART 3: SECOND WITHDRAW
    // ============================================

    let second_withdraw_amount = 1000; // 0.015 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_second_withdraw_fee = calculate_withdrawal_fee(second_withdraw_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let second_ext_amount =
        -BigInt::from(second_withdraw_amount) + BigInt::from(calculated_second_withdraw_fee);
    let second_withdraw_public_number =
        (&second_ext_amount - BigInt::from(calculated_second_withdraw_fee) + &field_size)
            % &field_size;

    let second_withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(second_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_second_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let second_withdraw_inputs = [
        Utxo::new_with_mint(0, ctx.spl_token_mint),
        deposit_outputs[0].clone(), // This belongs to the Sol Mint
    ];

    let change_number = (deposit_outputs[0].amount
        - calculated_second_withdraw_fee
        - (second_withdraw_ext_data.ext_amount.abs() as u64)
        + &field_size)
        % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let second_withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut second_withdraw_input_merkle_path_indices = [0usize; 2];

    let mut second_withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in second_withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            second_withdraw_input_merkle_path_indices[index] = note_index as usize;
            second_withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let second_withdraw_input_nullifiers = [
        second_withdraw_inputs[0].get_nullifier().unwrap(),
        second_withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let second_withdraw_output_commitments = [
        second_withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        second_withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let second_withdraw_root = ctx.spl_merkle_tree.root();
    let second_withdraw_ext_data_hash = get_ext_data_hash(&second_withdraw_ext_data);

    let second_withdraw_input = ProofInput {
        root: second_withdraw_root,
        input_nullifier: second_withdraw_input_nullifiers,
        output_commitment: second_withdraw_output_commitments,
        public_amount: second_withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: second_withdraw_ext_data_hash,

        in_amount: second_withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: second_withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: second_withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: second_withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: second_withdraw_input_merkle_path_indices,
        in_path_elements: second_withdraw_input_merkle_path_elements,

        out_amount: second_withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: second_withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: second_withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let second_withdraw_proof_result = prove(&second_withdraw_input, &key_base_path).unwrap();

    let second_withdraw_artifacts =
        deposit_artifacts_to_submit(&second_withdraw_proof_result, false).unwrap();

    let second_withdraw_proof_to_submit = format_proof(second_withdraw_artifacts);

    let second_withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &second_withdraw_proof_to_submit,
    );
    let second_withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &second_withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let second_withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let second_withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &second_withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let second_transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &second_withdraw_proof_to_submit,
        &create_ext_data_minified(&second_withdraw_ext_data),
        &second_withdraw_ext_data.encrypted_output1,
        &second_withdraw_ext_data.encrypted_output2,
        second_withdraw_nullifiers.bump0,
        second_withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        second_withdraw_nullifiers.nullifier0,
        second_withdraw_nullifiers.nullifier1,
        second_withdraw_cross_check_nullifiers.0,
        second_withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let second_withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), second_transact_ix],
        &second_withdraw_lookup_table_address,
    );

    let second_result = ctx.svm.send_transaction(second_withdraw_versioned_tx);
    assert!(
        second_result.is_err(),
        "double-spend should fail, but the transaction succeeded"
    );
}

#[test]
fn deposit_and_withdraw_tx_execute_for_correct_inputs() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, deposit_amount);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount = 80;
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        deposit_outputs[0].amount - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn deposit_and_withdraw_tx_execute_for_pda_recipient() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let (pda_recipient, _) =
        Address::find_program_address(&[b"RandomPDA"], &Address::from_str_const(PROGRAM_ID));

    let pda_recipient_ata =
        CreateAssociatedTokenAccount::new(&mut ctx.svm, &ctx.authority, &ctx.spl_token_mint)
            .owner(&pda_recipient)
            .send()
            .unwrap();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = pda_recipient_ata;

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 100);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount = 80;
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = pda_recipient_ata;

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);

    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        100 - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn spl_tx_deposit_and_withdraw_execute_for_pda_fee_recipient() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let (pda_fee_recipient, _) =
        Address::find_program_address(&[b"RandomPDA"], &Address::from_str_const(PROGRAM_ID));

    let pda_fee_recipient_ata =
        CreateAssociatedTokenAccount::new(&mut ctx.svm, &ctx.authority, &ctx.spl_token_mint)
            .owner(&pda_fee_recipient)
            .send()
            .unwrap();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = ctx.recipient_ata;

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: pda_fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &pda_fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        pda_fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 100);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &pda_fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount = 80;
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = ctx.recipient_ata;

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: pda_fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &pda_fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        pda_fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        100 - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &pda_fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn spl_attacker_cannot_frontrun_withdraw_tx() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let (pda_fee_recipient, _) =
        Address::find_program_address(&[b"RandomPDA"], &Address::from_str_const(PROGRAM_ID));

    let pda_fee_recipient_ata =
        CreateAssociatedTokenAccount::new(&mut ctx.svm, &ctx.authority, &ctx.spl_token_mint)
            .owner(&pda_fee_recipient)
            .send()
            .unwrap();

    let deposit_amount = 1000; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = ctx.recipient_ata;

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: pda_fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &pda_fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        pda_fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 1000);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &pda_fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount = 950;
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = ctx.recipient_ata;

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);

    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let legitimate_withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(&withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: pda_fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (legitimate_withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let legitimate_withdraw_ext_data_hash = get_ext_data_hash(&legitimate_withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: legitimate_withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    //----------------------------------------------------
    //  Attacker Frontrunning Withdraw Transaction
    //----------------------------------------------------

    // this acts as note recipient
    let attacker_recipient_ata = ctx.attacker_ata;

    let attacker_ext_data = ExtData {
        recipient: attacker_recipient_ata.to_bytes(), // Attacker's recipient ATA
        ext_amount: i64::try_from(&withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: pda_fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let attacker_withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &pda_fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let attacker_withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &attacker_withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let attacker_transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&attacker_ext_data),
        &attacker_ext_data.encrypted_output1,
        &attacker_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.attacker.pubkey(), // Attacker Signing the Transaction
        ctx.spl_token_mint,
        ctx.attacker_ata,      // Attacker Signing the Transaction
        ctx.attacker.pubkey(), // Attacker acting as recipient
        ctx.attacker_ata,      // Attacker's ata receiving the note
        ctx.spl_tree_token_account,
        pda_fee_recipient_ata,
    );

    let attacker_withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.attacker, // payer
        &[],           // additional signers
        &[modify_compute_units.clone(), attacker_transact_ix],
        &attacker_withdraw_lookup_table_address,
    );

    let attack_result = ctx.svm.send_transaction(attacker_withdraw_versioned_tx);
    if !attack_result.is_err() {
        panic!("Attacker FrontRun Attack Succeeded");
    }

    //----------------------------------------------------
    //  Attacker Frontrunning Failed
    //----------------------------------------------------

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &pda_fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&legitimate_withdraw_ext_data),
        &legitimate_withdraw_ext_data.encrypted_output1,
        &legitimate_withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        pda_fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = legitimate_withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        deposit_amount - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &pda_fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn spl_tree_ata_has_zero_amount_after_withdraw_full_amount_when_withdraw_fee_is_higher_than_deposit(
) {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_fee(deposit_amount, 35);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 100);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount: u64 = deposit_outputs[0].amount;
    let calculated_withdraw_fee = calculate_fee(withdraw_amount, 50);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        deposit_outputs[0].amount - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn spl_tree_ata_has_zero_amount_after_withdraw_full_amount_when_withdraw_fee_same_as_deposit_fee() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_fee(deposit_amount, 35);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, 100);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    let withdraw_amount: u64 = deposit_outputs[0].amount;
    let calculated_withdraw_fee = calculate_fee(withdraw_amount, 35);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        deposit_outputs[0].amount - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}

#[test]
fn spl_transaction_fails_for_wrong_data_hash() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let wrong_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: -i64::try_from(deposit_amount).unwrap(), // Sign reversed
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee, // Wrong Fees
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();

    //-------------------------------------
    //  Wrong Hash
    //----------------------------------------------
    let deposit_ext_data_hash = get_ext_data_hash(&wrong_ext_data);

    let raw_bytes = public_amount_number.to_bytes_be().1;

    let mut public_amount: [u8; 32] = [0; 32];

    if raw_bytes.len() <= 32 {
        let start_index = 32 - raw_bytes.len();
        public_amount[start_index..].copy_from_slice(&raw_bytes);
    } else {
        panic!("BigInt value is too large to fit in 32 bytes");
    }
    let deposit_proof_to_submit = Proof {
        proof_a: [1u8; 64],
        proof_b: [1u8; 128],
        proof_c: [1u8; 64],
        root: deposit_root,
        public_amount: public_amount,
        ext_data_hash: deposit_ext_data_hash,
        input_nullifiers: deposit_input_nullifiers,
        output_commitments: deposit_output_commitments,
    };

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("transaction should fail for wrong extDataHash");

    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0x6") || logs.contains("ExtDataHashMismatch"),
        "unexpected logs: {logs}"
    );
}

#[test]
fn spl_transaction_fails_for_invalid_root() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let raw_bytes = public_amount_number.to_bytes_be().1;

    let mut public_amount: [u8; 32] = [0; 32];

    if raw_bytes.len() <= 32 {
        let start_index = 32 - raw_bytes.len();
        public_amount[start_index..].copy_from_slice(&raw_bytes);
    } else {
        panic!("BigInt value is too large to fit in 32 bytes");
    }

    //-------------------------------------
    //  Wrong Root
    //----------------------------------------------
    let invalid_root = [123u8; 32];

    let deposit_proof_to_submit = Proof {
        proof_a: [1u8; 64],
        proof_b: [1u8; 128],
        proof_c: [1u8; 64],
        root: invalid_root,
        public_amount: public_amount,
        ext_data_hash: deposit_ext_data_hash,
        input_nullifiers: deposit_input_nullifiers,
        output_commitments: deposit_output_commitments,
    };

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("transaction should fail for unknown root");

    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0x5")
            || logs.contains("UnknownRoot")
            || logs.contains("Transaction simulation failed"),
        "unexpected logs: {logs}"
    );
}

#[test]
fn spl_transaction_fails_for_zero_root() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let raw_bytes = public_amount_number.to_bytes_be().1;

    let mut public_amount: [u8; 32] = [0; 32];

    if raw_bytes.len() <= 32 {
        let start_index = 32 - raw_bytes.len();
        public_amount[start_index..].copy_from_slice(&raw_bytes);
    } else {
        panic!("BigInt value is too large to fit in 32 bytes");
    }

    //-------------------------------------
    //  Wrong Root
    //----------------------------------------------
    let invalid_root = [0u8; 32];

    let deposit_proof_to_submit = Proof {
        proof_a: [1u8; 64],
        proof_b: [1u8; 128],
        proof_c: [1u8; 64],
        root: invalid_root,
        public_amount: public_amount,
        ext_data_hash: deposit_ext_data_hash,
        input_nullifiers: deposit_input_nullifiers,
        output_commitments: deposit_output_commitments,
    };

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("transaction should fail for unknown root");

    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0x5")
            || logs.contains("UnknownRoot")
            || logs.contains("Transaction simulation failed"),
        "unexpected logs: {logs}"
    );
}

#[test]
fn spl_transaction_fails_for_modified_mint() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let raw_bytes = public_amount_number.to_bytes_be().1;

    let mut public_amount: [u8; 32] = [0; 32];

    if raw_bytes.len() <= 32 {
        let start_index = 32 - raw_bytes.len();
        public_amount[start_index..].copy_from_slice(&raw_bytes);
    } else {
        panic!("BigInt value is too large to fit in 32 bytes");
    }

    //-------------------------------------
    //  Wrong Root
    //----------------------------------------------
    let invalid_root = [0u8; 32];

    let different_mint = CreateMint::new(&mut ctx.svm, &ctx.authority)
        .decimals(6)
        .send()
        .expect("Different Mint Could Not Be Created");

    let deposit_proof_to_submit = Proof {
        proof_a: [1u8; 64],
        proof_b: [1u8; 128],
        proof_c: [1u8; 64],
        root: invalid_root,
        public_amount: public_amount,
        ext_data_hash: deposit_ext_data_hash,
        input_nullifiers: deposit_input_nullifiers,
        output_commitments: deposit_output_commitments,
    };

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &different_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        different_mint, // Different Mint
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("transaction should fail for unknown root");

    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0xd")
            || logs.contains("InvalidTokenAccountMintAddress")
            || logs.contains("Transaction simulation failed"),
        "unexpected logs: {logs}"
    );
}

#[test]
fn transact_spl_can_execute_for_deposit_larger_the_sol_tree_max_limit() {
    let mut ctx = setup();

    let deposit_amount = 50_000_000_000_000; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state.amount,
        50_000_000_000_000 - calculated_deposit_fee
    );
}

#[test]
fn spl_fails_when_transact_instruction_signer_ata_owner_does_not_match_signer() {
    let mut ctx = setup();

    let deposit_amount = 100; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.attacker.pubkey(), // Attacker Acting as Signer
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.attacker, // Attacker
        &[],           // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("Signer Ata Owner is Invalid , Transaction Should Have Failed");

    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0xc")
            || logs.contains("InvalidTokenAccount")
            || logs.contains("Transaction simulation failed"),
        "unexpected logs: {logs}"
    );
}

//=========================================================
// Deposit Limit Tests
//=========================================================
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct UpdateDepositLimitParams {
    pub new_limit: [u8; 8],
    pub tree_account_bump: u8,
}

pub fn build_update_deposit_limit_ix(
    program_id: Pubkey,
    tree_account: Pubkey,
    mint_address: Pubkey,
    authority: Pubkey,
    new_limit: u64,
) -> Instruction {
    let (expected_tree_account, tree_bump) = Pubkey::find_program_address(
        &[
            privacy_cash::constants::TREE_ACCOUNT_SEED,
            mint_address.as_array(),
        ],
        &program_id,
    );

    assert_eq!(
        expected_tree_account, tree_account,
        "tree_account does not match the PDA for TREE_ACCOUNT_SEED"
    );

    let params = UpdateDepositLimitParams {
        new_limit: new_limit.to_le_bytes(),
        tree_account_bump: tree_bump,
    };

    let mut data = vec![PrivacyCashInstructions::UpdateDepositLimitForSpl as u8];
    data.extend_from_slice(bytemuck::bytes_of(&params));

    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(tree_account, false),
            AccountMeta::new(mint_address, false),
            AccountMeta::new(authority, true),
        ],
        data,
    }
}

fn read_max_deposit_amount(ctx: &mut TestContextSpl) -> u64 {
    let raw = ctx
        .svm
        .get_account(&ctx.spl_tree_account)
        .expect("tree account missing");

    let tree = bytemuck::from_bytes::<MerkleTreeAccount>(&raw.data[..MerkleTreeAccount::LEN]);
    tree.max_deposit_amount
}

#[test]
fn spl_fails_to_deposit_when_exceeding_the_default_deposit_limit() {
    let mut ctx = setup();
    let new_deposit_limit = 1000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.authority.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.authority,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    ctx.svm
        .send_transaction(versioned_tx)
        .expect("authority updateDepositLimit transaction failed");

    let updated_limit = read_max_deposit_amount(&mut ctx);
    assert_eq!(updated_limit, new_deposit_limit);

    // Deposit Exceeding Deposit Limit

    let deposit_amount = 1001;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(deposit_versioned_tx)
        .expect_err("Deposit Limit Exceeded , Transaction Should Have Failed");

    let logs = err.meta.logs.join("\n");

    assert!(
        logs.contains("0x8")
            || logs.contains("DepositLimitExceeded")
            || logs.contains("Transaction Simulation Failed")
    );
}

#[test]
fn spl_authority_can_update_deposit_limit() {
    let mut ctx = setup();
    let new_deposit_limit = 1000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.authority.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.authority,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    ctx.svm
        .send_transaction(versioned_tx)
        .expect("authority updateDepositLimit transaction failed");

    let updated_limit = read_max_deposit_amount(&mut ctx);
    assert_eq!(updated_limit, new_deposit_limit);
}

#[test]
fn spl_non_authority_cannot_update_deposit_limit() {
    let mut ctx = setup();
    let new_deposit_limit = 1000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.attacker.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.attacker.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.attacker,
        &ctx.attacker,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.attacker,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    let err = ctx
        .svm
        .send_transaction(versioned_tx)
        .expect_err("Non Authority Cannot Update Deposit Limit Spl");

    let logs = err.meta.logs.join("\n");

    assert!(
        logs.contains("0x0")
            || logs.contains("Unauthorized")
            || logs.contains("transaction simulation failed")
    )
}

#[test]
fn spl_can_deposit_after_increasing_limit() {
    let mut ctx = setup();
    let new_deposit_limit = 2_000_000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.authority.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.authority,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    ctx.svm
        .send_transaction(versioned_tx)
        .expect("authority updateDepositLimit transaction failed");

    let updated_limit = read_max_deposit_amount(&mut ctx);
    assert_eq!(updated_limit, new_deposit_limit);

    let deposit_amount = 1_500_000; // 0.0001 spl_mint_tokens from user_ata to spl_tree_ata
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 1_500_000 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state.amount,
        1_500_000 - calculated_deposit_fee
    );
}

#[test]
fn spl_withdrawal_has_no_limits() {
    //---------------------------------
    //         DEPOSIT
    //---------------------------------
    let mut ctx = setup();

    let new_deposit_limit = 2000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.authority.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.authority,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    ctx.svm
        .send_transaction(versioned_tx)
        .expect("authority updateDepositLimit transaction failed");

    let updated_limit = read_max_deposit_amount(&mut ctx);
    assert_eq!(updated_limit, new_deposit_limit);

    let deposit_amount = 2000;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let deposit_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [
        Utxo::with_mint(0, ctx.spl_token_mint),
        Utxo::with_mint(0, ctx.spl_token_mint),
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.spl_merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_mint(
            public_amount_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        )
        .with_index(output_index),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let deposit_input_merkle_path_indices = [0usize; 2];

    let deposit_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    let deposit_input_nullifiers = [
        deposit_inputs[0].get_nullifier().unwrap(),
        deposit_inputs[1].get_nullifier().unwrap(),
    ];

    let deposit_output_commitments = [
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.spl_merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: public_amount_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,

        in_amount: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: deposit_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: deposit_inputs[0].mint_address.to_string(),

        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,

        out_amount: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_input, &key_base_path).unwrap();

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &deposit_proof_to_submit,
        &create_ext_data_minified(&deposit_ext_data),
        &deposit_ext_data.encrypted_output1,
        &deposit_ext_data.encrypted_output2,
        deposit_nullifiers.bump0,
        deposit_nullifiers.bump1,
        ctx.spl_tree_account,
        deposit_nullifiers.nullifier0,
        deposit_nullifiers.nullifier1,
        deposit_cross_check_nullifiers.0,
        deposit_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local SPL Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    // After this SPl_tree ATA should have 100 tokens
    let spl_tree_ata_state = get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(spl_tree_ata_state.amount, deposit_amount);

    // The fee recipient should have collected the deposit fee.
    let fee_recipient_ata_state = get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(fee_recipient_ata_state.amount, calculated_deposit_fee);

    // Recipient's own token account is untouched on deposit (only the tree ATA moves).
    let recipient_ata_state_after_deposit = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_deposit.amount, 0);

    // Local merkle tree should now have exactly 2 leaves (the deposit's two outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 2);

    // Step 2: Lower the deposit limit to 1000 tokens

    let new_deposit_limit = 1000;
    let program_id = Address::from_str(PROGRAM_ID).expect("Program Could Not Be Parsed");

    let update_deposit_limit_ix = build_update_deposit_limit_ix(
        program_id,
        ctx.spl_tree_account,
        ctx.spl_token_mint,
        ctx.authority.pubkey(),
        new_deposit_limit,
    );

    let test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.fee_recipient_ata,
    );

    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.authority,
        &[],
        &[modify_compute_units, update_deposit_limit_ix],
        &lookup_table_address,
    );

    ctx.svm
        .send_transaction(versioned_tx)
        .expect("authority updateDepositLimit transaction failed");

    let updated_limit = read_max_deposit_amount(&mut ctx);
    assert_eq!(updated_limit, new_deposit_limit);

    //---------------------------------
    //         WITHDRAW
    //---------------------------------

    // Step 3: Withdraw an amount that exceeds the current deposit limit of 1000
    // We have (2000 - depositFee) tokens available
    // Let's withdraw 1500 tokens which exceeds the current 1000 limit
    // This should SUCCEED because withdrawals have no limit

    // Create withdrawal inputs using the deposited outputs
    let withdraw_amount = 1500;
    let calculated_withdraw_fee = calculate_withdrawal_fee(withdraw_amount);
    let recipient_ata = get_associated_token_address(&ctx.recipient.pubkey(), &ctx.spl_token_mint);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let withdraw_ext_amount = BigInt::from(calculated_withdraw_fee) - BigInt::from(withdraw_amount);
    let withdraw_public_number =
        (&withdraw_ext_amount - BigInt::from(calculated_withdraw_fee) + &field_size) % &field_size;

    let withdraw_ext_data = ExtData {
        recipient: recipient_ata.to_bytes(), // who receives the UTXO
        ext_amount: i64::try_from(withdraw_ext_amount).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2".to_vec(),
        fee: calculated_withdraw_fee,
        fee_recipient: ctx.fee_recipient_ata.to_bytes(),
        mint_address: *ctx.spl_token_mint.as_array(),
    };

    let withdraw_inputs = [
        deposit_outputs[0].clone(),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let change_number = (deposit_amount
        - calculated_deposit_fee
        - (withdraw_ext_data.ext_amount.abs() as u64)
        - calculated_withdraw_fee
        + &field_size)
        % &field_size;

    let withdraw_outputs = [
        Utxo::new_with_mint(
            change_number
                .clone()
                .try_into()
                .expect("Public amount should fit in u64"),
            ctx.spl_token_mint,
        ),
        Utxo::new_with_mint(0, ctx.spl_token_mint),
    ];

    let mut withdraw_input_merkle_path_indices = [0usize; 2];

    let mut withdraw_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
        vec![[0u8; 32]; ctx.spl_merkle_tree.levels],
    ];

    for (index, note) in withdraw_inputs.iter().enumerate() {
        if note.amount > 0 {
            let output_commitment = note.get_commitment().unwrap();
            let note_index = ctx.spl_merkle_tree.index_of(&output_commitment);

            if note_index < 0 {
                panic!("Note Index is not found");
            }

            withdraw_input_merkle_path_indices[index] = note_index as usize;
            withdraw_input_merkle_path_elements[index] =
                ctx.spl_merkle_tree.path(note_index as usize).path_elements;
        }
    }

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let withdraw_root = ctx.spl_merkle_tree.root();
    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_number
            .clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,

        in_amount: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        in_private_key: withdraw_inputs
            .iter()
            .map(|x| x.keypair.privkey.clone())
            .collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),

        mint_address: withdraw_inputs[0].mint_address.to_string(),

        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,

        out_amount: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.amount))
            .collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let withdraw_proof_result = prove(&withdraw_input, &key_base_path).unwrap();

    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();

    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers = find_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );
    let withdraw_cross_check_nullifiers = find_cross_check_nullifier_pdas(
        &Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
    );

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses_with_mint(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &ctx.spl_tree_token_account,
        &ctx.fee_recipient.pubkey(),
        &ctx.fee_recipient_ata,
        &ctx.spl_tree_account,
        &ctx.spl_token_mint,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let transact_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.spl_tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.spl_token_mint,
        ctx.random_user_ata,
        ctx.recipient.pubkey(),
        recipient_ata,
        ctx.spl_tree_token_account,
        ctx.fee_recipient_ata,
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user, // payer
        &[],              // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm.send_transaction(withdraw_versioned_tx).unwrap();

    // Update our local Merkle tree to match the on-chain state.
    for commitment in withdraw_output_commitments {
        ctx.spl_merkle_tree.insert(commitment);
    }

    let withdrawn_amount = withdraw_ext_data.ext_amount.abs() as u64;

    // Tree ATA should have paid out both the withdrawn amount and the withdraw fee.
    let spl_tree_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.spl_tree_token_account);
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount,
        deposit_outputs[0].amount - withdrawn_amount - calculated_withdraw_fee
    );

    // Recipient ATA should have received exactly the withdrawn (post-fee) amount.
    let recipient_ata_state_after_withdraw = get_token_account_state(&mut ctx.svm, &recipient_ata);
    assert_eq!(recipient_ata_state_after_withdraw.amount, withdrawn_amount);

    // Fee recipient should now hold both the deposit fee and the withdraw fee.
    let fee_recipient_ata_state_after_withdraw =
        get_token_account_state(&mut ctx.svm, &ctx.fee_recipient_ata);
    assert_eq!(
        fee_recipient_ata_state_after_withdraw.amount,
        calculated_deposit_fee + calculated_withdraw_fee
    );

    // Sanity: tree ATA + recipient ATA + fee recipient ATA should conserve the original deposit.
    assert_eq!(
        spl_tree_ata_state_after_withdraw.amount
            + recipient_ata_state_after_withdraw.amount
            + fee_recipient_ata_state_after_withdraw.amount,
        deposit_amount
    );

    // Local merkle tree should now have exactly 4 leaves (2 deposit outputs + 2 withdraw outputs).
    assert_eq!(ctx.spl_merkle_tree.elements().len(), 4);

    // The withdraw's change output should be the note actually left in the tree.
    let expected_change =
        deposit_amount - calculated_deposit_fee - withdrawn_amount - calculated_withdraw_fee;
    assert_eq!(withdraw_outputs[0].amount, expected_change);
}
