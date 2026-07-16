//! Encoding of the `Transact` instruction: data bytes and account metas.

use crate::program::{
    global_config_pda, nullifier_pdas, tree_account_pda, tree_token_pda, NullifierPdas, PROGRAM_ID,
};
use pc_prover::ProofBytes;
use pc_types::PrivacyCashInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

/// Serialize the on-wire `Proof` struct (480 bytes) from a prover result.
///
/// Field order matches the program's `state::Proof`: the three proof points, then the seven
/// public signals (root, publicAmount, extDataHash, 2 nullifiers, 2 commitments).
fn encode_proof(proof: &ProofBytes) -> Vec<u8> {
    let mut out = Vec::with_capacity(480);
    out.extend_from_slice(&proof.proof_a);
    out.extend_from_slice(&proof.proof_b);
    out.extend_from_slice(&proof.proof_c);
    for sig in &proof.public_signals {
        out.extend_from_slice(sig);
    }
    debug_assert_eq!(out.len(), pc_types::wire::PROOF_SIZE);
    out
}

/// Build the full `Transact` / `TransactSpl` instruction data:
/// `disc | Proof(480) | ext_amount(i64) | fee(u64) | len+enc1 | len+enc2 | bump0 | bump1`.
pub fn build_transact_ix_data(
    disc: PrivacyCashInstruction,
    proof: &ProofBytes,
    ext_amount: i64,
    fee: u64,
    enc1: &[u8],
    enc2: &[u8],
    bump0: u8,
    bump1: u8,
) -> Vec<u8> {
    let mut d = Vec::with_capacity(1 + 480 + 16 + 8 + enc1.len() + enc2.len() + 2);
    d.push(disc as u8);
    d.extend_from_slice(&encode_proof(proof));
    d.extend_from_slice(&ext_amount.to_le_bytes());
    d.extend_from_slice(&fee.to_le_bytes());
    d.extend_from_slice(&(enc1.len() as u32).to_le_bytes());
    d.extend_from_slice(enc1);
    d.extend_from_slice(&(enc2.len() as u32).to_le_bytes());
    d.extend_from_slice(enc2);
    d.push(bump0);
    d.push(bump1);
    d
}

/// The SOL `Transact` instruction, ready to submit. `signer` is the fee payer (may be a relayer,
/// decoupled from `recipient`).
#[allow(clippy::too_many_arguments)]
pub fn build_sol_transact_ix(
    proof: &ProofBytes,
    ext_amount: i64,
    fee: u64,
    enc1: &[u8],
    enc2: &[u8],
    recipient: Pubkey,
    fee_recipient: Pubkey,
    signer: Pubkey,
) -> Instruction {
    let (tree_account, _) = tree_account_pda();
    let (tree_token, _) = tree_token_pda();
    let (global_config, _) = global_config_pda();

    let n0 = &proof.public_signals[3];
    let n1 = &proof.public_signals[4];
    let NullifierPdas {
        nullifier0,
        bump0,
        nullifier1,
        bump1,
        nullifier2,
        nullifier3,
    } = nullifier_pdas(n0, n1);

    let data = build_transact_ix_data(
        PrivacyCashInstruction::Transact,
        proof,
        ext_amount,
        fee,
        enc1,
        enc2,
        bump0,
        bump1,
    );

    // Account order matches the program's `process_transact` destructuring.
    let accounts = vec![
        AccountMeta::new(tree_account, false),
        AccountMeta::new(nullifier0, false),
        AccountMeta::new(nullifier1, false),
        AccountMeta::new(nullifier2, false),
        AccountMeta::new(nullifier3, false),
        AccountMeta::new(tree_token, false),
        AccountMeta::new_readonly(global_config, false),
        AccountMeta::new(recipient, false),
        AccountMeta::new(fee_recipient, false),
        AccountMeta::new(signer, true),
        AccountMeta::new_readonly(solana_pubkey::pubkey!("11111111111111111111111111111111"), false),
    ];

    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data,
    }
}
