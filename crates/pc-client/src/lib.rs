//! Client SDK for privacy-cash.
//!
//! Ties the pieces together: [`pc_core`] for note crypto and the Merkle mirror, [`pc_prover`] for
//! the proof, [`pc_note`] for encryption, and this crate for instruction assembly and scanning.
//!
//! * [`build_sol_deposit`] / [`build_sol_withdraw`] — construct a ready-to-submit instruction.
//! * [`scan`] — recover the wallet's notes from the indexer's feed.
//! * [`program`] — program id and PDA derivations.

pub mod builder;
pub mod ix;
pub mod program;
pub mod scan;

pub use builder::{build_sol_deposit, build_sol_withdraw, BuiltTransact};
pub use scan::{balance, scan, Leaf, OwnedNote};
