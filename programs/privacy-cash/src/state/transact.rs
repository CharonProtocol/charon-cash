use bytemuck::{Pod, Zeroable};
use pinocchio::error::ProgramError;

pub const PROOF_SIZE: usize = core::mem::size_of::<Proof>();
pub const EXT_DATA_MINIFIED_SIZE: usize = core::mem::size_of::<ExtDataMinified>();
pub const FIXED_TRANSACT_ARGS_SIZE: usize = PROOF_SIZE + EXT_DATA_MINIFIED_SIZE;

// The off-chain indexer decodes instruction bytes against pc_types::wire. If a field is ever
// added to Proof/ExtDataMinified here without updating the shared layout, this fails to compile
// rather than silently desyncing the indexer.
const _: () = assert!(PROOF_SIZE == pc_types::wire::PROOF_SIZE);
const _: () = assert!(EXT_DATA_MINIFIED_SIZE == pc_types::wire::EXT_DATA_MINIFIED_SIZE);

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
    /// Held by value, not by reference: instruction data has no alignment guarantee, and
    /// `ExtDataMinified` needs 8-byte alignment (`i64`/`u64`). A borrowed `try_from_bytes` here
    /// fails with an alignment error on any real transaction — see `try_pod_read_unaligned` below.
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

        // `Proof` is all byte arrays (alignment 1), so a borrowed read is safe at any offset.
        let proof = bytemuck::try_from_bytes::<Proof>(&data[..PROOF_SIZE])
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        // `ExtDataMinified` is alignment 8; read it unaligned into an owned value.
        let ext_data_minified = bytemuck::try_pod_read_unaligned::<ExtDataMinified>(
            &data[PROOF_SIZE..FIXED_TRANSACT_ARGS_SIZE],
        )
        .map_err(|_| ProgramError::InvalidInstructionData)?;

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
