mod common;
use litesvm::LiteSVM;
use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction
};
use solana_transaction::{Transaction, AccountMeta};
use ethers::{
    core::{k256::schnorr::CryptoRngCore, rand::thread_rng, rand::RngCore},
    utils::hex,
};
use std::{ops::{Add, Sub, Rem}, str::FromStr, path::PathBuf};
use common::{
    constants::{DEFAULT_HEIGHT, DEPOSIT_FEE_RATE, FEE_ERROR_MARGIN, FEE_RECIPIENT_ACCOUNT, FIELD_SIZE_DECIMAL, ROOT_HISTORY_SIZE, SOL_ADDRESS, WITHDRAW_FEE_RATE, },
    merkle_tree::MerkleTree,
    utils::{get_ext_data_hash, ExtData},
    prover::{DepositProofToSubmit, DepositProofArtifacts, ProofInput,
    prove, deposit_artifacts_to_submit
}};
use num_bigint::{BigInt, BigUint};
use privacy_cash::{
    instructions,
    state::{
        transact::{Proof, ExtDataMinified},
        MerkleTreeAccount
    },
    instructions::PrivacyCashInstructions
};

use light_hasher::zero_bytes::poseidon::ZERO_BYTES;

use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_program::{example_mocks::solana_sdk::system_instruction, pubkey::Pubkey};

use crate::common::utxo::Utxo;

const PROGRAM_ID: &str = "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV";
const DEFAULT_ZERO: [u8; 32] = ZERO_BYTES[0]; // The default value of elements for initializing a tree

pub fn generate_random_nullifier() -> [u8; 32] {
    let mut nullifier = [0u8; 32];
    thread_rng().fill_bytes(&mut nullifier);
    nullifier
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
pub fn format_proof(
    proof: DepositProofToSubmit,
) -> Proof {
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

pub fn find_nullifier_pdas(
    program_id: &Pubkey,
    proof: &Proof,
) -> (Pubkey, Pubkey) {
    let (nullifier0_pda, _) = Pubkey::find_program_address(
        &[
            b"nullifier0",
            &proof.input_nullifiers[0],
        ],
        program_id,
    );

    let (nullifier1_pda, _) = Pubkey::find_program_address(
        &[
            b"nullifier1",
            &proof.input_nullifiers[1],
        ],
        program_id,
    );

    (nullifier0_pda, nullifier1_pda)
}

pub fn find_cross_check_nullifier_pdas(
    program_id: &Pubkey,
    proof: &Proof,
) -> (Pubkey, Pubkey) {
    let (nullifier2_pda, _) = Pubkey::find_program_address(
        &[
            b"nullifier0",
            &proof.input_nullifiers[1],
        ],
        program_id,
    );

    let (nullifier3_pda, _) = Pubkey::find_program_address(
        &[
            b"nullifier1",
            &proof.input_nullifiers[0],
        ],
        program_id,
    );

    (nullifier2_pda, nullifier3_pda)
}

pub struct TestContext {
    pub svm: LiteSVM,

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
        data
    }
}

pub fn setup() -> TestContext {
    let mut svm = LiteSVM::new();

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();

    // Load the Anchor program into LiteSVM.
    // Replace the path with your actual built .so.
    svm.add_program(program_id, include_bytes!("../target/deploy/privacy_cash.so"))
        .unwrap();

    let authority = Keypair::new();
    let funding_account = Keypair::new();
    let recipient = Keypair::new();
    let fee_recipient = Keypair::new();
    let random_user = Keypair::new();
    let attacker = Keypair::new();

    let merkle_tree = MerkleTree::new(DEFAULT_HEIGHT, Vec::new());

    let (tree_account, tree_bump) =
        Pubkey::find_program_address(&[b"merkle_tree"], &program_id);

    let (tree_token_account, tree_token_bump) =
        Pubkey::find_program_address(&[b"tree_token"], &program_id);

    let (global_config, global_config_bump) =
        Pubkey::find_program_address(&[b"global_config"], &program_id);

    // Fund the funding account.
    svm.airdrop(&funding_account.pubkey(), 1_000 * LAMPORTS_PER_SOL).unwrap();

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
        global_config_bump
    );

    let initialize_tx = Transaction::new_signed_with_payer(
        &[initialize_ix],
        Some(&authority.pubkey()),
        &[&authority],
        svm.latest_blockhash(),
    );

    svm.send_transaction(initialize_tx).unwrap();

    // Fund the tree token PDA after initialization.
    svm.airdrop(&tree_token_account, 2 * LAMPORTS_PER_SOL).unwrap();

    // THIS SECTION IS RELATED TO THE BEFOREEACH PART, NO NEED TO ADAPT THAT SEPARATELY
    svm.airdrop(&recipient.pubkey(), LAMPORTS_PER_SOL / 2).unwrap();
    svm.airdrop(&fee_recipient.pubkey(), LAMPORTS_PER_SOL / 2).unwrap();
    svm.airdrop(&random_user.pubkey(), LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&attacker.pubkey(), LAMPORTS_PER_SOL).unwrap();

    assert!(svm.get_balance(&recipient.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&fee_recipient.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&random_user.pubkey()).unwrap() > 0);
    assert!(svm.get_balance(&attacker.pubkey()).unwrap() > 0);
    // --------------------------------------------------------------------------------

    // Verify the initialized tree account.
    let account = svm.get_account(&tree_account).expect("tree account missing");
    let tree_state = bytemuck::from_bytes::<MerkleTreeAccount>(&account.data);

    assert_eq!(tree_state.authority, authority.pubkey().to_bytes());
    assert_eq!(tree_state.next_index, 0);
    assert_eq!(tree_state.root_index, 0);
    assert_eq!(tree_state.root_history.len(), ROOT_HISTORY_SIZE);

    TestContext {
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
        merkle_tree,
    }
}

#[test]
fn double_spend_attack_fails()
{
    let mut ctx = setup();

    let deposit_amount = 1000;
    let deposit_fee = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: deposit_fee,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let deposit_inputs = [
        Utxo::empty(),
        Utxo::empty()
    ];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(deposit_fee);

    let public_amount_number =
        (ext_amount - deposit_fee + &field_size) % &field_size;

    let output_index = ctx.merkle_tree.elements().len() as u64;
    
    let deposit_outputs = [
        Utxo::new_with_index(public_amount_number.clone().try_into().expect("Public amount should fit in u64"), output_index),
        Utxo::new(0)
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
        deposit_outputs[0].get_commitment(),
        deposit_outputs[1].get_commitment(),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments.map(|x| {
            x.expect("failed to compute output commitment")
        }),
        public_amount: public_amount_number.clone()
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
    let deposit_proof_to_submit = format_proof(deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap());

    let deposit_nullifiers = find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);

    

}