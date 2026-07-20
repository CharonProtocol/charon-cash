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