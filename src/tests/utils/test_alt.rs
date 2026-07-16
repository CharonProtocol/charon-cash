use core::slice::SlicePattern;

use litesvm::LiteSVM;
use solana_address_lookup_table_interface::{
    instruction::create_lookup_table, state::AddressLookupTable,
};
use solana_clock::Clock;
use solana_keypair::{Address, Keypair};
use solana_message::{v0, AddressLookupTableAccount, Instruction, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

/// Builds, sends, and returns the address of a new global test ALT.
/// Retries once with a fresh slot if the first attempt fails because
/// the chosen slot is no longer "recent" from the runtime's point of view.
pub fn create_global_test_alt(
    svm: &mut LiteSVM,
    payer: Keypair,
    authority: Keypair,
    addresses: &[Address],
) -> Address {
    let try_create = |svm: &mut LiteSVM, slot: u64| -> Result<Address, String> {
        let (create_alt_ix, alt_address) =
            create_lookup_table(authority.pubkey(), payer.pubkey(), slot);
        let alt_account = AddressLookupTableAccount {
            key: alt_address,
            addresses: addresses.to_vec(),
        };

        let message = v0::Message::try_compile(
            &payer.pubkey(),
            &[create_alt_ix],
            &[alt_account],
            svm.latest_blockhash(),
        )
        .map_err(|e| format!("failed to compile message: {e}"))?;

        let tx = VersionedTransaction::try_new(VersionedMessage::V0(message), &[&payer])
            .map_err(|e| format!("failed to sign transaction: {e}"))?;

        svm.send_transaction(tx)
            .map(|_| alt_address)
            .map_err(|e| e.meta.logs.join("\n"))
    };

    let clock: Clock = svm.get_sysvar();
    match try_create(svm, clock.slot) {
        Ok(addr) => addr,
        Err(logs) if logs.contains("not a recent slot") => {
            let newer_clock: Clock = svm.get_sysvar();
            try_create(svm, newer_clock.slot)
                .expect("retry with fresh slot failed to create lookup table")
        }
        Err(logs) => panic!("failed to create lookup table: {logs}"),
    }
}

pub fn get_protocol_address(program_id: &Address) -> Vec<Address> {
    let (global_config_account, _) =
        Address::derive_program_address(&[b"global_config"], program_id).unwrap();
    let (tree_account, _) = Address::derive_program_address(&[b"merkle_tree"], program_id).unwrap();
    let (tree_token_account, _) =
        Address::derive_program_address(&[b"tree_token"], program_id).unwrap();

    vec![global_config_account, tree_account, tree_token_account]
}

pub fn get_test_protocol_address_with_mint(program_id: &Address) -> Vec<Address> {
    let (global_config_account, _) =
        Address::derive_program_address(&[b"global_config"], program_id).unwrap();
    let (tree_account, _) = Address::derive_program_address(&[b"merkle_tree"], program_id).unwrap();

    vec![global_config_account, tree_account]
}

pub fn create_versioned_tx_with_alt(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instructions: &[Instruction],
    alt_address: &Address,
) -> VersionedTransaction {
    let alt_account_raw = svm
        .get_account(alt_address)
        .expect("lookup table account not found");

    let alt_table = AddressLookupTable::deserialize(&alt_account_raw.data)
        .expect("failed to deserialize lookup table");

    let alt_account = AddressLookupTableAccount {
        key: *alt_address,
        addresses: alt_table.addresses.to_vec(),
    };

    let message = v0::Message::try_compile(
        &payer.pubkey(),
        instructions,
        &[alt_account],
        svm.latest_blockhash(),
    )
    .expect("failed to compile v0 message");

    let mut tx_signers: Vec<&Keypair> = Vec::with_capacity(1 + signers.len());
    tx_signers.push(payer);
    tx_signers.extend_from_slice(signers);
    VersionedTransaction::try_new(VersionedMessage::V0(message), &tx_signers)
        .expect("failed to build versioned transaction")
}
