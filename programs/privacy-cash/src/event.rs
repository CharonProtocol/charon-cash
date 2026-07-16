//! Event emission via the `sol_log_data` syscall.
//!
//! This is the on-chain half of the contract defined in [`pc_types::event`]; see that module
//! for the wire format and the rationale. The runtime renders each emission as
//! `Program data: <base64(magic)> <base64(payload)>`, which is the same mechanism Anchor's
//! `emit!` uses — so ordinary log-parsing indexers work unchanged.

use pc_types::event::{CommitmentEvent, EVENT_MAGIC};

/// Emit a [`CommitmentEvent`] for a `transact` / `transact_spl` that just appended two leaves.
///
/// `leaf_index` must be the tree's `next_index` sampled *before* the appends, and `root` the
/// root after both of them.
///
/// Costs one syscall (~100 CU plus a few per byte) against a transaction already spending
/// ~1M CU on the pairing check — immaterial next to what it buys, which is an authoritative
/// leaf index instead of one an indexer has to guess at.
pub fn emit_commitment_event(leaf_index: u32, root: [u8; 32]) {
    let payload = CommitmentEvent::new(leaf_index, root).encode();
    log_data(&[EVENT_MAGIC.as_slice(), payload.as_slice()]);
}

/// Thin wrapper over the `sol_log_data` syscall.
///
/// The syscall reads `fields.len()` consecutive `(ptr, len)` pairs starting at the given
/// address, which is exactly the memory layout of a `&[&[u8]]`. This mirrors what
/// `solana_program::log::sol_log_data` does; pinocchio exposes the raw syscall but no helper.
#[inline]
fn log_data(fields: &[&[u8]]) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_data(fields.as_ptr() as *const u8, fields.len() as u64);
    }

    // Off-chain (unit tests, host builds) the syscall does not exist. Referencing the argument
    // keeps the signature honest and silences an unused warning.
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(fields);
}
