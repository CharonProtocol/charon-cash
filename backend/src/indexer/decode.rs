//! Decoding of `Transact` / `TransactSpl` instruction data and of the program's commitment event.
//!
//! Commitments, nullifiers, encrypted outputs, amount and fee all live in the instruction data
//! (the `Proof` and `ExtDataMinified` args). The authoritative **leaf index** and the
//! post-append **root** do not — they arrive in a `sol_log_data` event. Both are decoded here.
//!
//! Layout constants come from [`pc_types::wire`], shared with the program, so they cannot drift.

use base64::Engine;
use pc_types::event::{CommitmentEvent, EVENT_MAGIC};
use pc_types::wire::{
    EXT_DATA_MINIFIED_SIZE, OFF_COMMITMENT0, OFF_COMMITMENT1, OFF_EXT_DATA, OFF_EXT_DATA_HASH,
    OFF_NULLIFIER0, OFF_NULLIFIER1, OFF_PUBLIC_AMOUNT, OFF_ROOT, PROOF_SIZE,
};
use pc_types::PrivacyCashInstruction;
use thiserror::Error;

use super::types::{DecodedTransact, TransactKind};

const FIXED_TRANSACT_ARGS_SIZE: usize = PROOF_SIZE + EXT_DATA_MINIFIED_SIZE;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DecodeError {
    #[error("instruction data too short")]
    TooShort,
    #[error("not a transact instruction")]
    NotTransact,
    #[error("invalid length-prefixed field")]
    InvalidLengthPrefix,
    #[error("trailing bytes after parsed payload")]
    TrailingBytes,
    #[error("missing nullifier bumps")]
    MissingNullifierBumps,
}

/// Decode a `Transact` / `TransactSpl` instruction payload. Returns [`DecodeError::NotTransact`]
/// for any other program instruction (initialize, config updates) so the caller can skip it
/// deliberately rather than treat it as a failure.
pub fn decode_transact_ix(data: &[u8]) -> Result<DecodedTransact, DecodeError> {
    let (disc, body) = data.split_first().ok_or(DecodeError::TooShort)?;
    let kind = match PrivacyCashInstruction::from_u8(*disc) {
        Some(PrivacyCashInstruction::Transact) => TransactKind::Sol,
        Some(PrivacyCashInstruction::TransactSpl) => TransactKind::Spl,
        _ => return Err(DecodeError::NotTransact),
    };
    parse_transact_body(kind, body)
}

fn arr32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap()
}

fn parse_transact_body(kind: TransactKind, data: &[u8]) -> Result<DecodedTransact, DecodeError> {
    if data.len() < FIXED_TRANSACT_ARGS_SIZE {
        return Err(DecodeError::TooShort);
    }

    let root = arr32(data, OFF_ROOT);
    let public_amount = arr32(data, OFF_PUBLIC_AMOUNT);
    let ext_data_hash = arr32(data, OFF_EXT_DATA_HASH);
    let nullifier0 = arr32(data, OFF_NULLIFIER0);
    let nullifier1 = arr32(data, OFF_NULLIFIER1);
    let commitment0 = arr32(data, OFF_COMMITMENT0);
    let commitment1 = arr32(data, OFF_COMMITMENT1);

    let ext_amount = i64::from_le_bytes(data[OFF_EXT_DATA..OFF_EXT_DATA + 8].try_into().unwrap());
    let fee = u64::from_le_bytes(data[OFF_EXT_DATA + 8..OFF_EXT_DATA + 16].try_into().unwrap());

    let mut offset = FIXED_TRANSACT_ARGS_SIZE;
    let encrypted_output1 = read_length_prefixed(data, &mut offset)?.to_vec();
    let encrypted_output2 = read_length_prefixed(data, &mut offset)?.to_vec();

    // Pinocchio appends exactly two nullifier bump bytes.
    if data.len() < offset + 2 {
        return Err(DecodeError::MissingNullifierBumps);
    }
    offset += 2;

    if offset != data.len() {
        return Err(DecodeError::TrailingBytes);
    }

    Ok(DecodedTransact {
        kind,
        root,
        public_amount,
        ext_data_hash,
        input_nullifiers: [nullifier0, nullifier1],
        output_commitments: [commitment0, commitment1],
        ext_amount,
        fee,
        encrypted_output1,
        encrypted_output2,
    })
}

fn read_length_prefixed<'a>(data: &'a [u8], offset: &mut usize) -> Result<&'a [u8], DecodeError> {
    let len_bytes = data
        .get(*offset..*offset + 4)
        .ok_or(DecodeError::InvalidLengthPrefix)?;
    let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
    let start = *offset + 4;
    let end = start.checked_add(len).ok_or(DecodeError::InvalidLengthPrefix)?;
    let slice = data.get(start..end).ok_or(DecodeError::InvalidLengthPrefix)?;
    *offset = end;
    Ok(slice)
}

/// Parse every `CommitmentEvent` out of a transaction's log messages, in log order.
///
/// The runtime renders `sol_log_data(&[magic, payload])` as
/// `Program data: <base64(magic)> <base64(payload)>`. We match the magic (whose base64 is a fixed
/// string), then decode the payload. A transaction with N `transact` instructions logs N events.
pub fn parse_commitment_events(logs: &[String]) -> Vec<CommitmentEvent> {
    let magic_b64 = base64::engine::general_purpose::STANDARD.encode(EVENT_MAGIC);
    let mut out = Vec::new();

    for line in logs {
        let Some(rest) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let mut parts = rest.split(' ');
        let (Some(first), Some(second)) = (parts.next(), parts.next()) else {
            continue;
        };
        if first != magic_b64 {
            continue;
        }
        let Ok(payload) = base64::engine::general_purpose::STANDARD.decode(second) else {
            continue;
        };
        if let Some(ev) = CommitmentEvent::decode(&payload) {
            out.push(ev);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid Transact payload with recognizable marker bytes.
    fn sample_ix(disc: u8, enc1: &[u8], enc2: &[u8]) -> Vec<u8> {
        let mut body = vec![0u8; FIXED_TRANSACT_ARGS_SIZE];
        body[OFF_NULLIFIER0] = 0xA1;
        body[OFF_COMMITMENT0] = 0xC0;
        body[OFF_COMMITMENT1] = 0xC1;
        body[OFF_EXT_DATA] = 5; // ext_amount low byte

        let mut d = vec![disc];
        d.extend_from_slice(&body);
        d.extend_from_slice(&(enc1.len() as u32).to_le_bytes());
        d.extend_from_slice(enc1);
        d.extend_from_slice(&(enc2.len() as u32).to_le_bytes());
        d.extend_from_slice(enc2);
        d.extend_from_slice(&[7, 9]); // two nullifier bumps
        d
    }

    #[test]
    fn decodes_sol_transact() {
        let ix = sample_ix(2, b"enc-one", b"enc-two");
        let decoded = decode_transact_ix(&ix).unwrap();
        assert_eq!(decoded.kind, TransactKind::Sol);
        assert_eq!(decoded.output_commitments[0][0], 0xC0);
        assert_eq!(decoded.output_commitments[1][0], 0xC1);
        assert_eq!(decoded.input_nullifiers[0][0], 0xA1);
        assert_eq!(decoded.ext_amount, 5);
        assert_eq!(decoded.encrypted_output1, b"enc-one");
        assert_eq!(decoded.encrypted_output2, b"enc-two");
    }

    #[test]
    fn spl_discriminator_maps_to_spl() {
        let ix = sample_ix(3, b"", b"");
        assert_eq!(decode_transact_ix(&ix).unwrap().kind, TransactKind::Spl);
    }

    #[test]
    fn non_transact_is_distinguishable() {
        assert_eq!(decode_transact_ix(&[0]).unwrap_err(), DecodeError::NotTransact);
        assert_eq!(decode_transact_ix(&[4, 1, 2]).unwrap_err(), DecodeError::NotTransact);
    }

    #[test]
    fn trailing_bytes_rejected() {
        let mut ix = sample_ix(2, b"a", b"b");
        ix.push(0xFF);
        assert_eq!(decode_transact_ix(&ix).unwrap_err(), DecodeError::TrailingBytes);
    }

    #[test]
    fn truncated_rejected() {
        let ix = sample_ix(2, b"a", b"b");
        assert!(decode_transact_ix(&ix[..ix.len() - 5]).is_err());
    }

    #[test]
    fn parses_event_from_logs() {
        let ev = CommitmentEvent::new(42, [3u8; 32]);
        let magic = base64::engine::general_purpose::STANDARD.encode(EVENT_MAGIC);
        let payload = base64::engine::general_purpose::STANDARD.encode(ev.encode());
        let logs = vec![
            "Program HoumtJ invoke [1]".to_string(),
            format!("Program data: {magic} {payload}"),
            "Program HoumtJ success".to_string(),
        ];
        assert_eq!(parse_commitment_events(&logs), vec![ev]);
    }

    #[test]
    fn ignores_foreign_program_data() {
        let logs = vec!["Program data: c29tZXRoaW5n ZWxzZQ==".to_string()];
        assert!(parse_commitment_events(&logs).is_empty());
    }
}
