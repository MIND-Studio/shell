//! XChaCha20-Poly1305 AEAD seal/open. ONLY this cipher (PRD §5.2): the 192-bit
//! nonce makes random nonces safe indefinitely across multi-device pod writes.
//! No AES-CBC, no unauthenticated modes.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;

use crate::error::CoreError;
use crate::kdf::KEY_LEN;

/// XChaCha20-Poly1305 nonce length (192-bit).
pub const NONCE_LEN: usize = 24;

/// Generate a fresh random 24-byte nonce from the OS CSPRNG.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    crate::rng::os_rng().fill_bytes(&mut n);
    n
}

/// Generate a fresh random 256-bit key from the OS CSPRNG.
pub fn random_key() -> [u8; KEY_LEN] {
    let mut k = [0u8; KEY_LEN];
    crate::rng::os_rng().fill_bytes(&mut k);
    k
}

/// AEAD-seal `plaintext` under `key` + `nonce`, binding `aad`. Tag is appended
/// to the returned ciphertext (RustCrypto convention).
pub fn seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CoreError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CoreError::Aead("seal failed"))
}

/// AEAD-open `ciphertext` (tag appended) under `key` + `nonce`, verifying `aad`
/// and the tag. Returns a generic error on any failure (wrong key, tamper, AAD
/// mismatch) — do not distinguish causes to the caller.
pub fn open(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, CoreError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| CoreError::Aead("decryption failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let key = random_key();
        let nonce = random_nonce();
        let ct = seal(&key, &nonce, b"aad", b"secret payload").unwrap();
        let pt = open(&key, &nonce, b"aad", &ct).unwrap();
        assert_eq!(pt, b"secret payload");
    }

    #[test]
    fn wrong_key_fails() {
        let nonce = random_nonce();
        let ct = seal(&random_key(), &nonce, b"aad", b"x").unwrap();
        assert!(open(&random_key(), &nonce, b"aad", &ct).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = random_key();
        let nonce = random_nonce();
        let mut ct = seal(&key, &nonce, b"aad", b"hello").unwrap();
        ct[0] ^= 0xff;
        assert!(open(&key, &nonce, b"aad", &ct).is_err());
    }

    #[test]
    fn aad_mismatch_fails() {
        let key = random_key();
        let nonce = random_nonce();
        let ct = seal(&key, &nonce, b"item-1:1", b"hello").unwrap();
        assert!(open(&key, &nonce, b"item-1:2", &ct).is_err());
        assert!(open(&key, &nonce, b"item-2:1", &ct).is_err());
    }
}
