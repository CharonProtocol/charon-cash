// 1-byte disc | proof | ExtDataMinified | enc1 | enc2 | bump0 | bump1

pub const PROOF_SIZE: usize = 352;
pub const EXT_DATA_MINIFIED_SIZE: usize = 16;
pub const FIXED_TRANSACT_ARGS_SIZE: usize = PROOF_SIZE + EXT_DATA_MINIFIED_SIZE;

pub const TRANSACT: u8 = 2;
pub const TRANSACT_SPL: u8 = 3;

use crate::types::{DecodedTransact, TransactKind};

pub fn decode_transact_ix(data: &[u8]) -> Result<DecodedTransact, String> {
    let (kind, body) = split_discriminator(data)?;
    parse_transact_body(kind, body)
}

fn split_discriminator(data: &[u8]) -> Result<(TransactKind, &[u8]), String> {
    let (disc, body) = data.split_first().ok_or("instruction data too short")?;
    match *disc {
        TRANSACT => Ok((TransactKind::Sol, body)),
        TRANSACT_SPL => Ok((TransactKind::Spl, body)),
        _ => Err("unknown instruction discriminator".into()),
    }
}

fn parse_transact_body(kind: TransactKind, data: &[u8]) -> Result<DecodedTransact, String> {
    if data.len() < FIXED_TRANSACT_ARGS_SIZE {
        return Err("instruction data too short".into());
    }

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

    let ext_amount = i64::from_le_bytes(
        data.get(offset..offset + 8).ok_or("instruction data too short")?.try_into().unwrap(),
    );
    offset += 8;
    let fee = u64::from_le_bytes(
        data.get(offset..offset + 8).ok_or("instruction data too short")?.try_into().unwrap(),
    );
    offset += 8;

    let encrypted_output1 = read_length_prefixed(data, &mut offset)?.to_vec();
    let encrypted_output2 = read_length_prefixed(data, &mut offset)?.to_vec();

    if data.len() < offset + 2 {
        return Err("missing nullifier bumps".into());
    }
    offset += 2;

    if offset != data.len() {
        return Err("trailing bytes after parsed payload".into());
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

fn read_bytes<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], String> {
    let end = offset.checked_add(len).ok_or("instruction data too short")?;
    let slice = data.get(*offset..end).ok_or("instruction data too short")?;
    *offset = end;
    Ok(slice)
}

fn read_array_32(data: &[u8], offset: &mut usize) -> Result<[u8; 32], String> {
    Ok(read_bytes(data, offset, 32)?.try_into().unwrap())
}

fn read_length_prefixed<'a>(data: &'a [u8], offset: &mut usize) -> Result<&'a [u8], String> {
    let len_bytes = data.get(*offset..*offset + 4).ok_or("invalid length prefix")?;
    let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
    *offset += 4;
    read_bytes(data, offset, len).map_err(|_| "invalid length prefix".to_string())
}
