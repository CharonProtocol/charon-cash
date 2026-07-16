//! Client-side cryptography for privacy-cash.
//!
//! A pure-Rust port of the upstream TypeScript reference (`anchor/tests/lib/*.ts`). Everything a
//! client needs to construct a transaction *except* the proof itself (see `pc-prover`) and note
//! encryption (see `pc-note`):
//!
//! * [`Keypair`] — shielded key, `pubkey = Poseidon(privkey)`.
//! * [`Utxo`] — a note; commitment and nullifier derivation.
//! * [`ExtData`] — the SHA-256 external-data hash bound into the proof.
//! * [`MerkleTree`] — the client mirror that reproduces the on-chain root and serves paths.
//! * [`mint`] — the (trap-laden) mint→field mapping.
//!
//! The correctness bar is byte-exact agreement with the chain; the tests check the derived values
//! against the upstream groth16 fixture's public inputs.

pub mod ext_data;
pub mod field;
pub mod hash;
pub mod keypair;
pub mod merkle;
pub mod mint;
pub mod utxo;

pub use ext_data::ExtData;
pub use keypair::Keypair;
pub use merkle::MerkleTree;
pub use utxo::Utxo;

// Re-export the field type so downstream crates share one `Fr`.
pub use ark_bn254::Fr;
