//! End-to-end protocol test on litesvm, with real Groth16 proofs.
//!
//! This is the whole system in one process — no validator, no Postgres, no relayer:
//!
//!   initialize → deposit (real proof) → read the commitment event → scan & decrypt → build the
//!   Merkle mirror → withdraw to a fresh unfunded address (real proof, real path) → verify the
//!   recipient was paid and never signed → confirm a replayed withdrawal is rejected.
//!
//! It is the definitive gate for the ported program plus the entire Rust client stack, and it is
//! what finally exercises the Phase 1 leaf-index event against a real transaction.

use std::collections::HashSet;

use litesvm::LiteSVM;
use pc_client::{balance, build_sol_deposit, build_sol_withdraw, scan, Leaf};
use pc_core::{Keypair as ShieldedKeypair, MerkleTree};
use pc_types::event::CommitmentEvent;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV");

fn zkey_path() -> String {
    format!(
        "{}/../../artifacts/circuits/transaction2.zkey",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn program_so() -> Vec<u8> {
    let path = format!(
        "{}/../../target/sbpf-solana-solana/release/privacy_cash.so",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|_| panic!("build the SBF program first: {path}"))
}

/// pinocchio program addresses are derived the same way the client derives them.
fn pdas() -> (Pubkey, u8, Pubkey, u8, Pubkey, u8) {
    let (tree, tb) = Pubkey::find_program_address(&[b"merkle_tree"], &PROGRAM_ID);
    let (token, kb) = Pubkey::find_program_address(&[b"tree_token"], &PROGRAM_ID);
    let (cfg, cb) = Pubkey::find_program_address(&[b"global_config"], &PROGRAM_ID);
    (tree, tb, token, kb, cfg, cb)
}

fn tx(svm: &LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> Transaction {
    // 1.4M CU: the pairing check alone is ~1M, far over the 200k default.
    let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
    all.extend_from_slice(ixs);
    let msg = Message::new(&all, Some(&payer.pubkey()));
    Transaction::new(&[payer], msg, svm.latest_blockhash())
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ixs: &[Instruction],
) -> litesvm::types::TransactionMetadata {
    let t = tx(svm, payer, ixs);
    svm.send_transaction(t).expect("transaction failed")
}

fn initialize(svm: &mut LiteSVM, admin: &Keypair, fee_recipient: Pubkey) {
    let (tree, tb, token, kb, cfg, cb) = pdas();
    let mut data = vec![0u8, tb, kb, cb];
    data.extend_from_slice(&fee_recipient.to_bytes());
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(tree, false),
            AccountMeta::new(token, false),
            AccountMeta::new(cfg, false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
        data,
    };
    // initialize needs no extra compute; send it on its own (no compute-budget prefix).
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    let t = Transaction::new(&[admin], msg, svm.latest_blockhash());
    svm.send_transaction(t).expect("initialize failed");
}

/// Read the on-chain tree's current root (root_history[root_index]) from account bytes.
fn onchain_root(svm: &LiteSVM) -> [u8; 32] {
    let (tree, ..) = pdas();
    let acct = svm.get_account(&tree).expect("tree account");
    // MerkleTreeAccount layout: max_deposit_amount(8) next_index(4) root_index(1) bump(1)
    // _padding(2) subtrees(26*32=832) root_history(100*32) authority(32).
    let root_index = acct.data[12] as usize;
    let history_off = 8 + 4 + 1 + 1 + 2 + 832;
    let start = history_off + root_index * 32;
    acct.data[start..start + 32].try_into().unwrap()
}

fn lamports(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}

#[test]
fn full_deposit_scan_withdraw_flow() {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();
    svm.add_program(PROGRAM_ID, &program_so()).unwrap();

    // The relayer/fee account and the tx fee-payer. Distinct from the shielded wallet.
    let fee_recipient = Keypair::new();
    svm.airdrop(&fee_recipient.pubkey(), LAMPORTS_PER_SOL).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();

    initialize(&mut svm, &admin, fee_recipient.pubkey());

    // ---- DEPOSIT ----
    let user = ShieldedKeypair::generate();
    let deposit_amount = 5 * LAMPORTS_PER_SOL;
    let empty_root = MerkleTree::new().root_be32();

    let mut deposit = build_sol_deposit(
        &user,
        deposit_amount,
        0, // deposits are free
        payer.pubkey(), // recipient is unused for a deposit; bind the payer
        fee_recipient.pubkey(),
        payer.pubkey(),
        &empty_root,
        &zkey_path(),
    )
    .expect("build deposit");

    let (tree_pda, .., token_pda, _, _cfg, _) = pdas();
    let token_before = lamports(&svm, &token_pda);

    let meta = send(&mut svm, &payer, std::slice::from_ref(&deposit.instruction));

    // The event carries the authoritative leaf index (0 for the first deposit) and the new root.
    let events = parse_events(&meta.logs);
    assert_eq!(events.len(), 1, "expected one commitment event");
    assert_eq!(events[0].leaf_index, 0);
    assert_eq!(events[0].root, onchain_root(&svm), "event root must equal chain root");

    // Funds moved into the shielded pool.
    assert_eq!(lamports(&svm, &token_pda) - token_before, deposit_amount);

    // Assign the real leaf indices the event reported.
    deposit.output_notes[0].index = events[0].leaf_index;
    deposit.output_notes[1].index = events[0].leaf_index + 1;

    // ---- SCAN ----
    let leaves = vec![
        Leaf {
            leaf_index: events[0].leaf_index,
            commitment: deposit.output_notes[0].commitment_be32(),
            encrypted_output: deposit.encrypted_outputs[0].clone(),
        },
        Leaf {
            leaf_index: events[0].leaf_index + 1,
            commitment: deposit.output_notes[1].commitment_be32(),
            encrypted_output: deposit.encrypted_outputs[1].clone(),
        },
    ];
    let owned = scan(&user, &leaves, &HashSet::new());
    assert_eq!(balance(&owned), deposit_amount, "scan must recover the deposit");
    let note = owned.iter().find(|n| !n.spent).unwrap().utxo;

    // ---- Build the local Merkle mirror from the (ordered) commitments ----
    let mut tree = MerkleTree::new();
    tree.append_be32(&deposit.output_notes[0].commitment_be32());
    tree.append_be32(&deposit.output_notes[1].commitment_be32());
    assert_eq!(tree.root_be32(), onchain_root(&svm), "mirror root must equal chain root");

    // ---- WITHDRAW to a fresh, unfunded address ----
    let recipient = Keypair::new();
    assert_eq!(lamports(&svm, &recipient.pubkey()), 0);

    let r = 2 * LAMPORTS_PER_SOL; // to the recipient
    let f = r * 25 / 10_000; // 0.25% withdrawal fee (the initialized rate)

    let withdraw = build_sol_withdraw(
        &user,
        &note,
        r,
        f,
        recipient.pubkey(),
        fee_recipient.pubkey(),
        payer.pubkey(),
        &tree,
        &zkey_path(),
    )
    .expect("build withdraw");

    let fee_before = lamports(&svm, &fee_recipient.pubkey());
    let wmeta = send(&mut svm, &payer, std::slice::from_ref(&withdraw.instruction));

    // Recipient received exactly R and never signed anything (only the payer did).
    assert_eq!(lamports(&svm, &recipient.pubkey()), r);
    assert_eq!(lamports(&svm, &fee_recipient.pubkey()) - fee_before, f);

    // A second commitment event for the change note, at leaf index 2.
    let wevents = parse_events(&wmeta.logs);
    assert_eq!(wevents.len(), 1);
    assert_eq!(wevents[0].leaf_index, 2);

    // ---- DOUBLE-SPEND must fail (nullifier already initialized) ----
    let replay = build_sol_withdraw(
        &user, &note, r, f, recipient.pubkey(), fee_recipient.pubkey(), payer.pubkey(),
        &tree, &zkey_path(),
    )
    .unwrap();
    let replay_tx = tx(&svm, &payer, std::slice::from_ref(&replay.instruction));
    assert!(
        svm.send_transaction(replay_tx).is_err(),
        "replaying a spent note must fail at nullifier init"
    );

    let _ = tree_pda;
}

fn parse_events(logs: &[String]) -> Vec<CommitmentEvent> {
    use base64::Engine;
    let magic = base64::engine::general_purpose::STANDARD.encode(pc_types::event::EVENT_MAGIC);
    let mut out = Vec::new();
    for line in logs {
        if let Some(rest) = line.strip_prefix("Program data: ") {
            let mut it = rest.split(' ');
            if let (Some(a), Some(b)) = (it.next(), it.next()) {
                if a == magic {
                    if let Ok(payload) = base64::engine::general_purpose::STANDARD.decode(b) {
                        if let Some(ev) = CommitmentEvent::decode(&payload) {
                            out.push(ev);
                        }
                    }
                }
            }
        }
    }
    out
}
