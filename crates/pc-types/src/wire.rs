//! Byte-level layout of the `Transact` / `TransactSpl` instruction data.
//!
//! The indexer decodes live instruction bytes against these offsets, and the program serializes
//! the same struct. Both reference this module, and the program asserts at compile time that its
//! `size_of::<Proof>()` equals [`PROOF_SIZE`] — so a field added to `Proof` without updating the
//! decoder is a build error, not a silent production desync.

/// `size_of::<Proof>()`. Layout:
/// `proof_a(64) | proof_b(128) | proof_c(64) | root(32) | public_amount(32) | ext_data_hash(32) |
///  input_nullifiers(2×32) | output_commitments(2×32)`.
pub const PROOF_SIZE: usize = 64 + 128 + 64 + 32 + 32 + 32 + 64 + 64;

/// `size_of::<ExtDataMinified>()` = `ext_amount: i64 | fee: u64`.
pub const EXT_DATA_MINIFIED_SIZE: usize = 8 + 8;

// Offsets of the fields the decoder pulls out of a `Proof`.
pub const OFF_ROOT: usize = 64 + 128 + 64;
pub const OFF_PUBLIC_AMOUNT: usize = OFF_ROOT + 32;
pub const OFF_EXT_DATA_HASH: usize = OFF_PUBLIC_AMOUNT + 32;
pub const OFF_NULLIFIER0: usize = OFF_EXT_DATA_HASH + 32;
pub const OFF_NULLIFIER1: usize = OFF_NULLIFIER0 + 32;
pub const OFF_COMMITMENT0: usize = OFF_NULLIFIER1 + 32;
pub const OFF_COMMITMENT1: usize = OFF_COMMITMENT0 + 32;

/// Offset of `ExtDataMinified` (immediately after `Proof`).
pub const OFF_EXT_DATA: usize = PROOF_SIZE;

const _: () = assert!(OFF_COMMITMENT1 + 32 == PROOF_SIZE);
