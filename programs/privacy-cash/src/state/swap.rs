use pinocchio::error::ProgramError;

use super::transact::{Proof, PROOF_SIZE};

pub const SWAP_FIXED_PREFIX: usize = PROOF_SIZE * 2 + 16 + 4;

pub struct SwapArgs<'a> {
    pub proof_in: &'a Proof,
    pub proof_out: &'a Proof,
    pub ext_amount_in: i64,
    pub ext_amount_out: i64,
    pub nullifier_bump_in0: u8,
    pub nullifier_bump_in1: u8,
    pub nullifier_bump_out0: u8,
    pub nullifier_bump_out1: u8,
    pub encrypted_output_in1: &'a [u8],
    pub encrypted_output_in2: &'a [u8],
    pub encrypted_output_out1: &'a [u8],
    pub encrypted_output_out2: &'a [u8],
    pub jupiter_data: &'a [u8],
    /// Indices into the Swap instruction's unique account list, in Jupiter CPI order.
    pub jupiter_account_indices: &'a [u8],
}

impl<'a> SwapArgs<'a> {
    pub fn try_from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < SWAP_FIXED_PREFIX {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof_in = bytemuck::try_from_bytes::<Proof>(&data[..PROOF_SIZE])
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let proof_out = bytemuck::try_from_bytes::<Proof>(&data[PROOF_SIZE..PROOF_SIZE * 2])
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        let mut offset = PROOF_SIZE * 2;
        let ext_amount_in = i64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        offset += 8;
        let ext_amount_out = i64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        offset += 8;

        if data.len() < offset + 4 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let nullifier_bump_in0 = data[offset];
        let nullifier_bump_in1 = data[offset + 1];
        let nullifier_bump_out0 = data[offset + 2];
        let nullifier_bump_out1 = data[offset + 3];
        offset += 4;

        let encrypted_output_in1 = read_length_prefixed(data, &mut offset)?;
        let encrypted_output_in2 = read_length_prefixed(data, &mut offset)?;
        let encrypted_output_out1 = read_length_prefixed(data, &mut offset)?;
        let encrypted_output_out2 = read_length_prefixed(data, &mut offset)?;
        let jupiter_data = read_length_prefixed(data, &mut offset)?;
        let jupiter_account_indices = read_length_prefixed(data, &mut offset)?;

        if offset != data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            proof_in,
            proof_out,
            ext_amount_in,
            ext_amount_out,
            nullifier_bump_in0,
            nullifier_bump_in1,
            nullifier_bump_out0,
            nullifier_bump_out1,
            encrypted_output_in1,
            encrypted_output_in2,
            encrypted_output_out1,
            encrypted_output_out2,
            jupiter_data,
            jupiter_account_indices,
        })
    }
}

fn read_length_prefixed<'a>(data: &'a [u8], offset: &mut usize) -> Result<&'a [u8], ProgramError> {
    if data.len() < *offset + 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let len = u32::from_le_bytes(
        data[*offset..*offset + 4]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;
    *offset += 4;
    let end = offset
        .checked_add(len)
        .ok_or(ProgramError::InvalidInstructionData)?;
    let slice = data
        .get(*offset..end)
        .ok_or(ProgramError::InvalidInstructionData)?;
    *offset = end;
    Ok(slice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Proof;
    use bytemuck::Zeroable;

    #[test]
    fn parses_minimal_swap_args() {
        let proof = Proof::zeroed();
        let mut data = Vec::new();
        data.extend_from_slice(bytemuck::bytes_of(&proof));
        data.extend_from_slice(bytemuck::bytes_of(&proof));
        data.extend_from_slice(&(-1_000i64).to_le_bytes());
        data.extend_from_slice(&500i64.to_le_bytes());
        data.extend_from_slice(&[1, 2, 3, 4]);
        for _ in 0..6 {
            data.extend_from_slice(&0u32.to_le_bytes());
        }
        let args = SwapArgs::try_from_bytes(&data).unwrap();
        assert_eq!(args.ext_amount_in, -1_000);
        assert_eq!(args.ext_amount_out, 500);
        assert_eq!(args.nullifier_bump_in0, 1);
        assert_eq!(args.nullifier_bump_out1, 4);
    }
}
