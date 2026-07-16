//! The `CommitmentEvent` — the program's only log output, and the indexer's source of truth
//! for leaf indices.
//!
//! # Why this exists
//!
//! Commitments are absorbed into an append-only Merkle tree. The leaves themselves are **not**
//! recoverable from account state — only the 26 subtrees and the root history live on-chain. A
//! client needs a leaf's index to compute both its nullifier and its Merkle path, so if the
//! index is ever wrong, every proof built from it is invalid.
//!
//! Commitments and encrypted outputs already travel in the instruction data, so this event
//! deliberately carries only what instruction data *cannot* provide:
//!
//! * `leaf_index` — the authoritative pre-insert `next_index`. Without it an indexer must count
//!   leaves itself, and a single missed transaction shifts every later index by two, forever,
//!   with nothing to detect it.
//! * `root` — the root *after* both appends. Note this is not the root in the instruction data:
//!   that one is the (past) root the proof was verified against. This is the new one, and it
//!   lets an indexer compare its mirror against the chain on every single transaction, so a
//!   desync surfaces immediately instead of silently corrupting proofs.
//!
//! # Wire format
//!
//! Emitted via `sol_log_data` as two fields, which the runtime renders as
//! `Program data: <base64(field0)> <base64(field1)>`:
//!
//! * field 0: [`EVENT_MAGIC`] — constant, so it base64-encodes to the fixed string `UENFVg==`
//!   and an indexer can reject foreign `Program data:` lines with a substring match.
//! * field 1: the [`EVENT_PAYLOAD_LEN`]-byte payload below.
//!
//! ```text
//! byte  0      version (EVENT_VERSION)
//! bytes 1..5   leaf_index : u32 little-endian
//! bytes 5..37  root       : [u8; 32]
//! ```
//!
//! Each `transact` appends exactly two leaves, so the commitments occupy `leaf_index` and
//! `leaf_index + 1`, matching `output_commitments[0]` and `[1]` positionally.

/// Marks a `Program data:` line as ours. Base64-encodes to the fixed string `UENFVg==`.
pub const EVENT_MAGIC: &[u8; 4] = b"PCEV";

/// Bumped only on a breaking payload change, so an old indexer refuses new events loudly
/// rather than misparsing them.
pub const EVENT_VERSION: u8 = 1;

/// Size of the second `sol_log_data` field.
pub const EVENT_PAYLOAD_LEN: usize = 1 + 4 + 32;

/// Decoded form of a commitment event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitmentEvent {
    /// Leaf index of `output_commitments[0]`. `output_commitments[1]` is at `leaf_index + 1`.
    pub leaf_index: u32,
    /// Merkle root after both commitments were appended.
    pub root: [u8; 32],
}

impl CommitmentEvent {
    pub const fn new(leaf_index: u32, root: [u8; 32]) -> Self {
        Self { leaf_index, root }
    }

    /// Serialize to the payload emitted as field 1.
    pub fn encode(&self) -> [u8; EVENT_PAYLOAD_LEN] {
        let mut out = [0u8; EVENT_PAYLOAD_LEN];
        out[0] = EVENT_VERSION;
        out[1..5].copy_from_slice(&self.leaf_index.to_le_bytes());
        out[5..37].copy_from_slice(&self.root);
        out
    }

    /// Parse a payload previously produced by [`encode`](Self::encode).
    ///
    /// Returns `None` on a length or version mismatch rather than guessing — a wrong index is
    /// worse than no index.
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() != EVENT_PAYLOAD_LEN || data[0] != EVENT_VERSION {
            return None;
        }
        let mut leaf_index = [0u8; 4];
        leaf_index.copy_from_slice(&data[1..5]);
        let mut root = [0u8; 32];
        root.copy_from_slice(&data[5..37]);
        Some(Self {
            leaf_index: u32::from_le_bytes(leaf_index),
            root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let ev = CommitmentEvent::new(0xDEAD_BEEF, [7u8; 32]);
        assert_eq!(CommitmentEvent::decode(&ev.encode()), Some(ev));
    }

    #[test]
    fn encodes_index_little_endian() {
        let ev = CommitmentEvent::new(1, [0u8; 32]);
        let bytes = ev.encode();
        assert_eq!(bytes[0], EVENT_VERSION);
        assert_eq!(&bytes[1..5], &[1, 0, 0, 0]);
    }

    #[test]
    fn zero_index_survives_round_trip() {
        // The very first deposit lands at index 0. An indexer that treats 0 as "absent"
        // (the exact bug we are fixing) must not be able to hide behind the encoding.
        let ev = CommitmentEvent::new(0, [0u8; 32]);
        assert_eq!(CommitmentEvent::decode(&ev.encode()).unwrap().leaf_index, 0);
    }

    #[test]
    fn rejects_wrong_version() {
        let mut bytes = CommitmentEvent::new(1, [0u8; 32]).encode();
        bytes[0] = EVENT_VERSION + 1;
        assert_eq!(CommitmentEvent::decode(&bytes), None);
    }

    #[test]
    fn rejects_wrong_length() {
        assert_eq!(CommitmentEvent::decode(&[]), None);
        assert_eq!(CommitmentEvent::decode(&[1u8; EVENT_PAYLOAD_LEN - 1]), None);
        assert_eq!(CommitmentEvent::decode(&[1u8; EVENT_PAYLOAD_LEN + 1]), None);
    }
}
