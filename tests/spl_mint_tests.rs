mod common;
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_sdk::{
    native_token::LAMPORTS_PER_SOL,
    signature::{Keypair, Signer},
    instruction::Instruction,
};
use solana_program_pack::Pack;
use solana_transaction::{Transaction, AccountMeta};
use ethers::{
    core::{k256::{schnorr::CryptoRngCore, sha2::digest::Key}, rand::{RngCore, thread_rng}}, utils::hex,
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
use spl_token::{
    instruction::{initialize_mint, mint_to},
    state::{Account as TokenAccount, Mint},
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account,
};

use crate::common::utils::get_mint_address_field;

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


// -----------------------------------------------------------------------------
// SPL token fixtures
// -----------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SplTokenFixtures {
    mint: Pubkey,
    signer_token_account: Pubkey,
    attacker_token_account: Pubkey,
    fee_recipient_token_account: Pubkey,
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let token_account = svm
        .get_account(account)
        .unwrap_or_else(|| panic!("token account {account} missing"));

    let unpacked = TokenAccount::unpack(&token_account.data)
        .unwrap_or_else(|e| panic!("failed to unpack token account {account}: {e:?}"));

    unpacked.amount
}

fn create_mint_and_atas(ctx: &mut TestContext) -> SplTokenFixtures {
    let mint = Keypair::new();

    let mint_lamports = 1_000_000_000u64;
    let mint_space = Mint::LEN as u64;

    let create_mint_ix = solana_program::example_mocks::solana_sdk::system_instruction::create_account(
        &ctx.authority.pubkey(),
        &mint.pubkey(),
        mint_lamports,
        mint_space,
        &pinocchio_token::ID,
    );

    let init_mint_ix = initialize_mint(
        &pinocchio_token::ID,
        &mint.pubkey(),
        &ctx.authority.pubkey(),
        Some(&ctx.authority.pubkey()),
        6,
    )
    .expect("failed to build initialize_mint instruction");

    let mint_tx = Transaction::new_signed_with_payer(
        &[create_mint_ix, init_mint_ix],
        Some(&ctx.authority.pubkey()),
        &[&ctx.authority, &mint],
        ctx.svm.latest_blockhash(),
    );
    ctx.svm
        .send_transaction(mint_tx)
        .expect("failed to initialize SPL mint");

    let signer_token_account = get_associated_token_address_with_program_id(&ctx.random_user.pubkey(), &mint.pubkey(), &pinocchio_token::ID);
    let attacker_token_account = get_associated_token_address_with_program_id(&ctx.attacker.pubkey(), &mint.pubkey(), &pinocchio_token::ID);
    let fee_recipient_token_account = get_associated_token_address_with_program_id(&ctx.fee_recipient.pubkey(), &mint.pubkey(), &pinocchio_token::ID);

    let create_signer_ata_ix = create_associated_token_account(
        &ctx.authority.pubkey(),
        &ctx.random_user.pubkey(),
        &mint.pubkey(),
        &pinocchio_token::ID,
    );
    let create_attacker_ata_ix = create_associated_token_account(
        &ctx.authority.pubkey(),
        &ctx.attacker.pubkey(),
        &mint.pubkey(),
        &pinocchio_token::ID,
    );
    let create_fee_recipient_ata_ix = create_associated_token_account(
        &ctx.authority.pubkey(),
        &ctx.fee_recipient.pubkey(),
        &mint.pubkey(),
        &pinocchio_token::ID,
    );

    let create_atas_tx = Transaction::new_signed_with_payer(
        &[create_signer_ata_ix, create_attacker_ata_ix, create_fee_recipient_ata_ix],
        Some(&ctx.authority.pubkey()),
        &[&ctx.authority],
        ctx.svm.latest_blockhash(),
    );
    ctx.svm
        .send_transaction(create_atas_tx)
        .expect("failed to create SPL token accounts");

    let mint_amount = 1_000_000_000_000u64;
    let mint_to_signer_ix = mint_to(
        &pinocchio_token::ID,
        &mint.pubkey(),
        &signer_token_account,
        &ctx.authority.pubkey(),
        &[],
        mint_amount,
    )
    .expect("failed to build mint_to instruction for signer");
    let mint_to_attacker_ix = mint_to(
        &pinocchio_token::ID,
        &mint.pubkey(),
        &attacker_token_account,
        &ctx.authority.pubkey(),
        &[],
        mint_amount,
    )
    .expect("failed to build mint_to instruction for attacker");

    let mint_tokens_tx = Transaction::new_signed_with_payer(
        &[mint_to_signer_ix, mint_to_attacker_ix],
        Some(&ctx.authority.pubkey()),
        &[&ctx.authority],
        ctx.svm.latest_blockhash(),
    );
    ctx.svm
        .send_transaction(mint_tokens_tx)
        .expect("failed to mint SPL tokens");

    assert_eq!(token_balance(&ctx.svm, &signer_token_account), mint_amount);
    assert_eq!(token_balance(&ctx.svm, &attacker_token_account), mint_amount);

    SplTokenFixtures {
        mint: mint.pubkey(),
        signer_token_account,
        attacker_token_account,
        fee_recipient_token_account,
    }
}

// -----------------------------------------------------------------------------
// SPL transact builder
// -----------------------------------------------------------------------------

pub fn build_transact_spl_ix(
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
    global_config: Pubkey,
    signer: Pubkey,
    recipient: Pubkey,
    mint: Pubkey,
    signer_token_account: Pubkey,
    recipient_token_account: Pubkey,
    tree_ata: Pubkey,
    fee_recipient_ata: Pubkey,
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
            AccountMeta::new(tree_account, false),
            AccountMeta::new(nullifier0, false),
            AccountMeta::new(nullifier1, false),
            AccountMeta::new(nullifier2, false),
            AccountMeta::new(nullifier3, false),
            AccountMeta::new(global_config, false),
            AccountMeta::new(signer, true),
            AccountMeta::new_readonly(mint, false),          // was: recipient
            AccountMeta::new(signer_token_account, false),   // was: mint
            AccountMeta::new_readonly(recipient, false),     // was: signer_token_account (this is `_recipient` on-chain — read but ignored)
            AccountMeta::new(recipient_token_account, false),
            AccountMeta::new(tree_ata, false),
            AccountMeta::new(fee_recipient_ata, false),
            AccountMeta::new_readonly(pinocchio_token::ID, false),
            AccountMeta::new_readonly(spl_associated_token_account::id(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

// -----------------------------------------------------------------------------
// Port of the TS SPL-token test
// -----------------------------------------------------------------------------

#[test]
fn fails_deposit_instruction_for_non_usdc_token_mint() {
    let mut ctx = setup();
    let fixtures = create_mint_and_atas(&mut ctx);

    let deposit_amount: u64 = 20_000;
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);

    let recipient_token_account = get_associated_token_address_with_program_id(&ctx.recipient.pubkey(), &fixtures.mint, &pinocchio_token::ID);
    let create_recipient_ata_ix = create_associated_token_account(
        &ctx.random_user.pubkey(),
        &ctx.recipient.pubkey(),
        &fixtures.mint,
        &pinocchio_token::ID,
    );
    let create_recipient_ata_tx = Transaction::new_signed_with_payer(
        &[create_recipient_ata_ix],
        Some(&ctx.random_user.pubkey()),
        &[&ctx.random_user],
        ctx.svm.latest_blockhash(),
    );
    ctx.svm
        .send_transaction(create_recipient_ata_tx)
        .expect("failed to create recipient ATA");

    let mut inputs = [Utxo::empty(), Utxo::empty()];
    for utxo in &mut inputs {
        utxo.mint_address = fixtures.mint.clone();
    }

    let output_amount = deposit_amount - calculated_deposit_fee;
    let output_index = ctx.merkle_tree.elements().len() as u64;
    let mut outputs = [
        Utxo::new_with_index(output_amount, output_index),
        Utxo::new(0),
    ];
    for utxo in &mut outputs {
        utxo.mint_address = fixtures.mint.clone();
    }

    let input_merkle_path_indices = [0usize; 2];
    let input_merkle_path_elements = vec![
        vec![[0u8; 32]; ctx.merkle_tree.levels],
        vec![[0u8; 32]; ctx.merkle_tree.levels],
    ];

    let input_nullifiers = [
        inputs[0].get_nullifier().unwrap(),
        inputs[1].get_nullifier().unwrap(),
    ];
    let output_commitments = [
        outputs[0].get_commitment().expect("failed to compute output commitment"),
        outputs[1].get_commitment().expect("failed to compute output commitment"),
    ];

    let root = ctx.merkle_tree.root();
    let ext_data = ExtData {
        recipient: recipient_token_account.to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"encryptedOutput1Data".to_vec(),
        encrypted_output2: b"encryptedOutput2Data".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: fixtures.fee_recipient_token_account.to_bytes(),
        mint_address: *fixtures.mint.as_array(),
    };

    let ext_data_hash = get_ext_data_hash(&ext_data);

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number =
        (ext_amount - deposit_fee + &field_size) % &field_size;

    let proof_input = ProofInput {
        root,
        input_nullifier: input_nullifiers,
        output_commitment: output_commitments,
        public_amount: public_amount_number.clone()
            .to_biguint()
            .expect("public amount should be non-negative"),
        ext_data_hash,
        in_amount: inputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        in_private_key: inputs.iter().map(|x| x.keypair.privkey.clone()).collect(),
        in_blinding: inputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        mint_address: fixtures.mint.to_string(),
        in_path_indices: input_merkle_path_indices,
        in_path_elements: input_merkle_path_elements,
        out_amount: outputs.iter().map(|x| BigUint::from(x.amount)).collect(),
        out_blinding: outputs.iter().map(|x| BigUint::from(x.blinding.clone())).collect(),
        out_pubkey: outputs.iter().map(|x| x.keypair.pubkey.clone()).collect(),
    };

    let key_base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("artifacts")
        .join("circuits")
        .join("transaction2");

    let proof_result = prove(&proof_input, &key_base_path).unwrap();
    let proof_to_submit = format_proof(
        deposit_artifacts_to_submit(&proof_result, false).unwrap(),
    );

    let nullifiers = find_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &proof_to_submit);
    let cross_check_nullifiers =
        find_cross_check_nullifier_pdas(&Pubkey::from_str_const(PROGRAM_ID), &proof_to_submit);

    let tree_ata = get_associated_token_address_with_program_id(&ctx.global_config, &fixtures.mint, &pinocchio_token::ID);

    let create_tree_ata_ix = create_associated_token_account(
        &ctx.authority.pubkey(),
        &ctx.global_config,
        &fixtures.mint,
        &pinocchio_token::ID,
    );

    let tx = Transaction::new_signed_with_payer(
        &[create_tree_ata_ix],
        Some(&ctx.authority.pubkey()),
        &[&ctx.authority],
        ctx.svm.latest_blockhash(),
    );

    ctx.svm.send_transaction(tx).unwrap();

    let test_protocol_addresses = 
        get_test_protocol_addresses_with_mint(
            &Address::from_str_const(PROGRAM_ID),
            &ctx.authority.pubkey(),
            &tree_ata,
            &ctx.fee_recipient.pubkey(),
            &fixtures.fee_recipient_token_account,
            &ctx.tree_account,
            &Pubkey::from_str("11111111111111111111111111111112")
            .unwrap()
        );
    let lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &test_protocol_addresses,
    );

    let signer_before = token_balance(&ctx.svm, &fixtures.signer_token_account);
    let recipient_before = token_balance(&ctx.svm, &recipient_token_account);
    let fee_recipient_before = token_balance(&ctx.svm, &fixtures.fee_recipient_token_account);
    let tree_before = token_balance(&ctx.svm, &tree_ata);

    let modify_compute_units = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    advance_one_slot(&mut ctx.svm);

    let tx_ix = build_transact_spl_ix(
        Pubkey::from_str_const(PROGRAM_ID),
        &proof_to_submit,
        &create_ext_data_minified(&ext_data),
        &ext_data.encrypted_output1,
        &ext_data.encrypted_output2,
        nullifiers.bump0,
        nullifiers.bump1,
        ctx.tree_account,
        nullifiers.nullifier0,
        nullifiers.nullifier1,
        cross_check_nullifiers.0,
        cross_check_nullifiers.1,
        ctx.global_config,
        ctx.random_user.pubkey(),
        ctx.recipient.pubkey(),
        fixtures.mint,
        fixtures.signer_token_account,
        recipient_token_account,
        tree_ata,
        fixtures.fee_recipient_token_account,
    );

    let versioned_tx = create_versioned_tx_with_alt(
        &mut ctx.svm,
        &ctx.random_user,
        &[],
        &[modify_compute_units, tx_ix],
        &lookup_table_address,
    );

    let result = ctx.svm.send_transaction(versioned_tx);
    assert!(
        result.is_err(),
        "expected non-USDC SPL deposit to fail, but the transaction succeeded"
    );

    let err = format!("{result:?}");
    assert!(
        err.contains("0x1") || err.contains("Invalid mint address"),
        "unexpected error: {err}"
    );

    assert_eq!(token_balance(&ctx.svm, &fixtures.signer_token_account), signer_before);
    assert_eq!(token_balance(&ctx.svm, &recipient_token_account), recipient_before);
    assert_eq!(token_balance(&ctx.svm, &fixtures.fee_recipient_token_account), fee_recipient_before);
    assert_eq!(token_balance(&ctx.svm, &tree_ata), tree_before);
}