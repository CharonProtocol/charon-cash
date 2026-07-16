//! Wire contract shared by the on-chain program and every off-chain service.
//!
//! Anything in here is depended on from *both* sides of the chain boundary, so that
//! constants can never drift apart silently. Before this crate existed the indexer
//! re-declared `PROOF_SIZE`, the instruction discriminators and the PDA seeds as its
//! own literals; they happened to be right, but nothing made them stay right.
//!
//! `no_std` and dependency-free on purpose — this compiles into the SBF binary.

#![no_std]

pub mod event;
pub mod ix;
pub mod seeds;
pub mod wire;

pub use event::{CommitmentEvent, EVENT_MAGIC, EVENT_PAYLOAD_LEN};
pub use ix::PrivacyCashInstruction;
