//! Note encryption.
//!
//! Each output commitment ships with an opaque encrypted blob (the program treats it as bytes and
//! only hashes it into `extDataHash`). This is what lets a client recover its notes later: it
//! scans every blob, decrypts the ones that are its own, and rebuilds its balance.
//!
//! # Why symmetric
//!
//! Upstream ships no cipher at all (`mockEncrypt = JSON.stringify`), so with a fresh program we
//! choose our own with no interop constraint. In the deposit/withdraw model (no shielded→shielded
//! transfers), **every output note belongs to the transacting user themselves** — a deposit's
//! change note and a withdrawal's change note are both self-owned; a withdrawal *recipient*
//! receives plain SOL, not a note. So notes are self-encrypted, and a symmetric key derived from
//! the user's own shielded secret is sufficient and simplest. (Peer-to-peer sends would need an
//! asymmetric scheme layered on top — deliberately out of scope.)
//!
//! # Wire format (`version || view_tag || nonce || ciphertext`)
//!
//! ```text
//! byte  0        version (NOTE_VERSION)
//! byte  1        view_tag — H("pc-note-tag" || key || nonce)[0]; a scanner rejects 255/256 of
//!                foreign notes with one hash instead of a full AEAD attempt
//! bytes 2..14    nonce (12 bytes, random per note)
//! bytes 14..     ChaCha20-Poly1305(key, nonce, plaintext)  [plaintext 72B + 16B tag]
//! ```
//!
//! The plaintext is `amount(8, LE) || blinding(32, BE) || mint(32)` = 72 bytes; the note's leaf
//! `index` is not encrypted because the [`pc_types::CommitmentEvent`] already carries it. Total
//! wire size is 102 bytes — comfortably under the ~120-byte budget, and it round-trips exactly
//! (required, since the bytes are hashed into `extDataHash`).

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use pc_core::field::{fr_from_be_bytes_mod_order, fr_to_be32};
use pc_core::keypair::Keypair;
use pc_core::Fr;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

pub const NOTE_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const PLAINTEXT_LEN: usize = 8 + 32 + 32; // amount + blinding + mint
const HEADER_LEN: usize = 1 + 1 + NONCE_LEN; // version + view_tag + nonce

/// The decrypted contents of a note. `index` is supplied separately (from the event), so it is
/// not part of this struct.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotePlaintext {
    pub amount: u64,
    pub blinding: Fr,
    pub mint: [u8; 32],
}

/// A per-user note cipher, derived from the shielded private key.
pub struct NoteCipher {
    key: [u8; 32],
}

impl NoteCipher {
    /// Derive the note key from a shielded keypair's private key.
    ///
    /// Domain-separated from every other use of the key so this cannot collide with the
    /// nullifier PRF or anything else keyed on the same secret.
    pub fn from_keypair(kp: &Keypair) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"pc-note-key-v1");
        hasher.update(kp.privkey_be());
        Self {
            key: hasher.finalize().into(),
        }
    }

    fn view_tag(&self, nonce: &[u8; NONCE_LEN]) -> u8 {
        let mut hasher = Sha256::new();
        hasher.update(b"pc-note-tag-v1");
        hasher.update(self.key);
        hasher.update(nonce);
        hasher.finalize()[0]
    }

    fn aead(&self) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(&self.key))
    }

    /// Encrypt a note. The nonce is sampled fresh per call.
    pub fn encrypt(&self, note: &NotePlaintext) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);

        let mut plaintext = [0u8; PLAINTEXT_LEN];
        plaintext[..8].copy_from_slice(&note.amount.to_le_bytes());
        plaintext[8..40].copy_from_slice(&fr_to_be32(&note.blinding));
        plaintext[40..72].copy_from_slice(&note.mint);

        let ciphertext = self
            .aead()
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
            .expect("chacha20poly1305 encryption is infallible for valid inputs");

        let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
        out.push(NOTE_VERSION);
        out.push(self.view_tag(&nonce));
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Attempt to decrypt a blob as one of *our* notes.
    ///
    /// Returns `None` cheaply when the view tag does not match (the common case while scanning
    /// other people's notes), and also `None` when the AEAD tag fails — the two are
    /// indistinguishable to a caller, which is the point.
    pub fn try_decrypt(&self, blob: &[u8]) -> Option<NotePlaintext> {
        if blob.len() < HEADER_LEN + 16 || blob[0] != NOTE_VERSION {
            return None;
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&blob[2..2 + NONCE_LEN]);

        // Cheap reject before the (relatively) expensive AEAD.
        if blob[1] != self.view_tag(&nonce) {
            return None;
        }

        let plaintext = self
            .aead()
            .decrypt(Nonce::from_slice(&nonce), &blob[HEADER_LEN..])
            .ok()?;
        if plaintext.len() != PLAINTEXT_LEN {
            return None;
        }

        let mut amount = [0u8; 8];
        amount.copy_from_slice(&plaintext[..8]);
        let blinding = fr_from_be_bytes_mod_order(&plaintext[8..40]);
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&plaintext[40..72]);

        Some(NotePlaintext {
            amount: u64::from_le_bytes(amount),
            blinding,
            mint,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pc_core::mint::SOL_MINT;

    fn note() -> NotePlaintext {
        NotePlaintext {
            amount: 12_345_678,
            blinding: Fr::from(987654321u64),
            mint: SOL_MINT,
        }
    }

    #[test]
    fn round_trips() {
        let cipher = NoteCipher::from_keypair(&Keypair::generate());
        let blob = cipher.encrypt(&note());
        assert_eq!(cipher.try_decrypt(&blob), Some(note()));
    }

    #[test]
    fn size_is_within_budget() {
        let cipher = NoteCipher::from_keypair(&Keypair::generate());
        // 1 + 1 + 12 + (72 + 16) = 102 bytes.
        assert_eq!(cipher.encrypt(&note()).len(), 102);
    }

    #[test]
    fn other_users_note_is_rejected() {
        let mine = NoteCipher::from_keypair(&Keypair::generate());
        let theirs = NoteCipher::from_keypair(&Keypair::generate());
        let blob = theirs.encrypt(&note());
        assert_eq!(mine.try_decrypt(&blob), None);
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let cipher = NoteCipher::from_keypair(&Keypair::generate());
        let mut blob = cipher.encrypt(&note());
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert_eq!(cipher.try_decrypt(&blob), None);
    }

    #[test]
    fn view_tag_filters_without_false_negatives() {
        // A note that IS ours must always pass its own view-tag gate (no accidental rejection).
        let cipher = NoteCipher::from_keypair(&Keypair::generate());
        for _ in 0..64 {
            let blob = cipher.encrypt(&note());
            assert!(cipher.try_decrypt(&blob).is_some());
        }
    }
}
