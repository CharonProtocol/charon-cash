use bytemuck::{Pod, Zeroable};
use pinocchio::error::ProgramError;

pub const PROOF_SIZE: usize = core::mem::size_of::<Proof>();
pub const EXT_DATA_MINIFIED_SIZE: usize = core::mem::size_of::<ExtDataMinified>();
pub const FIXED_TRANSACT_ARGS_SIZE: usize = PROOF_SIZE + EXT_DATA_MINIFIED_SIZE;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ExtDataMinified {
    pub ext_amount: i64,
    pub fee: u64,
}

pub struct TransactArgs<'a> {
    pub proof: &'a Proof,
    pub ext_data_minified: ExtDataMinified,
    pub encrypted_output1: &'a [u8],
    pub encrypted_output2: &'a [u8],
    pub nullifier_bump0: u8,
    pub nullifier_bump1: u8,
}

impl<'a> TransactArgs<'a> {
    pub fn try_from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < FIXED_TRANSACT_ARGS_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof = bytemuck::try_from_bytes::<Proof>(&data[..PROOF_SIZE])
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        
        let ext_data_minified = bytemuck::try_pod_read_unaligned::<ExtDataMinified>(
            &data[PROOF_SIZE..FIXED_TRANSACT_ARGS_SIZE],
        ).map_err(|_| ProgramError::InvalidInstructionData)?;

        let mut offset = FIXED_TRANSACT_ARGS_SIZE;
        let encrypted_output1 = read_length_prefixed_slice(data, &mut offset)?;
        let encrypted_output2 = read_length_prefixed_slice(data, &mut offset)?;

        if data.len() < offset + 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let nullifier_bump0 = data[offset];
        let nullifier_bump1 = data[offset + 1];
        offset += 2;
        if offset != data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            proof,
            ext_data_minified,
            encrypted_output1,
            encrypted_output2,
            nullifier_bump0,
            nullifier_bump1,
        })
    }
}

fn read_length_prefixed_slice<'a>(
    data: &'a [u8],
    offset: &mut usize,
) -> Result<&'a [u8], ProgramError> {
    let len_bytes = data
        .get(*offset..*offset + 4)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let len = u32::from_le_bytes(
        len_bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;

    *offset += 4;

    let slice = data
        .get(*offset..*offset + len)
        .ok_or(ProgramError::InvalidInstructionData)?;

    *offset += len;
    Ok(slice)
}

// Batch payout variant of Proof/TransactArgs for Transaction(26, 2, 3): the
// same JoinSplit shape but 3 output commitments (2 employees + change).
pub const PROOF_BATCH3_SIZE: usize = core::mem::size_of::<ProofBatch3>();
pub const FIXED_TRANSACT_BATCH3_ARGS_SIZE: usize =
    PROOF_BATCH3_SIZE + core::mem::size_of::<ExtDataMinified>();

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ProofBatch3 {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 3],
}

pub struct TransactArgsBatch3<'a> {
    pub proof: &'a ProofBatch3,
    pub ext_data_minified: ExtDataMinified,
    pub encrypted_outputs: [&'a [u8]; 3],
    pub nullifier_bump0: u8,
    pub nullifier_bump1: u8,
}

impl<'a> TransactArgsBatch3<'a> {
    pub fn try_from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < FIXED_TRANSACT_BATCH3_ARGS_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof = bytemuck::try_from_bytes::<ProofBatch3>(&data[..PROOF_BATCH3_SIZE])
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        let ext_data_minified = bytemuck::try_pod_read_unaligned::<ExtDataMinified>(
            &data[PROOF_BATCH3_SIZE..FIXED_TRANSACT_BATCH3_ARGS_SIZE],
        )
        .map_err(|_| ProgramError::InvalidInstructionData)?;

        let mut offset = FIXED_TRANSACT_BATCH3_ARGS_SIZE;
        let encrypted_outputs = [
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
        ];

        if data.len() < offset + 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let nullifier_bump0 = data[offset];
        let nullifier_bump1 = data[offset + 1];
        offset += 2;
        if offset != data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            proof,
            ext_data_minified,
            encrypted_outputs,
            nullifier_bump0,
            nullifier_bump1,
        })
    }
}

// Batch payout variant of Proof/TransactArgs for Transaction(26, 2, 5): the
// same JoinSplit shape but 5 output commitments (4 employees + change).
pub const PROOF_BATCH5_SIZE: usize = core::mem::size_of::<ProofBatch5>();
pub const FIXED_TRANSACT_BATCH5_ARGS_SIZE: usize =
    PROOF_BATCH5_SIZE + core::mem::size_of::<ExtDataMinified>();

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ProofBatch5 {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 5],
}

pub struct TransactArgsBatch5<'a> {
    pub proof: &'a ProofBatch5,
    pub ext_data_minified: ExtDataMinified,
    pub encrypted_outputs: [&'a [u8]; 5],
    pub nullifier_bump0: u8,
    pub nullifier_bump1: u8,
}

impl<'a> TransactArgsBatch5<'a> {
    pub fn try_from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < FIXED_TRANSACT_BATCH5_ARGS_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof = bytemuck::try_from_bytes::<ProofBatch5>(&data[..PROOF_BATCH5_SIZE])
            .map_err(|_| ProgramError::InvalidInstructionData)?;

        let ext_data_minified = bytemuck::try_pod_read_unaligned::<ExtDataMinified>(
            &data[PROOF_BATCH5_SIZE..FIXED_TRANSACT_BATCH5_ARGS_SIZE],
        )
        .map_err(|_| ProgramError::InvalidInstructionData)?;

        let mut offset = FIXED_TRANSACT_BATCH5_ARGS_SIZE;
        let encrypted_outputs = [
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
            read_length_prefixed_slice(data, &mut offset)?,
        ];

        if data.len() < offset + 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let nullifier_bump0 = data[offset];
        let nullifier_bump1 = data[offset + 1];
        offset += 2;
        if offset != data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            proof,
            ext_data_minified,
            encrypted_outputs,
            nullifier_bump0,
            nullifier_bump1,
        })
    }
}
