//! Native (non-WASM) API surface for the Tauri desktop shell.
//!
//! This is the analogue of the `wasm` module in `lib.rs`: it exposes the SAME
//! crypto operations as the WASM FFI (CONTRACT.md), built on the SAME store-free
//! primitives in `envelope`/`kdf`/`generate`/`totp`/`hibp`, so the crypto logic
//! exists exactly once. It is NOT a wider FFI: like the WASM path it returns only
//! ciphertext, wrapped keys, KDF params, salts, and short-lived display values,
//! and the unlocked session is referenced ONLY by an opaque `u32` handle.
//!
//! What native adds over WASM (PRD-NATIVE §2): the unlocked data key is pinned
//! into physical RAM (`mlock`/`VirtualLock`, see `memlock`) for its whole
//! lifetime and zeroized on drop, and the session store is process-global and
//! thread-safe (`Mutex`) so a handle stays valid across Tauri's async worker
//! threads — unlike the WASM `thread_local!` store.
//!
//! HARD rules honored: no plaintext/keys ever leave these functions; nothing is
//! logged here (callers in `src-tauri` log WebID/route/event only).
#![cfg(not(target_arch = "wasm32"))]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use ed25519_dalek::SigningKey;

use crate::envelope::{self, SealedItem, Unlocked, VaultBootstrap};
use crate::error::CoreError;
use crate::generate::{self, PwGenOptions};
use crate::identity as id_core;
use crate::kdf::{self, KdfParams};
use crate::memlock::{LockState, MlockedBytes};
use crate::{hibp, totp};

/// An unlocked vault session held in native memory. The `Unlocked` value (which
/// inlines the 256-bit data key) is boxed so its heap address is stable, then
/// that allocation is pinned into RAM. A separate pinned copy of the data key is
/// kept purely as the canonical "locked region" whose state we can report; the
/// authoritative key used for crypto is the one inside `inner` (zeroize-on-drop).
struct HardenedSession {
    inner: Box<Unlocked>,
    /// Pins the inner allocation (and therefore the inline data key) into RAM.
    /// Held for the session's whole lifetime; unlocked + zeroized on drop.
    _pin: MlockedBytes,
}

impl HardenedSession {
    fn new(unlocked: Unlocked) -> Self {
        let inner = Box::new(unlocked);
        // Pin the box's backing allocation: the inline `data_key` lives here, so
        // mlock'ing this region keeps the crown-jewel key out of swap.
        // SAFETY: `inner` owns a stable heap allocation alive for `self`'s life;
        // `_pin` is dropped (unlocked) before `inner`, both owned by `self`.
        let pin = MlockedBytes::new(unsafe {
            std::slice::from_raw_parts(
                (&*inner as *const Unlocked) as *const u8,
                std::mem::size_of::<Unlocked>(),
            )
        });
        HardenedSession { inner, _pin: pin }
    }

    fn lock_state(&self) -> LockState {
        self._pin.lock_state()
    }
}

fn store() -> &'static Mutex<HashMap<u32, HardenedSession>> {
    static STORE: OnceLock<Mutex<HashMap<u32, HardenedSession>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_handle() -> &'static Mutex<u32> {
    static NEXT: OnceLock<Mutex<u32>> = OnceLock::new();
    NEXT.get_or_init(|| Mutex::new(1))
}

fn alloc_handle() -> u32 {
    let mut n = next_handle().lock().expect("handle counter poisoned");
    let h = *n;
    *n = n.wrapping_add(1).max(1);
    h
}

fn locked_store() -> std::sync::MutexGuard<'static, HashMap<u32, HardenedSession>> {
    // A poisoned mutex means a prior panic *while holding key material*; recover
    // the guard rather than propagating, then carry on (we never expose bytes).
    store().lock().unwrap_or_else(|e| e.into_inner())
}

// ---- contract operations (same names/shapes as CONTRACT.md) -----------------

/// `calibrate_kdf` — time Argon2id on this device and return params hitting
/// ~`target_ms`, floored at the OWASP baseline.
pub fn calibrate_kdf(target_ms: f64) -> Result<KdfParams, CoreError> {
    kdf::calibrate_kdf(target_ms)
}

/// `create_vault` — fresh random data key wrapped by the stretched master key.
/// Returns the non-secret bootstrap to persist in `vault.ttl`. Does NOT unlock.
pub fn create_vault(master_password: &str, params: KdfParams) -> Result<VaultBootstrap, CoreError> {
    envelope::create_vault(master_password, params)
}

/// `unlock` — derive the stretched key, unwrap the data key, pin it into RAM,
/// and stash it behind a fresh opaque handle. Returns the handle (the ONLY thing
/// the caller holds). Errors generically on wrong password.
pub fn unlock(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_data_key_b64: &str,
) -> Result<u32, CoreError> {
    let unlocked = envelope::derive_unlocked(master_password, salt_b64, params, wrapped_data_key_b64)?;
    let session = HardenedSession::new(unlocked);
    let handle = alloc_handle();
    locked_store().insert(handle, session);
    Ok(handle)
}

/// Whether the unlocked-key region for `handle` is actually pinned into RAM on
/// this host (`Locked`) or the OS refused (`Unlocked`). Lets the native layer
/// log/telemeter the hardening guarantee WITHOUT touching key bytes. Returns
/// `None` for an unknown/locked handle.
pub fn lock_state(handle: u32) -> Option<LockState> {
    locked_store().get(&handle).map(|s| s.lock_state())
}

/// `lock` — zeroize + unpin + drop the session. Idempotent.
pub fn lock(handle: u32) {
    // Drop happens outside the store lock to keep the critical section short;
    // `HardenedSession`'s Drop zeroizes then munlocks.
    let removed = locked_store().remove(&handle);
    drop(removed);
}

/// `encrypt_item` — random per-item key, AEAD the plaintext with AAD(id,ver),
/// wrap the per-item key under the data key.
pub fn encrypt_item(
    handle: u32,
    item_id: &str,
    version: u32,
    plaintext_json: &str,
) -> Result<SealedItem, CoreError> {
    let guard = locked_store();
    let sess = guard.get(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
    envelope::encrypt_item_with(&sess.inner, item_id, version, plaintext_json)
}

/// `decrypt_item` — unwrap the per-item key, verify AAD + tag, decrypt. Returns
/// the plaintext JSON as a short-lived display value.
pub fn decrypt_item(
    handle: u32,
    item_id: &str,
    version: u32,
    sealed: &SealedItem,
) -> Result<String, CoreError> {
    let guard = locked_store();
    let sess = guard.get(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
    envelope::decrypt_item_with(&sess.inner, item_id, version, sealed)
}

/// `change_password` — re-derive from `new_password` (fresh salt) and RE-WRAP the
/// existing data key only (bulk ciphertext untouched). The handle stays valid.
/// Returns the new bootstrap to persist.
pub fn change_password(
    handle: u32,
    new_password: &str,
    params: KdfParams,
) -> Result<VaultBootstrap, CoreError> {
    let mut guard = locked_store();
    let sess = guard.get_mut(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
    envelope::change_password_with(&mut sess.inner, new_password, params)
}

/// `generate_password` — CSPRNG password (display value).
pub fn generate_password(opts: PwGenOptions) -> Result<String, CoreError> {
    generate::generate_password(opts)
}

/// `generate_passphrase` — CSPRNG passphrase (display value).
pub fn generate_passphrase(words: u32, separator: &str) -> Result<String, CoreError> {
    generate::generate_passphrase(words, separator)
}

/// `totp_at` — RFC 6238 TOTP at an explicit host-supplied timestamp.
pub fn totp_at(
    secret_b32: &str,
    unix_seconds: u64,
    period: u32,
    digits: u32,
) -> Result<String, CoreError> {
    totp::totp_at(secret_b32, unix_seconds, period, digits)
}

/// `hibp_prefix` — SHA-1 the password locally; return the 5-char prefix (sent to
/// the HIBP range API) and the suffix (compared locally). Password/full hash
/// never leave the device.
pub fn hibp_prefix(password: &str) -> hibp::HibpPrefix {
    hibp::hibp_prefix(password)
}

// ---- identity / DID layer (PRD-DID §5.9) ------------------------------------
//
// The wallet's master Ed25519 identity, hardened the same way as a vault session:
// the `SigningKey` is boxed (stable address), then that allocation is pinned into
// RAM (`mlock`/`VirtualLock`) for the session's whole lifetime and zeroized on
// drop. The store is process-global + thread-safe so a handle stays valid across
// Tauri's async worker threads. The seed/private key never leave these functions
// — callers receive only the opaque handle, the public did:key, and signatures.

/// A master-identity session held in native memory. Like `HardenedSession`, the
/// `SigningKey` is boxed so its heap address is stable, then pinned into RAM.
struct HardenedIdentity {
    inner: Box<SigningKey>,
    /// Pins the inner allocation (and therefore the secret seed) into RAM. Held
    /// for the session's whole lifetime; unlocked + zeroized on drop.
    _pin: MlockedBytes,
}

impl HardenedIdentity {
    fn new(sk: SigningKey) -> Self {
        let inner = Box::new(sk);
        // Pin the box's backing allocation: the secret key bytes live here, so
        // mlock'ing this region keeps the master key out of swap.
        // SAFETY: `inner` owns a stable heap allocation alive for `self`'s life;
        // `_pin` is dropped (unlocked) before `inner`, both owned by `self`.
        let pin = MlockedBytes::new(unsafe {
            std::slice::from_raw_parts(
                (&*inner as *const SigningKey) as *const u8,
                std::mem::size_of::<SigningKey>(),
            )
        });
        HardenedIdentity { inner, _pin: pin }
    }
}

fn id_store() -> &'static Mutex<HashMap<u32, HardenedIdentity>> {
    static STORE: OnceLock<Mutex<HashMap<u32, HardenedIdentity>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locked_id_store() -> std::sync::MutexGuard<'static, HashMap<u32, HardenedIdentity>> {
    id_store().lock().unwrap_or_else(|e| e.into_inner())
}

/// `identity_from_seed` — derive the master `SigningKey` from a 32-byte seed, pin
/// it into RAM, and stash it behind a fresh opaque handle. The seed is borrowed
/// and not retained.
pub fn identity_from_seed(seed: &[u8; id_core::SEED_LEN]) -> u32 {
    let sk = id_core::signing_key_from_seed(seed);
    let session = HardenedIdentity::new(sk);
    let handle = alloc_handle();
    locked_id_store().insert(handle, session);
    handle
}

/// `master_did` — the session's master `did:key` (public material only).
pub fn master_did(handle: u32) -> Result<String, CoreError> {
    let guard = locked_id_store();
    let sess = guard
        .get(&handle)
        .ok_or(CoreError::Session("unknown or locked identity handle"))?;
    Ok(id_core::did_key_from_verifying(&sess.inner.verifying_key()))
}

/// `sign_detached` — detached EdDSA signature (base64) over `payload`.
pub fn sign_detached(handle: u32, payload: &[u8]) -> Result<String, CoreError> {
    let guard = locked_id_store();
    let sess = guard
        .get(&handle)
        .ok_or(CoreError::Session("unknown or locked identity handle"))?;
    Ok(id_core::sign_detached_with(&sess.inner, payload))
}

/// `verify_binding` — verify a detached signature against a `did:key`. Pure; no
/// handle/session needed.
pub fn verify_binding(did: &str, payload: &[u8], signature_b64: &str) -> Result<bool, CoreError> {
    id_core::verify_binding(did, payload, signature_b64)
}

/// `identity_lock` — zeroize + unpin + drop the identity session. Idempotent.
pub fn identity_lock(handle: u32) {
    let removed = locked_id_store().remove(&handle);
    drop(removed);
}

/// `identity_create` — generate a fresh master identity, wrap its seed under
/// `master_password` (Argon2id → XChaCha20-Poly1305 envelope), pin the resulting
/// key into RAM, and return the persistable keystore + handle. The seed is
/// generated and zeroized inside the core; only ciphertext + the public did:key
/// leave these functions.
pub fn identity_create(
    master_password: &str,
    params: KdfParams,
) -> Result<(id_core::IdentityKeystore, u32), CoreError> {
    let (keystore, sk) = id_core::create_keystore(master_password, params)?;
    let session = HardenedIdentity::new(sk);
    let handle = alloc_handle();
    locked_id_store().insert(handle, session);
    Ok((keystore, handle))
}

/// `identity_unlock` — unwrap the seed from a stored keystore, pin the key into
/// RAM, and return the public did:key + handle. Errors generically on a wrong
/// master password.
pub fn identity_unlock(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_seed_b64: &str,
) -> Result<(String, u32), CoreError> {
    let sk = id_core::unlock_keystore(master_password, salt_b64, params, wrapped_seed_b64)?;
    let did = id_core::did_key_from_verifying(&sk.verifying_key());
    let session = HardenedIdentity::new(sk);
    let handle = alloc_handle();
    locked_id_store().insert(handle, session);
    Ok((did, handle))
}

// NOTE: OIDC/PKCE auth-transport crypto (CSPRNG for the verifier/state, the
// SHA-256 S256 challenge, DPoP ES256/JWT) deliberately lives in src-tauri's
// auth layer, NOT here — keeping crypto-core's audit surface vault-only (team
// decision). Do not add auth/protocol primitives to this crate.

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: KdfParams = KdfParams::FLOOR;

    #[test]
    fn native_create_unlock_roundtrip_across_threads() {
        let boot = create_vault("correct horse", PARAMS).unwrap();
        let h = unlock("correct horse", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64)
            .unwrap();

        // The native store is global + thread-safe: a handle minted on this
        // thread must be usable from another thread (unlike the WASM path).
        let sealed = std::thread::spawn(move || {
            encrypt_item(h, "item-1", 1, r#"{"pw":"s3cret"}"#).unwrap()
        })
        .join()
        .unwrap();

        let pt = std::thread::spawn(move || decrypt_item(h, "item-1", 1, &sealed).unwrap())
            .join()
            .unwrap();
        assert_eq!(pt, r#"{"pw":"s3cret"}"#);
        lock(h);
        assert!(encrypt_item(h, "x", 1, "y").is_err());
    }

    #[test]
    fn native_wrong_password_fails() {
        let boot = create_vault("right", PARAMS).unwrap();
        assert!(unlock("wrong", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).is_err());
    }

    #[test]
    fn native_tamper_and_aad_fail() {
        let boot = create_vault("pw", PARAMS).unwrap();
        let h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        let sealed = encrypt_item(h, "item-A", 3, "data").unwrap();
        // Wrong id / version (AAD) must fail.
        assert!(decrypt_item(h, "item-B", 3, &sealed).is_err());
        assert!(decrypt_item(h, "item-A", 4, &sealed).is_err());
        // Tampered ciphertext must fail.
        let mut bad = sealed.clone();
        bad.ciphertext_b64.insert(0, 'A');
        assert!(decrypt_item(h, "item-A", 3, &bad).is_err());
        assert_eq!(decrypt_item(h, "item-A", 3, &sealed).unwrap(), "data");
        lock(h);
    }

    #[test]
    fn native_change_password_preserves_data_key() {
        let boot = create_vault("old", PARAMS).unwrap();
        let h = unlock("old", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        let sealed = encrypt_item(h, "login-1", 1, r#"{"u":"alice"}"#).unwrap();

        let new_boot = change_password(h, "new", PARAMS).unwrap();
        assert_ne!(new_boot.wrapped_data_key_b64, boot.wrapped_data_key_b64);
        // Same handle still decrypts pre-change items.
        assert_eq!(decrypt_item(h, "login-1", 1, &sealed).unwrap(), r#"{"u":"alice"}"#);
        lock(h);

        // Fresh unlock with the NEW bootstrap reads it; old password does not.
        let h2 = unlock("new", &new_boot.salt_b64, new_boot.kdf, &new_boot.wrapped_data_key_b64)
            .unwrap();
        assert_eq!(decrypt_item(h2, "login-1", 1, &sealed).unwrap(), r#"{"u":"alice"}"#);
        assert!(unlock("old", &new_boot.salt_b64, new_boot.kdf, &new_boot.wrapped_data_key_b64)
            .is_err());
        lock(h2);
    }

    #[test]
    fn native_lock_is_idempotent_and_reports_lock_state() {
        let boot = create_vault("pw", PARAMS).unwrap();
        let h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        // The unlocked region reports a defined lock state (Locked on a normal
        // host; Unlocked if RLIMIT_MEMLOCK forbids it). Never panics.
        assert!(matches!(lock_state(h), Some(LockState::Locked | LockState::Unlocked)));
        lock(h);
        lock(h); // idempotent
        assert_eq!(lock_state(h), None);
    }

    #[test]
    fn native_generators_and_totp_and_hibp() {
        let pw = generate_password(PwGenOptions {
            length: 24,
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        })
        .unwrap();
        assert_eq!(pw.chars().count(), 24);

        let phrase = generate_passphrase(4, "-").unwrap();
        assert_eq!(phrase.split('-').count(), 4);

        // RFC 6238 SHA-1 vector.
        let code = totp_at("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59, 30, 8).unwrap();
        assert_eq!(code, "94287082");

        let r = hibp_prefix("password");
        assert_eq!(r.prefix, "5BAA6");
    }

    #[test]
    fn native_identity_sign_verify_roundtrip_across_threads() {
        let seed = [3u8; id_core::SEED_LEN];
        let h = identity_from_seed(&seed);
        let did = master_did(h).unwrap();
        assert!(did.starts_with("did:key:z6Mk"), "got {did}");

        // The native identity store is global + thread-safe: a handle minted on
        // this thread must be usable from another thread.
        let did_for_thread = did.clone();
        let (sig, ok) = std::thread::spawn(move || {
            let s = sign_detached(h, b"binding-payload").unwrap();
            let v = verify_binding(&did_for_thread, b"binding-payload", &s).unwrap();
            (s, v)
        })
        .join()
        .unwrap();
        assert!(ok);
        // Tamper / wrong-payload must fail.
        assert!(!verify_binding(&did, b"other", &sig).unwrap());

        identity_lock(h);
        identity_lock(h); // idempotent
        assert!(master_did(h).is_err());
        assert!(sign_detached(h, b"x").is_err());
    }

    #[test]
    fn native_identity_keystore_create_unlock_roundtrip() {
        // Create a fresh wallet identity, sign with it, then unlock from the
        // persisted keystore and confirm the same did verifies the signature.
        let (ks, h) = identity_create("master pw", PARAMS).unwrap();
        assert!(ks.did.starts_with("did:key:z6Mk"), "got {}", ks.did);
        assert_eq!(master_did(h).unwrap(), ks.did);
        let sig = sign_detached(h, b"payload").unwrap();
        identity_lock(h);

        let (did2, h2) =
            identity_unlock("master pw", &ks.salt_b64, ks.kdf, &ks.wrapped_seed_b64).unwrap();
        assert_eq!(did2, ks.did);
        assert!(verify_binding(&did2, b"payload", &sig).unwrap());
        identity_lock(h2);

        // Wrong password must fail to unlock.
        assert!(identity_unlock("nope", &ks.salt_b64, ks.kdf, &ks.wrapped_seed_b64).is_err());
    }

    #[test]
    fn native_identity_and_vault_stores_are_separate() {
        // Vault and identity are distinct maps drawn from the same monotonic
        // handle counter, so their handles never collide. A vault handle must not
        // resolve in the identity store (and vice-versa) — no cross-store leakage.
        let boot = create_vault("pw", PARAMS).unwrap();
        let vault_h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        let id_h = identity_from_seed(&[5u8; id_core::SEED_LEN]);

        assert_ne!(vault_h, id_h, "shared counter must hand out distinct handles");
        // A vault handle is unknown to the identity API…
        assert!(master_did(vault_h).is_err());
        // …and an identity handle is unknown to the vault API.
        assert!(encrypt_item(id_h, "x", 1, "y").is_err());
        // Each works on its own API.
        assert!(master_did(id_h).unwrap().starts_with("did:key:z6Mk"));

        lock(vault_h);
        identity_lock(id_h);
    }
}
