mod common;
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction,
};
use solana_transaction::{Transaction, AccountMeta};
use ethers::{
    core::{k256::schnorr::CryptoRngCore, rand::{RngCore, thread_rng}}, utils::hex,
};
use std::{ops::{Add, Sub, Rem}, str::FromStr, path::PathBuf};
use common::{
    constants::{DEFAULT_HEIGHT, DEPOSIT_FEE_RATE, FEE_ERROR_MARGIN, FEE_RECIPIENT_ACCOUNT, FIELD_SIZE_DECIMAL, ROOT_HISTORY_SIZE, SOL_ADDRESS, WITHDRAW_FEE_RATE, },
    merkle_tree::MerkleTree,
    utils::{get_ext_data_hash, ExtData},
    prover::{DepositProofToSubmit, DepositProofArtifacts, ProofInput,
    prove, deposit_artifacts_to_submit },
    test_alt::{create_global_test_alt, create_versioned_tx_with_alt, get_global_test_alt, get_test_protocol_addresses, get_test_protocol_addresses_with_mint, reset_global_test_alt},
    utxo::Utxo
};
use num_bigint::{BigInt, BigUint};
use privacy_cash::{
    instructions,
    state::{
        transact::{Proof, ExtDataMinified, TransactArgs},
        MerkleTreeAccount
    },
    instructions::PrivacyCashInstructions,
};
use solana_address::Address;
use light_hasher::zero_bytes::poseidon::ZERO_BYTES;
use solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM;
use solana_program::{example_mocks::solana_sdk::system_instruction, pubkey::Pubkey};
use solana_compute_budget_interface::ComputeBudgetInstruction;

const PROGRAM_ID: &str = "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV";
const DEFAULT_ZERO: [u8; 32] = ZERO_BYTES[0]; // The default value of elements for initializing a tree

pub fn generate_random_nullifier() -> [u8; 32] {
    let mut nullifier = [0u8; 32];
    thread_rng().fill_bytes(&mut nullifier);
    nullifier
}

pub fn create_ext_data_minified(ext_data: &ExtData) -> ExtDataMinified {
    ExtDataMinified { ext_amount: ext_data.ext_amount, fee: ext_data.fee }
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

#[derive(Clone, Copy, Debug)]
pub struct NullifierPdas {
    pub nullifier0: Pubkey,
    pub nullifier1: Pubkey,
    pub bump0: u8,
    pub bump1: u8,
}

pub fn find_nullifier_pdas(program_id: &Pubkey, proof: &Proof) -> NullifierPdas {
    let (nullifier0, bump0) = Pubkey::find_program_address(
        &[b"nullifier0", &proof.input_nullifiers[0]],
        program_id,
    );

    let (nullifier1, bump1) = Pubkey::find_program_address(
        &[b"nullifier1", &proof.input_nullifiers[1]],
        program_id,
    );

    NullifierPdas {
        nullifier0,
        nullifier1,
        bump0,
        bump1,
    }
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

// Helper function, needed right after ALA lookups otherwise it won't work
fn advance_one_slot(svm: &mut LiteSVM) {
    let clock: Clock = svm.get_sysvar();
    svm.warp_to_slot(clock.slot + 1);
    svm.expire_blockhash();
}

pub fn setup() -> TestContext {
    reset_global_test_alt();
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
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
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

    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();

    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers = find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers = find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = 
        get_test_protocol_addresses(&Address::from_str_const(PROGRAM_ID), &ctx.authority.pubkey(), &FEE_RECIPIENT_ACCOUNT);
    
    let deposit_lookup_table_address = 
        create_global_test_alt(&mut ctx.svm, &ctx.authority, &ctx.authority, &deposit_test_protocol_addresses);

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
        FEE_RECIPIENT_ACCOUNT,
        ctx.random_user.pubkey(),
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,           // payer
        &[],                        // additional signers
        &[modify_compute_units.clone(), transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    // -----------------------------
    // Step 2: First withdrawal
    // -----------------------------

    let target_utxo = deposit_outputs[0].clone(); // same note reused later, like JS targetUtxo

    let first_inputs = [
        target_utxo.clone(), // deposited UTXO in position 0
        Utxo::empty(),       // empty second input
    ];

    let first_outputs = [
        Utxo::new(800),
        Utxo::new(0),
    ];

    let first_inputs_sum: u64 = first_inputs.iter().map(|x| x.amount).sum();
    let first_outputs_sum: u64 = first_outputs.iter().map(|x| x.amount).sum();
    let first_withdraw_fee = calculate_withdrawal_fee(first_inputs_sum);

    let first_ext_amount = BigInt::from(first_withdraw_fee)
        + BigInt::from(first_outputs_sum)
        - BigInt::from(first_inputs_sum);

    let first_public_amount = (&first_ext_amount - BigInt::from(first_withdraw_fee) + &field_size)
        % &field_size;

    let first_input_merkle_path_indices = [
        output_index as usize,
        0usize,
    ];

    let first_input_merkle_path_elements = vec![
        ctx.merkle_tree
            .path(output_index as usize)
            .path_elements
            .clone(),
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let first_input_nullifiers = [
        first_inputs[0].get_nullifier().unwrap(),
        first_inputs[1].get_nullifier().unwrap(),
    ];

    let first_output_commitments = [
        first_outputs[0]
            .get_commitment()
            .expect("failed to compute first output commitment"),
        first_outputs[1]
            .get_commitment()
            .expect("failed to compute first output commitment"),
    ];

    let first_root = ctx.merkle_tree.root();
    let first_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(first_ext_amount.clone()).unwrap(),
        encrypted_output1: b"firstEncryptedOutput1".to_vec(),
        encrypted_output2: b"firstEncryptedOutput2".to_vec(),
        fee: first_withdraw_fee,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };
    let first_ext_data_hash = get_ext_data_hash(&first_ext_data);

    let first_proof_input = ProofInput {
        root: first_root,
        input_nullifier: first_input_nullifiers,
        output_commitment: first_output_commitments,
        public_amount: first_public_amount
            .to_biguint()
            .expect("first public amount should be non-negative"),
        ext_data_hash: first_ext_data_hash,
        in_amount: first_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: first_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: first_inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: first_inputs[0].mint_address.to_string(),
        in_path_indices: first_input_merkle_path_indices,
        in_path_elements: first_input_merkle_path_elements,
        out_amount: first_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: first_outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: first_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let first_proof_result = prove(&first_proof_input, &key_base_path).unwrap();
    let first_proof_to_submit =
        format_proof(deposit_artifacts_to_submit(&first_proof_result, false).unwrap());

    let first_nullifiers =
        find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &first_proof_to_submit);
    let first_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &first_proof_to_submit);

    let first_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &FEE_RECIPIENT_ACCOUNT,
    );

    let first_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &first_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let first_transact_ix = build_transact_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &first_proof_to_submit,
        &create_ext_data_minified(&first_ext_data),
        &first_ext_data.encrypted_output1,
        &first_ext_data.encrypted_output2,
        first_nullifiers.bump0,
        first_nullifiers.bump1,
        ctx.tree_account,
        first_nullifiers.nullifier0,
        first_nullifiers.nullifier1,
        first_cross_check_nullifiers.0,
        first_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        ctx.recipient.pubkey(),
        FEE_RECIPIENT_ACCOUNT,
        ctx.random_user.pubkey(),
    );

    let first_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), first_transact_ix],
        &first_lookup_table_address,
    );

    ctx.svm
        .send_transaction(first_versioned_tx)
        .expect("first withdrawal failed");

    // Insert commitments into the local Merkle tree, matching the JS flow.
    for commitment in first_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    // -----------------------------
    // Step 3: Second withdrawal / double-spend attempt
    // target_utxo is now in position 1, just like the JS test
    // -----------------------------

    let second_inputs = [
        Utxo::empty(),       // empty first input
        target_utxo.clone(), // same note reused in position 1
    ];

    let second_outputs = [
        Utxo::new(200),
        Utxo::new(0),
    ];

    let second_inputs_sum: u64 = second_inputs.iter().map(|x| x.amount).sum();
    let second_outputs_sum: u64 = second_outputs.iter().map(|x| x.amount).sum();
    let second_withdraw_fee = calculate_withdrawal_fee(second_inputs_sum);

    let second_ext_amount = BigInt::from(second_withdraw_fee)
        + BigInt::from(second_outputs_sum)
        - BigInt::from(second_inputs_sum);

    let second_public_amount = (&second_ext_amount - BigInt::from(second_withdraw_fee) + &field_size)
        % &field_size;

    let second_input_merkle_path_indices = [
        0usize,
        output_index as usize, // same target commitment, now in slot 1
    ];

    let second_input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.merkle_tree.levels],
        ctx.merkle_tree
            .path(output_index as usize)
            .path_elements
            .clone(),
    ];

    let second_input_nullifiers = [
        second_inputs[0].get_nullifier().unwrap(),
        second_inputs[1].get_nullifier().unwrap(),
    ];

    assert_eq!(
        first_input_nullifiers[0],
        second_input_nullifiers[1],
        "same UTXO should produce the same nullifier"
    );

    let second_output_commitments = [
        second_outputs[0]
            .get_commitment()
            .expect("failed to compute second output commitment"),
        second_outputs[1]
            .get_commitment()
            .expect("failed to compute second output commitment"),
    ];

    let second_root = ctx.merkle_tree.root();
    let second_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(second_ext_amount.clone()).unwrap(),
        encrypted_output1: b"secondEncryptedOutput1".to_vec(),
        encrypted_output2: b"secondEncryptedOutput2".to_vec(),
        fee: second_withdraw_fee,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };
    let second_ext_data_hash = get_ext_data_hash(&second_ext_data);

    let second_proof_input = ProofInput {
        root: second_root,
        input_nullifier: second_input_nullifiers,
        output_commitment: second_output_commitments,
        public_amount: second_public_amount
            .to_biguint()
            .expect("second public amount should be non-negative"),
        ext_data_hash: second_ext_data_hash,
        in_amount: second_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: second_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: second_inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: second_inputs[0].mint_address.to_string(),
        in_path_indices: second_input_merkle_path_indices,
        in_path_elements: second_input_merkle_path_elements,
        out_amount: second_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: second_outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: second_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let second_proof_result = prove(&second_proof_input, &key_base_path).unwrap();
    let second_proof_to_submit =
        format_proof(deposit_artifacts_to_submit(&second_proof_result, false).unwrap());

    let second_nullifiers =
        find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &second_proof_to_submit);
    let second_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &second_proof_to_submit);

    let second_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &FEE_RECIPIENT_ACCOUNT,
    );

    let second_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &second_test_protocol_addresses,
    );

    let second_transact_ix = build_transact_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &second_proof_to_submit,
        &create_ext_data_minified(&second_ext_data),
        &second_ext_data.encrypted_output1,
        &second_ext_data.encrypted_output2,
        second_nullifiers.bump0,
        second_nullifiers.bump1,
        ctx.tree_account,
        second_nullifiers.nullifier0,
        second_nullifiers.nullifier1,
        second_cross_check_nullifiers.0,
        second_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        ctx.recipient.pubkey(),
        FEE_RECIPIENT_ACCOUNT,
        ctx.random_user.pubkey(),
    );

    let second_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), second_transact_ix],
        &second_lookup_table_address,
    );

    let second_result = ctx.svm.send_transaction(second_versioned_tx);
    assert!(
        second_result.is_err(),
        "double-spend should fail, but the transaction succeeded"
    );

}

#[test]
fn can_execute_both_deposit_and_withdraw_for_correct_input_with_positive_fee() {
    let mut ctx = setup();

    // -----------------------------
    // Step 1: Deposit
    // -----------------------------
    let deposit_amount: u64 = 20_000;
    let deposit_fee_amount = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"encryptedOutput1Data".to_vec(),
        encrypted_output2: b"encryptedOutput2Data".to_vec(),
        fee: deposit_fee_amount,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let deposit_inputs = [Utxo::empty(), Utxo::empty()];
    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let deposit_public_amount_big = (BigInt::from(deposit_amount)
        - BigInt::from(deposit_fee_amount)
        + &field_size)
        % &field_size;
    let deposit_public_amount: u64 = deposit_public_amount_big
        .clone()
        .try_into()
        .expect("deposit public amount should fit in u64");

    let output_index = ctx.merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_index(deposit_public_amount, output_index),
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
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_proof_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: deposit_public_amount_big
            .clone()
            .to_biguint()
            .expect("deposit public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,
        in_amount: deposit_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: deposit_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: deposit_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        mint_address: deposit_inputs[0].mint_address.to_string(),
        in_path_indices: deposit_input_merkle_path_indices,
        in_path_elements: deposit_input_merkle_path_elements,
        out_amount: deposit_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: deposit_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: deposit_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let deposit_proof_result = prove(&deposit_proof_input, &key_base_path).unwrap();
    let deposit_artifacts =
        deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers =
        find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &deposit_proof_to_submit);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &FEE_RECIPIENT_ACCOUNT,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    let tree_token_account_balance_before =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let fee_recipient_balance_before =
        ctx.svm.get_balance(&FEE_RECIPIENT_ACCOUNT).unwrap_or(0);
    let recipient_balance_before = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_before = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    advance_one_slot(&mut ctx.svm);

    let deposit_transact_ix = build_transact_ix(
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
        FEE_RECIPIENT_ACCOUNT,
        ctx.random_user.pubkey(),
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), deposit_transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    for commitment in deposit_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    let tree_token_account_balance_after =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let fee_recipient_balance_after =
        ctx.svm.get_balance(&FEE_RECIPIENT_ACCOUNT).unwrap_or(0);
    let recipient_balance_after = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_after = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    assert_eq!(
        tree_token_account_balance_after - tree_token_account_balance_before,
        deposit_public_amount
    );
    assert_eq!(
        fee_recipient_balance_after - fee_recipient_balance_before,
        deposit_fee_amount
    );
    assert_eq!(recipient_balance_after - recipient_balance_before, 0);
    assert!(random_user_balance_after < random_user_balance_before);

    // -----------------------------
    // Step 2: Withdrawal
    // -----------------------------
    let withdraw_inputs = [deposit_outputs[0].clone(), Utxo::empty()];
    let withdraw_outputs = [Utxo::new(3_000), Utxo::new(0)];

    let withdraw_inputs_sum: u64 = withdraw_inputs.iter().map(|x| x.amount).sum();
    let withdraw_outputs_sum: u64 = withdraw_outputs.iter().map(|x| x.amount).sum();

    let withdrawal_amount = withdraw_inputs_sum - withdraw_outputs_sum;
    let withdraw_fee_amount = calculate_withdrawal_fee(withdrawal_amount);

    let withdraw_ext_amount = BigInt::from(withdraw_fee_amount)
        + BigInt::from(withdraw_outputs_sum)
        - BigInt::from(withdraw_inputs_sum);

    let withdraw_public_amount = (&withdraw_ext_amount - BigInt::from(withdraw_fee_amount)
        + &field_size)
        % &field_size;

    let withdraw_input_merkle_path_indices = [output_index as usize, 0usize];
    let withdraw_input_merkle_path_elements = vec![
        ctx.merkle_tree
            .path(output_index as usize)
            .path_elements
            .clone(),
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
    ];

    let withdraw_root = ctx.merkle_tree.root();
    let withdraw_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(withdraw_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1Data".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2Data".to_vec(),
        fee: withdraw_fee_amount,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_proof_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_amount
            .to_biguint()
            .expect("withdraw public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,
        in_amount: withdraw_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: withdraw_inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: withdraw_inputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        mint_address: withdraw_inputs[0].mint_address.to_string(),
        in_path_indices: withdraw_input_merkle_path_indices,
        in_path_elements: withdraw_input_merkle_path_elements,
        out_amount: withdraw_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let withdraw_proof_result = prove(&withdraw_proof_input, &key_base_path).unwrap();
    let withdraw_artifacts =
        deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();
    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers =
        find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &withdraw_proof_to_submit);
    let withdraw_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &withdraw_proof_to_submit);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &FEE_RECIPIENT_ACCOUNT,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let withdraw_transact_ix = build_transact_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        ctx.recipient.pubkey(),
        FEE_RECIPIENT_ACCOUNT,
        ctx.random_user.pubkey(),
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), withdraw_transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm
        .send_transaction(withdraw_versioned_tx)
        .expect("withdraw transaction failed");

    for commitment in withdraw_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    assert_ne!(withdraw_input_nullifiers[0], withdraw_input_nullifiers[1]);
}

#[test]
fn can_execute_both_deposit_and_withdraw_to_pda_recipient_for_positive_fees() {
    let mut ctx = setup();

    let program_id = Pubkey::from_str_const(PROGRAM_ID);

    // Match the TS test: use PDA recipient + PDA fee recipient.
    let (pda_recipient, _) = Pubkey::find_program_address(
        &[b"test_recipient", ctx.random_user.pubkey().as_ref()],
        &program_id,
    );

    let (pda_fee_recipient, _) = Pubkey::find_program_address(
        &[b"test_fee_recipient", ctx.random_user.pubkey().as_ref()],
        &program_id,
    );

    // Fund the PDA accounts so they exist and can be balance-checked.
    ctx.svm.airdrop(&pda_recipient, LAMPORTS_PER_SOL / 2).unwrap();
    ctx.svm.airdrop(&pda_fee_recipient, LAMPORTS_PER_SOL / 2).unwrap();

    // Snapshot balances before anything happens.
    let tree_token_account_balance_before =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let pda_fee_recipient_balance_before =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let pda_recipient_balance_before =
        ctx.svm.get_balance(&pda_recipient).unwrap();
    let random_user_balance_before =
        ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    // -----------------------------
    // Step 1: Deposit
    // -----------------------------
    let deposit_amount: u64 = 20_000;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: pda_recipient.to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"encryptedOutput1Data".to_vec(),
        encrypted_output2: b"encryptedOutput2Data".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: pda_fee_recipient.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let deposit_inputs = [Utxo::empty(), Utxo::empty()];
    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let deposit_public_amount_big = (BigInt::from(deposit_amount)
        - BigInt::from(calculated_deposit_fee)
        + &field_size)
        % &field_size;

    let deposit_public_amount: u64 = deposit_public_amount_big
        .clone()
        .try_into()
        .expect("deposit public amount should fit in u64");

    let output_index = ctx.merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_index(deposit_public_amount, output_index),
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
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute deposit output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute deposit output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_proof_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: deposit_public_amount_big
            .clone()
            .to_biguint()
            .expect("deposit public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,
        in_amount: deposit_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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
        out_amount: deposit_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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

    let deposit_proof_result = prove(&deposit_proof_input, &key_base_path).unwrap();
    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers =
        find_nullifier_pdas(&program_id, &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&program_id, &deposit_proof_to_submit);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &pda_fee_recipient,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let deposit_transact_ix = build_transact_ix(
        program_id,
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
        pda_recipient,
        pda_fee_recipient,
        ctx.random_user.pubkey(),
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), deposit_transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    for commitment in deposit_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    let tree_token_account_balance_after_deposit =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let pda_fee_recipient_balance_after_deposit =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let pda_recipient_balance_after_deposit =
        ctx.svm.get_balance(&pda_recipient).unwrap();
    let random_user_balance_after_deposit =
        ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    assert_eq!(
        tree_token_account_balance_after_deposit as i128
            - tree_token_account_balance_before as i128,
        deposit_public_amount as i128
    );
    assert_eq!(
        pda_fee_recipient_balance_after_deposit as i128
            - pda_fee_recipient_balance_before as i128,
        calculated_deposit_fee as i128
    );
    assert_eq!(
        pda_recipient_balance_after_deposit as i128
            - pda_recipient_balance_before as i128,
        0
    );
    assert!(random_user_balance_after_deposit < random_user_balance_before);

    // -----------------------------
    // Step 2: Withdrawal
    // -----------------------------
    let withdraw_inputs = [deposit_outputs[0].clone(), Utxo::empty()];
    let withdraw_outputs = [Utxo::new(3_000), Utxo::new(0)];

    let withdraw_inputs_sum: u64 = withdraw_inputs.iter().map(|x| x.amount).sum();
    let withdraw_outputs_sum: u64 = withdraw_outputs.iter().map(|x| x.amount).sum();

    let withdrawal_amount = withdraw_inputs_sum - withdraw_outputs_sum;
    let withdraw_fee = calculate_withdrawal_fee(withdrawal_amount);

    let withdraw_ext_amount = BigInt::from(withdraw_fee)
        + BigInt::from(withdraw_outputs_sum)
        - BigInt::from(withdraw_inputs_sum);

    let withdraw_public_amount_big =
        (&withdraw_ext_amount - BigInt::from(withdraw_fee) + &field_size) % &field_size;

    let withdraw_input_merkle_path_indices = [
        output_index as usize,
        0usize,
    ];

    let withdraw_input_merkle_path_elements = vec![
        ctx.merkle_tree
            .path(output_index as usize)
            .path_elements
            .clone(),
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
    ];

    let withdraw_root = ctx.merkle_tree.root();
    let withdraw_ext_data = ExtData {
        recipient: pda_recipient.to_bytes(),
        ext_amount: i64::try_from(withdraw_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1Data".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2Data".to_vec(),
        fee: withdraw_fee,
        fee_recipient: pda_fee_recipient.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_proof_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_amount_big
            .clone()
            .to_biguint()
            .expect("withdraw public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,
        in_amount: withdraw_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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
        out_amount: withdraw_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let withdraw_proof_result = prove(&withdraw_proof_input, &key_base_path).unwrap();
    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();
    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers =
        find_nullifier_pdas(&program_id, &withdraw_proof_to_submit);
    let withdraw_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&program_id, &withdraw_proof_to_submit);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &pda_fee_recipient,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    let pda_fee_recipient_balance_before_withdraw =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();

    advance_one_slot(&mut ctx.svm);

    let withdraw_transact_ix = build_transact_ix(
        program_id,
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        pda_recipient,
        pda_fee_recipient,
        ctx.random_user.pubkey(),
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), withdraw_transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm
        .send_transaction(withdraw_versioned_tx)
        .expect("withdraw transaction failed");

    for commitment in withdraw_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    let final_tree_token_balance =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let final_pda_fee_recipient_balance =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let final_pda_recipient_balance =
        ctx.svm.get_balance(&pda_recipient).unwrap();
    let final_random_user_balance =
        ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    let tree_token_total_diff =
        final_tree_token_balance as i128 - tree_token_account_balance_before as i128;
    let fee_recipient_total_diff =
        final_pda_fee_recipient_balance as i128 - pda_fee_recipient_balance_before as i128;
    let recipient_total_diff =
        final_pda_recipient_balance as i128 - pda_recipient_balance_before as i128;
    let random_user_total_diff =
        final_random_user_balance as i128 - random_user_balance_before as i128;

    assert_eq!(tree_token_total_diff, withdraw_outputs_sum as i128);
    assert_eq!(
        fee_recipient_total_diff,
        (calculated_deposit_fee + withdraw_fee) as i128
    );
    assert_eq!(
        recipient_total_diff,
        (withdraw_inputs_sum - withdraw_outputs_sum - withdraw_fee) as i128
    );
    assert!(random_user_total_diff < -(calculated_deposit_fee as i128));
}

#[test]
fn can_execute_both_deposit_and_withdraw_with_pda_fee_recipient_for_positive_fees() {
    let mut ctx = setup();

    let program_id = Pubkey::from_str_const(PROGRAM_ID);

    let (pda_fee_recipient, _) = Pubkey::find_program_address(
        &[b"test_fee_recipient", ctx.random_user.pubkey().as_ref()],
        &program_id,
    );

    // Fund the PDA fee recipient if needed.
    ctx.svm
        .airdrop(&pda_fee_recipient, LAMPORTS_PER_SOL / 2)
        .unwrap();

    let tree_token_account_balance_before =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let pda_fee_recipient_balance_before =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let recipient_balance_before = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_before = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    // -----------------------------
    // Step 1: Deposit
    // -----------------------------
    let deposit_amount: u64 = 20_000;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"encryptedOutput1Data".to_vec(),
        encrypted_output2: b"encryptedOutput2Data".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: pda_fee_recipient.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let deposit_inputs = [Utxo::empty(), Utxo::empty()];
    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let deposit_public_amount_big =
        (BigInt::from(deposit_amount) - BigInt::from(calculated_deposit_fee) + &field_size) % &field_size;

    let deposit_public_amount: u64 = deposit_public_amount_big
        .clone()
        .try_into()
        .expect("deposit public amount should fit in u64");

    let output_index = ctx.merkle_tree.elements().len() as u64;

    let deposit_outputs = [
        Utxo::new_with_index(deposit_public_amount, output_index),
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
        deposit_outputs[0]
            .get_commitment()
            .expect("failed to compute deposit output commitment"),
        deposit_outputs[1]
            .get_commitment()
            .expect("failed to compute deposit output commitment"),
    ];

    let deposit_root = ctx.merkle_tree.root();
    let deposit_ext_data_hash = get_ext_data_hash(&deposit_ext_data);

    let deposit_proof_input = ProofInput {
        root: deposit_root,
        input_nullifier: deposit_input_nullifiers,
        output_commitment: deposit_output_commitments,
        public_amount: deposit_public_amount_big
            .clone()
            .to_biguint()
            .expect("deposit public amount should be non-negative"),
        ext_data_hash: deposit_ext_data_hash,
        in_amount: deposit_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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
        out_amount: deposit_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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

    let deposit_proof_result = prove(&deposit_proof_input, &key_base_path).unwrap();
    let deposit_artifacts = deposit_artifacts_to_submit(&deposit_proof_result, false).unwrap();
    let deposit_proof_to_submit = format_proof(deposit_artifacts);

    let deposit_nullifiers =
        find_nullifier_pdas(&program_id, &deposit_proof_to_submit);
    let deposit_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&program_id, &deposit_proof_to_submit);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let deposit_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &pda_fee_recipient,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

    advance_one_slot(&mut ctx.svm);

    let deposit_transact_ix = build_transact_ix(
        program_id,
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
        pda_fee_recipient,
        ctx.random_user.pubkey(),
    );

    let deposit_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), deposit_transact_ix],
        &deposit_lookup_table_address,
    );

    ctx.svm
        .send_transaction(deposit_versioned_tx)
        .expect("deposit transaction failed");

    for commitment in deposit_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    let tree_token_account_balance_after_deposit =
        ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let pda_fee_recipient_balance_after_deposit =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let recipient_balance_after_deposit = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let random_user_balance_after_deposit = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    assert_eq!(
        tree_token_account_balance_after_deposit as i128 - tree_token_account_balance_before as i128,
        deposit_public_amount as i128
    );
    assert_eq!(
        pda_fee_recipient_balance_after_deposit as i128 - pda_fee_recipient_balance_before as i128,
        calculated_deposit_fee as i128
    );
    assert_eq!(
        recipient_balance_after_deposit as i128 - recipient_balance_before as i128,
        0
    );
    assert!(random_user_balance_after_deposit < random_user_balance_before);

    // -----------------------------
    // Step 2: Withdrawal
    // -----------------------------
    let withdraw_inputs = [deposit_outputs[0].clone(), Utxo::empty()];
    let withdraw_outputs = [Utxo::new(3_000), Utxo::new(0)];

    let withdraw_inputs_sum: u64 = withdraw_inputs.iter().map(|x| x.amount).sum();
    let withdraw_outputs_sum: u64 = withdraw_outputs.iter().map(|x| x.amount).sum();

    let withdrawal_amount = withdraw_inputs_sum - withdraw_outputs_sum;
    let withdraw_fee = calculate_withdrawal_fee(withdrawal_amount);

    let withdraw_ext_amount = BigInt::from(withdraw_fee)
        + BigInt::from(withdraw_outputs_sum)
        - BigInt::from(withdraw_inputs_sum);

    let withdraw_public_amount_big =
        (&withdraw_ext_amount - BigInt::from(withdraw_fee) + &field_size) % &field_size;

    let withdraw_input_merkle_path_indices = [output_index as usize, 0usize];
    let withdraw_input_merkle_path_elements = vec![
        ctx.merkle_tree
            .path(output_index as usize)
            .path_elements
            .clone(),
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let withdraw_input_nullifiers = [
        withdraw_inputs[0].get_nullifier().unwrap(),
        withdraw_inputs[1].get_nullifier().unwrap(),
    ];

    let withdraw_output_commitments = [
        withdraw_outputs[0]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
        withdraw_outputs[1]
            .get_commitment()
            .expect("failed to compute withdraw output commitment"),
    ];

    let withdraw_root = ctx.merkle_tree.root();
    let withdraw_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(withdraw_ext_amount.clone()).unwrap(),
        encrypted_output1: b"withdrawEncryptedOutput1Data".to_vec(),
        encrypted_output2: b"withdrawEncryptedOutput2Data".to_vec(),
        fee: withdraw_fee,
        fee_recipient: pda_fee_recipient.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
            .to_bytes(),
    };

    let withdraw_ext_data_hash = get_ext_data_hash(&withdraw_ext_data);

    let withdraw_proof_input = ProofInput {
        root: withdraw_root,
        input_nullifier: withdraw_input_nullifiers,
        output_commitment: withdraw_output_commitments,
        public_amount: withdraw_public_amount_big
            .clone()
            .to_biguint()
            .expect("withdraw public amount should be non-negative"),
        ext_data_hash: withdraw_ext_data_hash,
        in_amount: withdraw_inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
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
        out_amount: withdraw_outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: withdraw_outputs
            .iter()
            .map(|x| BigUint::from(x.blinding.clone()))
            .collect(),
        out_pubkey: withdraw_outputs
            .iter()
            .map(|x| x.keypair.pubkey.clone())
            .collect(),
    };

    let withdraw_proof_result = prove(&withdraw_proof_input, &key_base_path).unwrap();
    let withdraw_artifacts = deposit_artifacts_to_submit(&withdraw_proof_result, false).unwrap();
    let withdraw_proof_to_submit = format_proof(withdraw_artifacts);

    let withdraw_nullifiers =
        find_nullifier_pdas(&program_id, &withdraw_proof_to_submit);
    let withdraw_cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&program_id, &withdraw_proof_to_submit);

    let withdraw_test_protocol_addresses = get_test_protocol_addresses(
        &Address::from_str_const(PROGRAM_ID),
        &ctx.authority.pubkey(),
        &pda_fee_recipient,
    );

    let withdraw_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &withdraw_test_protocol_addresses,
    );

    let pda_fee_recipient_balance_before_withdraw =
        ctx.svm.get_balance(&pda_fee_recipient).unwrap();

    advance_one_slot(&mut ctx.svm);

    let withdraw_transact_ix = build_transact_ix(
        program_id,
        &withdraw_proof_to_submit,
        &create_ext_data_minified(&withdraw_ext_data),
        &withdraw_ext_data.encrypted_output1,
        &withdraw_ext_data.encrypted_output2,
        withdraw_nullifiers.bump0,
        withdraw_nullifiers.bump1,
        ctx.tree_account,
        withdraw_nullifiers.nullifier0,
        withdraw_nullifiers.nullifier1,
        withdraw_cross_check_nullifiers.0,
        withdraw_cross_check_nullifiers.1,
        ctx.tree_token_account,
        ctx.global_config,
        ctx.recipient.pubkey(),
        pda_fee_recipient,
        ctx.random_user.pubkey(),
    );

    let withdraw_versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units.clone(), withdraw_transact_ix],
        &withdraw_lookup_table_address,
    );

    ctx.svm
        .send_transaction(withdraw_versioned_tx)
        .expect("withdraw transaction failed");

    for commitment in withdraw_output_commitments {
        ctx.merkle_tree.insert(commitment);
    }

    let final_tree_token_balance = ctx.svm.get_balance(&ctx.tree_token_account).unwrap();
    let final_pda_fee_recipient_balance = ctx.svm.get_balance(&pda_fee_recipient).unwrap();
    let final_recipient_balance = ctx.svm.get_balance(&ctx.recipient.pubkey()).unwrap();
    let final_random_user_balance = ctx.svm.get_balance(&ctx.random_user.pubkey()).unwrap();

    let tree_token_total_diff =
        final_tree_token_balance as i128 - tree_token_account_balance_before as i128;
    let fee_recipient_total_diff =
        final_pda_fee_recipient_balance as i128 - pda_fee_recipient_balance_before as i128;
    let recipient_total_diff =
        final_recipient_balance as i128 - recipient_balance_before as i128;
    let random_user_total_diff =
        final_random_user_balance as i128 - random_user_balance_before as i128;

    assert_eq!(tree_token_total_diff, withdraw_outputs_sum as i128);
    assert_eq!(
        fee_recipient_total_diff,
        (calculated_deposit_fee + withdraw_fee) as i128
    );
    assert_eq!(
        recipient_total_diff,
        (withdraw_inputs_sum - withdraw_outputs_sum - withdraw_fee) as i128
    );
    assert!(random_user_total_diff < -(calculated_deposit_fee as i128));
}