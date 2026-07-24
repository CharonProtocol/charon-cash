mod common;
use borsh::BorshDeserialize;
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
use num_bigint::{BigInt, BigUint};
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
    }
}

#[test]
fn transact_spl_deposit_running_correctly() {
    let mut ctx = setup();

    let deposit_amount = 100; // 100 spl_mint_tokens from user_ata to spl_tree_ata
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
    assert_eq!(spl_tree_ata_state.amount, 100);
}

fn deposit_sol_withdraw_usdc() {
    let mut ctx = setup();
    // Part 1 : Depositing SOL

    let deposit_amount = 20000; // SOL
    let calculated_deposit_fee = calculate_deposit_fee(deposit_amount);

    let deposit_ext_data = ExtData {
        recipient: ctx.recipient.pubkey().to_bytes(),
        ext_amount: i64::try_from(deposit_amount).unwrap(),
        encrypted_output1: b"depositEncryptedOutput1".to_vec(),
        encrypted_output2: b"depositEncryptedOutput2".to_vec(),
        fee: calculated_deposit_fee,
        fee_recipient: FEE_RECIPIENT_ACCOUNT.to_bytes(),
        mint_address: Pubkey::from_str("11111111111111111111111111111112") // SOL Mint
            .unwrap()
            .to_bytes(),
    };

    // Cuz this is the first deposit , we make them empty
    let deposit_inputs = [Utxo::empty(), Utxo::empty()];

    let field_size = BigInt::from_str(FIELD_SIZE_DECIMAL).unwrap();

    let ext_amount = BigInt::from(deposit_ext_data.ext_amount);
    let deposit_fee = BigInt::from(calculated_deposit_fee);

    let public_amount_number = (ext_amount - calculated_deposit_fee + &field_size) % &field_size;

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
        &FEE_RECIPIENT_ACCOUNT,
    );

    let deposit_lookup_table_address = create_global_test_alt(
        &mut ctx.svm,
        &ctx.authority,
        &ctx.authority,
        &deposit_test_protocol_addresses,
    );

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

    // Update our local Merkle tree to match the on-chain state.
    for commitment in deposit_output_commitments {
        ctx.sol_merkle_tree.insert(commitment);
    }
}
