use std::sync::{Mutex, OnceLock};

use litesvm::LiteSVM;
use solana_address_lookup_table_interface::{
    instruction::{create_lookup_table, extend_lookup_table},
    state::AddressLookupTable,
};
use solana_clock::Clock;
use solana_keypair::{Address, Keypair};
use solana_message::{v0, AddressLookupTableAccount, Instruction, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, Transaction};

static GLOBAL_TEST_ALT: OnceLock<Mutex<Option<Address>>> = OnceLock::new();

fn alt_cache() -> &'static Mutex<Option<Address>> {
    GLOBAL_TEST_ALT.get_or_init(|| Mutex::new(None))
}

pub fn reset_global_test_alt() {
    *alt_cache().lock().unwrap() = None;
}

pub fn get_global_test_alt() -> Address {
    alt_cache()
        .lock()
        .unwrap()
        .as_ref()
        .copied()
        .expect("Global test ALT not created yet")
}

/// JS equivalent:
/// - createLookupTable(...)
/// - send create tx
/// - extend in chunks
/// - cache globally for the test session
pub fn create_global_test_alt(
    svm: &mut LiteSVM,
    payer: &Keypair,
    authority: &Keypair,
    addresses: &[Address],
) -> Address {
    if let Some(addr) = *alt_cache().lock().unwrap() {
        // Reuse only if this ALT exists in the current LiteSVM
        if svm.get_account(&addr).is_some() {
            return addr;
        }

        // Stale cache from a different test / different LiteSVM
        *alt_cache().lock().unwrap() = None;
    }

    let create_once = |svm: &mut LiteSVM, slot: u64| -> Result<Address, String> {
        let (create_ix, alt_address) =
            create_lookup_table(authority.pubkey(), payer.pubkey(), slot);

        let tx = Transaction::new_signed_with_payer(
            &[create_ix],
            Some(&payer.pubkey()),
            &[payer],
            svm.latest_blockhash(),
        );

        svm.send_transaction(tx)
            .map_err(|e| e.meta.logs.join("\n"))?;

        // Mirror the JS behavior: extend the table in chunks.
        // 20 is a good conservative chunk size for ALT extend calls.
        for chunk in addresses.chunks(20) {
            let extend_ix = extend_lookup_table(
                alt_address,
                authority.pubkey(),
                Some(payer.pubkey()),
                chunk.to_vec(),
            );

            let extend_tx = Transaction::new_signed_with_payer(
                &[extend_ix],
                Some(&payer.pubkey()),
                &[payer, authority],
                svm.latest_blockhash(),
            );

            svm.send_transaction(extend_tx)
                .map_err(|e| e.meta.logs.join("\n"))?;
        }

        // Verify the table really exists on-chain in LiteSVM.
        let raw = svm
            .get_account(&alt_address)
            .ok_or_else(|| "lookup table account not found".to_string())?;

        let table = AddressLookupTable::deserialize(&raw.data)
            .map_err(|e| format!("failed to deserialize ALT: {e:?}"))?;

        if table.addresses.is_empty() {
            return Err("ALT was created but not extended".to_string());
        }

        Ok(alt_address)
    };

    let clock: Clock = svm.get_sysvar();
    match create_once(svm, clock.slot) {
        Ok(addr) => {
            *alt_cache().lock().unwrap() = Some(addr);
            addr
        }
        Err(logs) if logs.contains("not a recent slot") => {
            let newer_clock: Clock = svm.get_sysvar();
            let addr = create_once(svm, newer_clock.slot)
                .expect("retry with fresh slot failed to create lookup table");
            *alt_cache().lock().unwrap() = Some(addr);
            addr
        }
        Err(logs) => panic!("failed to create lookup table: {logs}"),
    }
}

pub fn get_test_protocol_addresses(
    program_id: &Address,
    authority: &Address,
    fee_recipient: &Address,
) -> Vec<Address> {
    let (global_config, _) =
        Address::derive_program_address(&[b"global_config"], program_id).unwrap();
    let (tree_account, _) =
        Address::derive_program_address(&[b"merkle_tree"], program_id).unwrap();
    let (tree_token_account, _) =
        Address::derive_program_address(&[b"tree_token"], program_id).unwrap();

    vec![
        *program_id,
        tree_account,
        tree_token_account,
        global_config,
        *authority,
        *fee_recipient,
        solana_system_interface::program::ID,
        solana_compute_budget_interface::ID,
    ]
}

pub fn get_test_protocol_addresses_with_mint(
    program_id: &Address,
    authority: &Address,
    tree_ata: &Address,
    fee_recipient: &Address,
    fee_recipient_ata: &Address,
    spl_tree_account: &Address,
    mint: &Address,
) -> Vec<Address> {
    let (global_config, _) =
        Address::derive_program_address(&[b"global_config"], program_id).unwrap();
    let (tree_account, _) =
        Address::derive_program_address(&[b"merkle_tree"], program_id).unwrap();

    vec![
        *program_id,
        tree_account,
        *tree_ata,
        global_config,
        *authority,
        *fee_recipient,
        *fee_recipient_ata,
        *spl_tree_account,
        *mint,
        solana_system_interface::program::ID,
        solana_compute_budget_interface::ID,
        spl_associated_token_account_interface::program::ID,
        spl_token_2022::ID,
    ]
}

pub fn create_versioned_tx_with_alt(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instructions: &[Instruction],
    alt_address: &Address,
) -> VersionedTransaction {
    let alt_raw = svm
        .get_account(alt_address)
        .expect("lookup table account not found");

    let alt_table = AddressLookupTable::deserialize(&alt_raw.data)
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