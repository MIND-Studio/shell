//! Ed25519 master-identity primitives for the DID identity layer (PRD-DID §5.9).
//!
//! The wallet's master identity is an Ed25519 keypair derived from a 32-byte
//! seed. Its public key is published as a `did:key` (multicodec `ed25519-pub`
//! varint prefix + base58btc multibase, `z` prefix). This module:
//!   * loads a signing key from a seed into a session behind an opaque `u32`,
//!   * exposes the public `did:key` for that session,
//!   * produces detached EdDSA signatures over a caller-supplied payload,
//!   * verifies a binding signature against a `did:key` with ZERO server support
//!     (the `did:key` *is* the public key — decode it and verify locally).
//!
//! ZERO-KNOWLEDGE INVARIANT (CONTRACT.md): the seed and the private key NEVER
//! cross the FFI. The seed enters once (unlock-time) to mint a session; from then
//! on only the handle, the public `did:key`, and signatures cross the boundary.
//! The seed copy taken at mint time is zeroized immediately; the `SigningKey` is
//! held behind the session store and zeroized on drop / `identity_lock`.
//!
//! This is the only new crypto in Phase C (AGENTS.md rule #4 — no bespoke crypto
//! in JS). It reuses the RustCrypto family already vendored by the core
//! (`ed25519-dalek`), plus `bs58` for the `did:key` multibase.

use std::cell::RefCell;
use std::collections::HashMap;

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroize;

use crate::aead::{self, NONCE_LEN};
use crate::error::CoreError;
use crate::kdf::{self, KdfParams, KEY_LEN};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Ed25519 seed / secret-scalar length.
pub const SEED_LEN: usize = 32;
/// Ed25519 signature length (R || s).
pub const SIG_LEN: usize = 64;
/// Ed25519 public key length.
pub const PUBKEY_LEN: usize = 32;

/// Multicodec code for an ed25519 public key (`0xed`), unsigned-varint encoded:
/// `0xed 0x01`. Every ed25519 `did:key` therefore renders as `did:key:z6Mk…`.
const MULTICODEC_ED25519_PUB: [u8; 2] = [0xed, 0x01];

fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, CoreError> {
    B64.decode(s.as_bytes())
        .map_err(|e| CoreError::Encoding(format!("base64: {e}")))
}

// ---- store-free core (pure; unit-testable natively) -------------------------

/// Build an Ed25519 signing key from a 32-byte seed. Infallible: every 32-byte
/// string is a valid ed25519 seed.
pub fn signing_key_from_seed(seed: &[u8; SEED_LEN]) -> SigningKey {
    SigningKey::from_bytes(seed)
}

/// Encode a verifying (public) key as a `did:key` string.
///
/// `did:key:z` + base58btc( multicodec-ed25519-pub-prefix || 32-byte pubkey ).
pub fn did_key_from_verifying(vk: &VerifyingKey) -> String {
    let mut buf = Vec::with_capacity(MULTICODEC_ED25519_PUB.len() + PUBKEY_LEN);
    buf.extend_from_slice(&MULTICODEC_ED25519_PUB);
    buf.extend_from_slice(vk.as_bytes());
    let mb = bs58::encode(&buf).into_string();
    format!("did:key:z{mb}")
}

/// Decode an ed25519 `did:key` back to its verifying key. Rejects any other DID
/// method, multibase, or multicodec — and any non-canonical / off-curve point.
pub fn verifying_from_did_key(did: &str) -> Result<VerifyingKey, CoreError> {
    let mb = did
        .strip_prefix("did:key:")
        .ok_or_else(|| CoreError::Invalid("not a did:key".into()))?;
    // `z` = base58btc multibase prefix.
    let b58 = mb
        .strip_prefix('z')
        .ok_or_else(|| CoreError::Invalid("did:key not base58btc multibase".into()))?;
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|_| CoreError::Invalid("did:key bad base58".into()))?;

    if bytes.len() != MULTICODEC_ED25519_PUB.len() + PUBKEY_LEN {
        return Err(CoreError::Invalid("did:key wrong length".into()));
    }
    if bytes[..MULTICODEC_ED25519_PUB.len()] != MULTICODEC_ED25519_PUB {
        return Err(CoreError::Invalid("did:key not ed25519-pub".into()));
    }

    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes[MULTICODEC_ED25519_PUB.len()..]);
    VerifyingKey::from_bytes(&pk).map_err(|_| CoreError::Invalid("did:key invalid point".into()))
}

/// Detached EdDSA signature over `payload`, base64-encoded. The private key is
/// borrowed and never returned.
pub fn sign_detached_with(sk: &SigningKey, payload: &[u8]) -> String {
    let sig = sk.sign(payload);
    b64_encode(&sig.to_bytes())
}

/// Verify a detached EdDSA signature (`signature_b64`) over `payload` against the
/// public key encoded in `did`.
///
/// Returns `Ok(false)` on a signature/key mismatch; `Err` only on malformed
/// inputs (bad DID, bad base64, wrong signature length). Uses `verify_strict` to
/// reject malleable / small-order signatures. ZERO server support required.
pub fn verify_binding(did: &str, payload: &[u8], signature_b64: &str) -> Result<bool, CoreError> {
    let vk = verifying_from_did_key(did)?;
    let sig_bytes = b64_decode(signature_b64)?;
    if sig_bytes.len() != SIG_LEN {
        return Err(CoreError::Invalid("signature wrong length".into()));
    }
    let mut sig_arr = [0u8; SIG_LEN];
    sig_arr.copy_from_slice(&sig_bytes);
    let sig = Signature::from_bytes(&sig_arr);
    Ok(vk.verify_strict(payload, &sig).is_ok())
}

// ---- session store (WASM path + native cargo tests) -------------------------
//
// Mirrors `envelope`'s `thread_local!` store: the unlocked `SigningKey` lives in
// linear memory behind an opaque `u32`; only the handle, the public did:key, and
// signatures cross the FFI. The native (Tauri) path keeps its OWN process-global,
// mlock'd store in `native.rs` (analogous to `HardenedSession`). `SigningKey`
// carries `ZeroizeOnDrop` via ed25519-dalek's `zeroize` feature, so removing it
// from the map zeroizes the secret.

thread_local! {
    static IDENTITIES: RefCell<HashMap<u32, SigningKey>> = RefCell::new(HashMap::new());
    static NEXT_HANDLE: RefCell<u32> = const { RefCell::new(1) };
}

fn alloc_handle() -> u32 {
    NEXT_HANDLE.with(|n| {
        let mut n = n.borrow_mut();
        let h = *n;
        *n = n.wrapping_add(1).max(1);
        h
    })
}

/// Mint a session from a 32-byte seed; returns the opaque handle. The caller's
/// seed is borrowed and not retained — only the derived `SigningKey` is stored.
pub fn identity_from_seed(seed: &[u8; SEED_LEN]) -> u32 {
    let sk = signing_key_from_seed(seed);
    let handle = alloc_handle();
    IDENTITIES.with(|m| {
        m.borrow_mut().insert(handle, sk);
    });
    handle
}

/// FFI entry: decode a base64 32-byte seed, mint a session, and zeroize every
/// decoded copy of the seed before returning. The seed never lingers in JS-owned
/// memory beyond the single call that produces the session handle.
pub fn identity_from_seed_b64(seed_b64: &str) -> Result<u32, CoreError> {
    let mut decoded = b64_decode(seed_b64)?;
    if decoded.len() != SEED_LEN {
        decoded.zeroize();
        return Err(CoreError::Invalid("seed must be 32 bytes".into()));
    }
    let mut seed = [0u8; SEED_LEN];
    seed.copy_from_slice(&decoded);
    decoded.zeroize();
    let handle = identity_from_seed(&seed);
    seed.zeroize();
    Ok(handle)
}

/// The master `did:key` for an unlocked session (public material only).
pub fn master_did(handle: u32) -> Result<String, CoreError> {
    IDENTITIES.with(|m| {
        let map = m.borrow();
        let sk = map
            .get(&handle)
            .ok_or(CoreError::Session("unknown or locked identity handle"))?;
        Ok(did_key_from_verifying(&sk.verifying_key()))
    })
}

/// Detached EdDSA signature (base64) over `payload`, by the session's master key.
pub fn sign_detached(handle: u32, payload: &[u8]) -> Result<String, CoreError> {
    IDENTITIES.with(|m| {
        let map = m.borrow();
        let sk = map
            .get(&handle)
            .ok_or(CoreError::Session("unknown or locked identity handle"))?;
        Ok(sign_detached_with(sk, payload))
    })
}

/// Zeroize + drop the identity session. Idempotent.
pub fn identity_lock(handle: u32) {
    IDENTITIES.with(|m| {
        // Removing drops the `SigningKey`, which zeroizes its secret on drop.
        m.borrow_mut().remove(&handle);
    });
}

// ---- encrypted-at-rest keystore (envelope-wrapped seed) ---------------------
//
// C1 (PRD-DID §5.4): the master seed must not live in long-lived storage in
// cleartext. We wrap it with the SAME audited envelope as the Vault — Argon2id
// (`kdf`) → XChaCha20-Poly1305 (`aead`) — under a master password, so the wallet
// reuses ONE reviewed crypto stack (no Stronghold, no second keystore format —
// §5.4). The seed is generated inside Rust, wrapped, and zeroized; only the
// public did:key and the ciphertext keystore (salt/kdf/wrapped-seed) cross the
// FFI. Unlocking re-derives the wrap key from the password and unwraps in-core.

/// AAD binding the wrapped seed to its purpose (domain-separated from vault keys).
const SEED_AAD: &[u8] = b"mind-shell/identity/v1/master-seed";

/// The encrypted-at-rest master identity. Every field is NON-secret: the public
/// `did:key`, the KDF params + salt, and the seed wrapped under the master
/// password. The wallet persists this (localStorage primary + optional encrypted
/// pod backup); the seed itself is never part of it.
#[derive(Clone, Debug)]
pub struct IdentityKeystore {
    pub did: String,
    pub kdf: KdfParams,
    pub salt_b64: String,
    pub wrapped_seed_b64: String,
}

/// 128-bit random salt (mirrors envelope's private helper).
fn random_salt() -> [u8; 16] {
    use rand::RngCore;
    let mut s = [0u8; 16];
    crate::rng::os_rng().fill_bytes(&mut s);
    s
}

/// A fresh random 32-byte master seed from the OS CSPRNG.
fn random_seed() -> [u8; SEED_LEN] {
    use rand::RngCore;
    let mut s = [0u8; SEED_LEN];
    crate::rng::os_rng().fill_bytes(&mut s);
    s
}

/// Wrap a 32-byte seed under the master-password-derived wrap key. Output bytes
/// = nonce(24) || sealed (ciphertext || tag).
fn wrap_seed(wrap_key: &[u8; KEY_LEN], seed: &[u8; SEED_LEN]) -> Result<Vec<u8>, CoreError> {
    let nonce = aead::random_nonce();
    let sealed = aead::seal(wrap_key, &nonce, SEED_AAD, seed)?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Unwrap a seed previously produced by `wrap_seed`. Generic error on a wrong
/// password (AEAD tag failure). The decrypted buffer is zeroized on every path.
fn unwrap_seed(wrap_key: &[u8; KEY_LEN], wrapped: &[u8]) -> Result<[u8; SEED_LEN], CoreError> {
    if wrapped.len() < NONCE_LEN {
        return Err(CoreError::Encoding("wrapped seed too short".into()));
    }
    let (nonce, sealed) = wrapped.split_at(NONCE_LEN);
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce);
    let mut plain = aead::open(wrap_key, &nonce_arr, SEED_AAD, sealed)?;
    if plain.len() != SEED_LEN {
        plain.zeroize();
        return Err(CoreError::Aead("unwrapped seed wrong length"));
    }
    let mut seed = [0u8; SEED_LEN];
    seed.copy_from_slice(&plain);
    plain.zeroize();
    Ok(seed)
}

/// Store-free create: generate a fresh master seed, wrap it under a key derived
/// from `master_password`, and return the persistable keystore + the live
/// `SigningKey`. The seed is zeroized before returning. Used by the store
/// wrapper (`identity_create`) and the native path; unit-testable natively.
pub fn create_keystore(
    master_password: &str,
    params: KdfParams,
) -> Result<(IdentityKeystore, SigningKey), CoreError> {
    let params = params.clamped();
    let salt = random_salt();
    let stretched = kdf::derive_stretched_key(master_password.as_bytes(), &salt, params)?;
    let wrap_key = kdf::expose_wrap_key(&stretched);

    let mut seed = random_seed();
    let wrapped = wrap_seed(&wrap_key, &seed)?;
    let sk = signing_key_from_seed(&seed);
    let did = did_key_from_verifying(&sk.verifying_key());
    seed.zeroize();

    Ok((
        IdentityKeystore {
            did,
            kdf: params,
            salt_b64: b64_encode(&salt),
            wrapped_seed_b64: b64_encode(&wrapped),
        },
        sk,
    ))
}

/// Store-free unlock: derive the wrap key from `master_password` + the stored
/// salt/params, unwrap the seed, and rebuild the `SigningKey`. The seed is
/// zeroized before returning. Generic error on a wrong password.
pub fn unlock_keystore(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_seed_b64: &str,
) -> Result<SigningKey, CoreError> {
    let salt = b64_decode(salt_b64)?;
    let stretched = kdf::derive_stretched_key(master_password.as_bytes(), &salt, params)?;
    let wrap_key = kdf::expose_wrap_key(&stretched);

    let wrapped = b64_decode(wrapped_seed_b64)?;
    let mut seed = unwrap_seed(&wrap_key, &wrapped)?;
    let sk = signing_key_from_seed(&seed);
    seed.zeroize();
    Ok(sk)
}

/// `identity_create`: generate a fresh master identity, wrap its seed under
/// `master_password`, mint a live session, and return the keystore + handle.
/// The wallet persists the keystore (ciphertext) and uses the handle to sign.
pub fn identity_create(
    master_password: &str,
    params: KdfParams,
) -> Result<(IdentityKeystore, u32), CoreError> {
    let (keystore, sk) = create_keystore(master_password, params)?;
    let handle = alloc_handle();
    IDENTITIES.with(|m| {
        m.borrow_mut().insert(handle, sk);
    });
    Ok((keystore, handle))
}

/// `identity_unlock`: unwrap the seed from a stored keystore, mint a live
/// session, and return the public did:key + handle.
pub fn identity_unlock(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_seed_b64: &str,
) -> Result<(String, u32), CoreError> {
    let sk = unlock_keystore(master_password, salt_b64, params, wrapped_seed_b64)?;
    let did = did_key_from_verifying(&sk.verifying_key());
    let handle = alloc_handle();
    IDENTITIES.with(|m| {
        m.borrow_mut().insert(handle, sk);
    });
    Ok((did, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed, NON-secret seeds for deterministic tests.
    const SEED: [u8; SEED_LEN] = [7u8; SEED_LEN];
    const OTHER_SEED: [u8; SEED_LEN] = [9u8; SEED_LEN];

    #[test]
    fn did_key_has_ed25519_shape_and_roundtrips() {
        let sk = signing_key_from_seed(&SEED);
        let did = did_key_from_verifying(&sk.verifying_key());
        // Every ed25519 did:key renders with the z6Mk… prefix (0xed01 multicodec).
        assert!(did.starts_with("did:key:z6Mk"), "got {did}");
        // Decoding the did:key recovers the exact public key.
        let vk = verifying_from_did_key(&did).unwrap();
        assert_eq!(vk.as_bytes(), sk.verifying_key().as_bytes());
    }

    #[test]
    fn did_key_is_deterministic_from_seed() {
        let a = did_key_from_verifying(&signing_key_from_seed(&SEED).verifying_key());
        let b = did_key_from_verifying(&signing_key_from_seed(&SEED).verifying_key());
        assert_eq!(a, b);
        let c = did_key_from_verifying(&signing_key_from_seed(&OTHER_SEED).verifying_key());
        assert_ne!(a, c);
    }

    #[test]
    fn sign_then_verify_ok() {
        let h = identity_from_seed(&SEED);
        let did = master_did(h).unwrap();
        let payload =
            br#"{"webId":"https://pod.example.org/work/profile/card#me","controller":"did:key:z6MkExample","nonce":"abc123"}"#;
        let sig = sign_detached(h, payload).unwrap();
        assert!(verify_binding(&did, payload, &sig).unwrap());
        identity_lock(h);
    }

    #[test]
    fn wrong_payload_fails_verify() {
        let h = identity_from_seed(&SEED);
        let did = master_did(h).unwrap();
        let sig = sign_detached(h, b"original payload").unwrap();
        assert!(!verify_binding(&did, b"tampered payload", &sig).unwrap());
        identity_lock(h);
    }

    #[test]
    fn wrong_did_fails_verify() {
        let h = identity_from_seed(&SEED);
        let sig = sign_detached(h, b"payload").unwrap();
        // A different seed → different did:key → must not verify.
        let other_did =
            did_key_from_verifying(&signing_key_from_seed(&OTHER_SEED).verifying_key());
        assert!(!verify_binding(&other_did, b"payload", &sig).unwrap());
        identity_lock(h);
    }

    #[test]
    fn tampered_signature_fails_verify() {
        let h = identity_from_seed(&SEED);
        let did = master_did(h).unwrap();
        let sig = sign_detached(h, b"payload").unwrap();
        let mut raw = b64_decode(&sig).unwrap();
        raw[0] ^= 0xff;
        let bad = b64_encode(&raw);
        assert!(!verify_binding(&did, b"payload", &bad).unwrap());
        identity_lock(h);
    }

    #[test]
    fn malformed_inputs_error() {
        // Wrong DID method.
        assert!(verifying_from_did_key("did:web:example.com").is_err());
        // Not base58btc multibase (no leading 'z').
        assert!(verifying_from_did_key("did:key:Qabc").is_err());
        // Not a did:key at all.
        assert!(verify_binding("nonsense", b"x", "AAAA").is_err());
        // Valid DID but signature wrong length.
        let did = did_key_from_verifying(&signing_key_from_seed(&SEED).verifying_key());
        assert!(verify_binding(&did, b"x", &b64_encode(b"too short")).is_err());
    }

    #[test]
    fn seed_b64_helper_matches_typed_path() {
        let did_typed = master_did(identity_from_seed(&SEED)).unwrap();
        let did_b64 = master_did(identity_from_seed_b64(&b64_encode(&SEED)).unwrap()).unwrap();
        assert_eq!(did_typed, did_b64);
    }

    #[test]
    fn wrong_seed_length_b64_errors() {
        assert!(identity_from_seed_b64(&b64_encode(&[1u8; 16])).is_err());
        assert!(identity_from_seed_b64(&b64_encode(&[1u8; 64])).is_err());
        assert!(identity_from_seed_b64("not base64!!").is_err());
    }

    #[test]
    fn lock_invalidates_handle_and_is_idempotent() {
        let h = identity_from_seed(&SEED);
        identity_lock(h);
        identity_lock(h); // idempotent, no panic
        assert!(master_did(h).is_err());
        assert!(sign_detached(h, b"x").is_err());
    }

    #[test]
    fn signatures_are_deterministic_eddsa() {
        // Ed25519 is deterministic: same key + same message ⇒ identical signature.
        let h = identity_from_seed(&SEED);
        let a = sign_detached(h, b"same message").unwrap();
        let b = sign_detached(h, b"same message").unwrap();
        assert_eq!(a, b);
        identity_lock(h);
    }

    // ---- C1: envelope-wrapped keystore ------------------------------------

    #[test]
    fn keystore_create_unlock_roundtrip() {
        // FLOOR keeps Argon2id cheap for tests.
        let (ks, sk) = create_keystore("correct horse", KdfParams::FLOOR).unwrap();
        assert!(ks.did.starts_with("did:key:z6Mk"), "got {}", ks.did);
        // Unlocking with the right password recovers the SAME key (same did).
        let sk2 =
            unlock_keystore("correct horse", &ks.salt_b64, ks.kdf, &ks.wrapped_seed_b64).unwrap();
        assert_eq!(
            did_key_from_verifying(&sk.verifying_key()),
            did_key_from_verifying(&sk2.verifying_key())
        );
        assert_eq!(ks.did, did_key_from_verifying(&sk2.verifying_key()));
    }

    #[test]
    fn keystore_wrong_password_fails_unlock() {
        let (ks, _sk) = create_keystore("right", KdfParams::FLOOR).unwrap();
        assert!(unlock_keystore("wrong", &ks.salt_b64, ks.kdf, &ks.wrapped_seed_b64).is_err());
    }

    #[test]
    fn keystore_is_freshly_random_each_create() {
        // Identity CREATION (not derivation): two creates with the same password
        // yield different seeds/dids — the seed is a fresh CSPRNG draw.
        let (a, _) = create_keystore("pw", KdfParams::FLOOR).unwrap();
        let (b, _) = create_keystore("pw", KdfParams::FLOOR).unwrap();
        assert_ne!(a.did, b.did);
        assert_ne!(a.wrapped_seed_b64, b.wrapped_seed_b64);
    }

    #[test]
    fn identity_create_then_unlock_share_did_and_can_sign() {
        let (ks, h) = identity_create("pw", KdfParams::FLOOR).unwrap();
        let did = master_did(h).unwrap();
        assert_eq!(did, ks.did);
        let payload = b"binding payload";
        let sig = sign_detached(h, payload).unwrap();
        assert!(verify_binding(&did, payload, &sig).unwrap());
        identity_lock(h);

        // A fresh unlock yields the same did and verifies the earlier signature.
        let (did2, h2) =
            identity_unlock("pw", &ks.salt_b64, ks.kdf, &ks.wrapped_seed_b64).unwrap();
        assert_eq!(did2, did);
        assert!(verify_binding(&did2, payload, &sig).unwrap());
        identity_lock(h2);
    }
}
