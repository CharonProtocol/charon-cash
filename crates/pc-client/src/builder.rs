//! Assembling a deposit or withdrawal: choose the notes, encrypt them, build the circuit witness,
//! prove, and produce a ready-to-submit instruction.
//!
//! Amount bookkeeping (all values in lamports / base units):
//!
//! * **deposit `X`**: two zero-value dummy inputs; outputs are the user's note of `X` and a zero
//!   note. `ext_amount = +X`, `public_amount = X - fee`.
//! * **withdraw `R` to `recipient` with fee `F`** from a note of `N`: inputs are that note plus a
//!   dummy; outputs are a change note of `C = N - R - F` and a zero note. `ext_amount = -R`,
//!   `public_amount = -(R + F)`. The program pays `R` to the recipient and `F` to the fee
//!   recipient, consuming `R + F` of shielded value; the remaining `C` stays shielded.

use crate::ix::build_sol_transact_ix;
use anyhow::{anyhow, Result};
use pc_core::field::{fr_from_be_bytes_mod_order, fr_from_u64};
use pc_core::mint::{mint_address_field, SOL_MINT};
use pc_core::{ExtData, Fr, Keypair, MerkleTree, Utxo};
use pc_note::{NoteCipher, NotePlaintext};
use pc_prover::{prove, CircuitInputs, MERKLE_DEPTH};
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;

/// A built transaction plus the output notes it creates. The caller must set each output note's
/// `index` to the leaf index the program reports in its event before persisting or spending it.
pub struct BuiltTransact {
    pub instruction: Instruction,
    /// `[change/deposit note, zero note]`, in output-commitment order.
    pub output_notes: [Utxo; 2],
    /// The encrypted blobs submitted on-chain, positionally matching `output_notes`. Returned so a
    /// caller can feed its local scan/tree without re-encrypting (which would use a new nonce).
    pub encrypted_outputs: [Vec<u8>; 2],
}

fn note_plaintext(u: &Utxo) -> NotePlaintext {
    NotePlaintext {
        amount: u.amount,
        blinding: u.blinding,
        mint: u.mint,
    }
}

/// Build a SOL deposit of `amount` lamports. `fee` is normally 0 (deposits are free).
#[allow(clippy::too_many_arguments)]
pub fn build_sol_deposit(
    user: &Keypair,
    amount: u64,
    fee: u64,
    recipient: Pubkey,
    fee_recipient: Pubkey,
    signer: Pubkey,
    root: &[u8; 32],
    zkey_path: &str,
) -> Result<BuiltTransact> {
    if amount <= fee {
        return Err(anyhow!("deposit amount must exceed fee"));
    }
    let mint = SOL_MINT;
    let cipher = NoteCipher::from_keypair(user);

    // Outputs: the user's shielded note, and a zero note (both owned by the user).
    let out0 = Utxo::new(amount - fee, *user, mint);
    let out1 = Utxo::new(0, *user, mint);
    let enc1 = cipher.encrypt(&note_plaintext(&out0));
    let enc2 = cipher.encrypt(&note_plaintext(&out1));

    let ext = ExtData {
        recipient: recipient.to_bytes(),
        ext_amount: amount as i64,
        encrypted_output1: &enc1,
        encrypted_output2: &enc2,
        fee,
        fee_recipient: fee_recipient.to_bytes(),
        mint_address: mint,
    };

    // Two dummy inputs; the circuit skips the Merkle check at amount 0.
    let in0 = Utxo::dummy();
    let in1 = Utxo::dummy();

    let inputs = CircuitInputs {
        root: fr_from_be_bytes_mod_order(root),
        public_amount: fr_from_u64(amount - fee),
        ext_data_hash: fr_from_be_bytes_mod_order(&ext.hash_field_be32()),
        mint_address: mint_address_field(&mint),
        input_nullifiers: [nullifier_fr(&in0), nullifier_fr(&in1)],
        in_amounts: [Fr::from(0u64), Fr::from(0u64)],
        in_private_keys: [in0.keypair.privkey(), in1.keypair.privkey()],
        in_blindings: [in0.blinding, in1.blinding],
        in_path_indices: [Fr::from(0u64), Fr::from(0u64)],
        in_path_elements: [[Fr::from(0u64); MERKLE_DEPTH]; 2],
        output_commitments: [out0.commitment(), out1.commitment()],
        out_amounts: [fr_from_u64(out0.amount), Fr::from(0u64)],
        out_pubkeys: [out0.keypair.pubkey(), out1.keypair.pubkey()],
        out_blindings: [out0.blinding, out1.blinding],
    };

    let proof = prove(&inputs, zkey_path)?;
    let instruction = build_sol_transact_ix(
        &proof,
        amount as i64,
        fee,
        &enc1,
        &enc2,
        recipient,
        fee_recipient,
        signer,
    );

    Ok(BuiltTransact {
        instruction,
        output_notes: [out0, out1],
        encrypted_outputs: [enc1, enc2],
    })
}

/// Build a SOL withdrawal of `recipient_amount` (`R`) to `recipient`, paying `fee` (`F`), spending
/// `note` (which must already carry its real leaf `index` and be present in `tree`).
#[allow(clippy::too_many_arguments)]
pub fn build_sol_withdraw(
    user: &Keypair,
    note: &Utxo,
    recipient_amount: u64,
    fee: u64,
    recipient: Pubkey,
    fee_recipient: Pubkey,
    signer: Pubkey,
    tree: &MerkleTree,
    zkey_path: &str,
) -> Result<BuiltTransact> {
    let change = note
        .amount
        .checked_sub(recipient_amount)
        .and_then(|v| v.checked_sub(fee))
        .ok_or_else(|| anyhow!("note {} too small for R={recipient_amount}+F={fee}", note.amount))?;

    let mint = SOL_MINT;
    let cipher = NoteCipher::from_keypair(user);

    let out0 = Utxo::new(change, *user, mint); // change note
    let out1 = Utxo::new(0, *user, mint);
    let enc1 = cipher.encrypt(&note_plaintext(&out0));
    let enc2 = cipher.encrypt(&note_plaintext(&out1));

    let ext_amount = -(recipient_amount as i64);
    let ext = ExtData {
        recipient: recipient.to_bytes(),
        ext_amount,
        encrypted_output1: &enc1,
        encrypted_output2: &enc2,
        fee,
        fee_recipient: fee_recipient.to_bytes(),
        mint_address: mint,
    };

    // public_amount = -(R + F) as a field element.
    let public_amount = -(fr_from_u64(recipient_amount) + fr_from_u64(fee));

    let path = tree
        .path_elements(note.index as u64)
        .ok_or_else(|| anyhow!("note leaf {} not in tree mirror", note.index))?;
    let dummy = Utxo::dummy();

    let inputs = CircuitInputs {
        root: fr_from_be_bytes_mod_order(&tree.root_be32()),
        public_amount,
        ext_data_hash: fr_from_be_bytes_mod_order(&ext.hash_field_be32()),
        mint_address: mint_address_field(&mint),
        input_nullifiers: [nullifier_fr(note), nullifier_fr(&dummy)],
        in_amounts: [fr_from_u64(note.amount), Fr::from(0u64)],
        in_private_keys: [note.keypair.privkey(), dummy.keypair.privkey()],
        in_blindings: [note.blinding, dummy.blinding],
        in_path_indices: [fr_from_u64(note.index as u64), Fr::from(0u64)],
        in_path_elements: [path, [Fr::from(0u64); MERKLE_DEPTH]],
        output_commitments: [out0.commitment(), out1.commitment()],
        out_amounts: [fr_from_u64(out0.amount), Fr::from(0u64)],
        out_pubkeys: [out0.keypair.pubkey(), out1.keypair.pubkey()],
        out_blindings: [out0.blinding, out1.blinding],
    };

    let proof = prove(&inputs, zkey_path)?;
    let instruction = build_sol_transact_ix(
        &proof,
        ext_amount,
        fee,
        &enc1,
        &enc2,
        recipient,
        fee_recipient,
        signer,
    );

    Ok(BuiltTransact {
        instruction,
        output_notes: [out0, out1],
        encrypted_outputs: [enc1, enc2],
    })
}

/// A note's nullifier as a field element (its `index` must already be the real leaf index).
fn nullifier_fr(u: &Utxo) -> Fr {
    fr_from_be_bytes_mod_order(&u.nullifier_be32())
}
