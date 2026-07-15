#[cfg(test)]
mod test {
    use litesvm::LiteSVM;
    use pinocchio::{address::address, Address};
    use solana_keypair::Keypair;
    use solana_message::{AccountMeta, Instruction, Message};
    use solana_native_token::LAMPORTS_PER_SOL;
    use solana_signer::Signer;
    use solana_transaction::Transaction;

    pub const PROGRAM_ID: Address = address!("HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV");

    fn setup() -> (LiteSVM, Keypair) {
        let mut svm = LiteSVM::new();
        let payer = Keypair::new();

        svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL)
            .expect("Airdrop failed");

        let program_bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/sbpf-solana-solana/release/privacy_cash.so"
        ));

        svm.add_program(PROGRAM_ID, program_bytes)
            .expect("Failed to add program");

        (svm, payer)
    }

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct TestInitializeTreeTokenAccountParams {
        max_deposit_amount: u64,
        tree_account_bump: u8,
        padding: [u8; 7],
    }

    fn setup_initialize(svm: &mut LiteSVM, admin: &Keypair) {
        let (tree_account_pda, tree_account_bump) =
            Address::find_program_address(&[b"merkle_tree"], &PROGRAM_ID);
        let (tree_token_account_pda, tree_token_account_bump) =
            Address::find_program_address(&[b"tree_token"], &PROGRAM_ID);
        let (global_config_pda, global_config_bump) =
            Address::find_program_address(&[b"global_config"], &PROGRAM_ID);

        let system_program = solana_sdk_ids::system_program::ID;
        let ix_data = vec![
            0u8,
            tree_account_bump,
            tree_token_account_bump,
            global_config_bump,
        ];

        let accounts = vec![
            AccountMeta::new(tree_account_pda, false),
            AccountMeta::new(tree_token_account_pda, false),
            AccountMeta::new(global_config_pda, false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(system_program, false),
        ];

        let initialize_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: ix_data,
        };

        let message = Message::new(&[initialize_ix], Some(&admin.pubkey()));
        let recent_blockhash = svm.latest_blockhash();

        let transaction = Transaction::new(&[admin], message, recent_blockhash);
        let tx = svm.send_transaction(transaction).unwrap();
        println!("\n Initialize Global Config Successful!");
        println!("CUs Consumed: {}", tx.compute_units_consumed);
        for log in &tx.logs {
            println!("  {}", log);
        }
    }

    fn setup_initialize_tree_account_for_spl_token(svm: &mut LiteSVM, admin: &Keypair) {
        let mint = address!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        let (tree_account_pda, tree_account_bump) =
            Address::find_program_address(&[b"merkle_tree", mint.as_ref()], &PROGRAM_ID);
        let (global_config_pda, _global_config_bump) =
            Address::find_program_address(&[b"global_config"], &PROGRAM_ID);

        let system_program = solana_sdk_ids::system_program::ID;
        let max_deposit_amount: u64 = 1_000_000_000;

        let mut ix_data = vec![1u8];
        ix_data.extend_from_slice(&max_deposit_amount.to_le_bytes());
        ix_data.extend_from_slice(&[tree_account_bump]);
        ix_data.extend_from_slice(&[0u8; 7]);

        let accounts = vec![
            AccountMeta::new(tree_account_pda, false),
            AccountMeta::new(mint, false),
            AccountMeta::new(global_config_pda, false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(system_program, false),
        ];

        let initialize_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: ix_data,
        };

        let message = Message::new(&[initialize_ix], Some(&admin.pubkey()));
        let recent_blockhash = svm.latest_blockhash();

        let transaction = Transaction::new(&[admin], message, recent_blockhash);
        let tx = svm.send_transaction(transaction).unwrap();
        println!("\n Initialize Tree Account for SPL Token Successful!");
        println!("CUs Consumed: {}", tx.compute_units_consumed);
        for log in &tx.logs {
            println!("  {}", log);
        }
    }

    #[test]
    fn test_initialize() {
        let (mut svm, admin) = setup();
        setup_initialize(&mut svm, &admin);
    }

    #[test]
    fn test_initialize_tree_account_for_spl_token() {
        let (mut svm, admin) = setup();
        setup_initialize(&mut svm, &admin);
        setup_initialize_tree_account_for_spl_token(&mut svm, &admin);
    }
}
