//! Transact-proof test helpers shared by the SOL and SPL suites.
#![allow(dead_code)]
use bytemuck::bytes_of;
use privacy_cash::state::transact::{Proof, RawProof};
use solana_sdk::instruction::Instruction;

/// The same instruction with the compressed (swap-style) proof in place of
/// the raw one: 2/3 must reject it.
pub fn with_compressed_proof(ix: &Instruction, compressed: &Proof) -> Instruction {
    let raw_size = core::mem::size_of::<RawProof>();
    let mut data = vec![ix.data[0]];
    data.extend_from_slice(bytes_of(compressed));
    data.extend_from_slice(&ix.data[1 + raw_size..]);
    Instruction { program_id: ix.program_id, accounts: ix.accounts.clone(), data }
}

/// Flip one byte of the raw proof's A point.
pub fn tamper_raw_proof(ix: &Instruction) -> Instruction {
    let mut ix = ix.clone();
    ix.data[1 + 10] ^= 0x01;
    ix
}

/// The tx logged exactly one transact event with these fields.
pub fn assert_transact_event(
    logs: &[String],
    mint: Option<[u8; 32]>,
    first_leaf_index: u32,
    commitments: &[[u8; 32]; 2],
    nullifiers: &[[u8; 32]; 2],
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
) {
    use base64::Engine;
    let events: Vec<Vec<u8>> = logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .collect();
    assert_eq!(events.len(), 1, "expected one event, logs: {logs:#?}");
    let mut want = Vec::new();
    want.extend_from_slice(if mint.is_some() {
        &privacy_cash::helper::TRANSACT_SPL_EVENT
    } else {
        &privacy_cash::helper::TRANSACT_EVENT
    });
    want.extend_from_slice(&first_leaf_index.to_le_bytes());
    if let Some(m) = mint {
        want.extend_from_slice(&m);
    }
    for c in commitments.iter().chain(nullifiers.iter()) {
        want.extend_from_slice(c);
    }
    for enc in [encrypted_output1, encrypted_output2] {
        want.extend_from_slice(&(enc.len() as u32).to_le_bytes());
        want.extend_from_slice(enc);
    }
    assert_eq!(events[0], want, "event bytes differ");
}
