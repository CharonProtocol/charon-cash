// 1-byte disc | proof | ExtDataMinified | enc1 | enc2 | bump0 | bump1

use sqlx::Decode;
use thiserror::Error;

use super::types::{DecodedTransact, TransactKind};

/// On-chain `Proof` pod size.
pub const PROOF_SIZE: usize = 352;
pub const EXT_DATA_MINIFIED_SIZE: usize = 16;
pub const FIXED_TRANSACT_ARGS_SIZE: usize = PROOF_SIZE + EXT_DATA_MINIFIED_SIZE;

/// Pinocchio instruction discriminators (see `PrivacyCashInstructions`).
pub const TRANSACT: u8 = 2;
pub const TRANSACT_SPL: u8 = 3;

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("instruction data too short")]
    TooShort,
    #[error("unknown instruction discriminator")]
    UnknownDiscriminator,
    #[error("invalid length-prefixed field")]
    InvalidLengthPrefix,
    #[error("trailing bytes after parsed payload")]
    TrailingBytes,
    #[error("missing nullifier bumps")]
    MissingNullifierBumps,
    #[error("encrypted output is invalid")]
    InvalidOutput,
}

/// Decode a Pinocchio `Transact` / `TransactSpl` instruction payload.
pub fn decode_transact_ix(data: &[u8]) -> Result<DecodedTransact, DecodeError> {
    let (kind, body) = split_discriminator(data)?;
    parse_transact_body(kind, body)
}

fn split_discriminator(data: &[u8]) -> Result<(TransactKind, &[u8]), DecodeError> {
    let (disc, body) = data.split_first().ok_or(DecodeError::TooShort)?;
    match *disc {
        TRANSACT => Ok((TransactKind::Sol, body)),
        TRANSACT_SPL => Ok((TransactKind::Spl, body)),
        _ => Err(DecodeError::UnknownDiscriminator),
    }
}

fn parse_transact_body(kind: TransactKind, data: &[u8]) -> Result<DecodedTransact, DecodeError> {
    if data.len() < FIXED_TRANSACT_ARGS_SIZE {
        return Err(DecodeError::TooShort);
    }

    // proof_a(64) | proof_b(128) | proof_c(64) | root | public_amount |
    // ext_data_hash | nullifier0 | nullifier1 | commitment0 | commitment1
    let mut offset = 0usize;
    let _proof_a = read_bytes(data, &mut offset, 32)?;
    let _proof_b = read_bytes(data, &mut offset, 64)?;
    let _proof_c = read_bytes(data, &mut offset, 32)?;
    let root = read_array_32(data, &mut offset)?;
    let public_amount = read_array_32(data, &mut offset)?;
    let ext_data_hash = read_array_32(data, &mut offset)?;
    let nullifier0 = read_array_32(data, &mut offset)?;
    let nullifier1 = read_array_32(data, &mut offset)?;
    let commitment0 = read_array_32(data, &mut offset)?;
    let commitment1 = read_array_32(data, &mut offset)?;
    debug_assert_eq!(offset, PROOF_SIZE);

    let ext_amount = i64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or(DecodeError::TooShort)?
            .try_into()
            .unwrap(),
    );
    offset += 8;
    let fee = u64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or(DecodeError::TooShort)?
            .try_into()
            .unwrap(),
    );
    offset += 8;

    let encrypted_output1 = read_length_prefixed(data, &mut offset)?;

    let encrypted_output2 = read_length_prefixed(data, &mut offset)?;

    // Pinocchio requires exactly two nullifier bumps at the end.
    if data.len() < offset + 2 {
        return Err(DecodeError::MissingNullifierBumps);
    }
    let _nullifier_bump0 = data[offset];
    let _nullifier_bump1 = data[offset + 1];
    offset += 2;

    if offset != data.len() {
        return Err(DecodeError::TrailingBytes);
    }

    Ok(DecodedTransact {
        kind,
        output_commitments: [commitment0, commitment1],
        encrypted_note1: encrypted_output1.to_vec(),
        encrypted_note2: encrypted_output2.to_vec(),
    })
}

fn read_bytes<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], DecodeError> {
    let end = offset.checked_add(len).ok_or(DecodeError::TooShort)?;
    let slice = data.get(*offset..end).ok_or(DecodeError::TooShort)?;
    *offset = end;
    Ok(slice)
}

fn read_array_32(data: &[u8], offset: &mut usize) -> Result<[u8; 32], DecodeError> {
    Ok(read_bytes(data, offset, 32)?.try_into().unwrap())
}

fn read_length_prefixed<'a>(data: &'a [u8], offset: &mut usize) -> Result<&'a [u8], DecodeError> {
    let len_bytes = data
        .get(*offset..*offset + 4)
        .ok_or(DecodeError::InvalidLengthPrefix)?;
    let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
    *offset += 4;
    read_bytes(data, offset, len).map_err(|_| DecodeError::InvalidLengthPrefix)
}
