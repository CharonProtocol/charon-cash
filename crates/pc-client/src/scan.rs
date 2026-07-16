//! Local wallet scan.
//!
//! The indexer serves *every* encrypted output and *every* nullifier without knowing whose is
//! whose (see the API's privacy note). The client does the matching here, on its own device:
//! trial-decrypt each blob, keep the ones that decrypt, and mark a note spent if its nullifier is
//! in the set the indexer returned.

use pc_core::mint::mint_address_field;
use pc_core::{Keypair, Utxo};
use pc_note::NoteCipher;
use std::collections::HashSet;

/// One leaf as delivered by the indexer's `/tree/{key}/leaves` feed.
pub struct Leaf {
    pub leaf_index: u32,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

/// A note the wallet owns.
pub struct OwnedNote {
    pub utxo: Utxo,
    pub spent: bool,
}

/// Recover the wallet's notes from the scan feed.
///
/// Zero-value notes are skipped — they carry no balance and exist only to fill the fixed 2-output
/// shape. A decrypted note whose recomputed commitment does not match the on-chain one is also
/// skipped (it isn't really ours, or the feed is corrupt).
pub fn scan(user: &Keypair, leaves: &[Leaf], spent_nullifiers: &HashSet<[u8; 32]>) -> Vec<OwnedNote> {
    let cipher = NoteCipher::from_keypair(user);
    let mut out = Vec::new();

    for leaf in leaves {
        let Some(pt) = cipher.try_decrypt(&leaf.encrypted_output) else {
            continue;
        };
        if pt.amount == 0 {
            continue;
        }

        let utxo = Utxo::from_parts(pt.amount, pt.blinding, *user, leaf.leaf_index, pt.mint);

        // Sanity: the note must reproduce the on-chain commitment. Guards against a view-tag
        // collision decrypting to plausible-but-wrong bytes.
        if utxo.commitment_be32() != leaf.commitment {
            continue;
        }
        // And its mint field must be well-formed (defensive; from_parts trusts the plaintext).
        let _ = mint_address_field(&utxo.mint);

        let spent = spent_nullifiers.contains(&utxo.nullifier_be32());
        out.push(OwnedNote { utxo, spent });
    }

    out
}

/// Total unspent balance across recovered notes.
pub fn balance(notes: &[OwnedNote]) -> u64 {
    notes
        .iter()
        .filter(|n| !n.spent)
        .map(|n| n.utxo.amount)
        .sum()
}
