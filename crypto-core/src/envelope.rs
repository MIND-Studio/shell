//! Envelope encryption + the unlocked-session store.
//!
//! Two-level key hierarchy (PRD §5.2):
//!   stretched master key  --wraps-->  vault data key (256-bit, random)
//!   vault data key        --wraps-->  per-item key (256-bit, random)
//!   per-item key          --AEADs-->  item ciphertext (AAD = "{id}:{version}")
//!
//! Wrapping is itself XChaCha20-Poly1305: a wrapped key = nonce(24) || ct||tag.
//! `change_password` re-wraps the data key only; bulk item ciphertext is
//! untouched. The unlocked stretched key + data key live ONLY in WASM memory,
//! addressed by an opaque u32 handle; raw keys never cross the FFI.

use std::cell::RefCell;
use std::collections::HashMap;

use base64::Engine;
use secrecy::SecretBox;
use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

use crate::aead::{self, NONCE_LEN};
use crate::error::CoreError;
use crate::kdf::{self, KdfParams, StretchedKey, KEY_LEN};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, CoreError> {
    B64.decode(s.as_bytes())
        .map_err(|e| CoreError::Encoding(format!("base64: {e}")))
}

// ---- contract data shapes ---------------------------------------------------

/// `create_vault` / `change_password` output. Matches `VaultBootstrap` in the
/// FFI contract.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultBootstrap {
    pub kdf: KdfParams,
    pub salt_b64: String,
    pub wrapped_data_key_b64: String,
}

/// `encrypt_item` output / `decrypt_item` input. Matches `SealedItem`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SealedItem {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
    pub wrapped_item_key_b64: String,
}

// ---- key wrapping -----------------------------------------------------------

/// Wrap a 256-bit key under `wrapping_key`. Output bytes = nonce(24) || sealed.
/// AAD binds the wrapped blob to its purpose.
fn wrap_key(
    wrapping_key: &[u8; KEY_LEN],
    key: &[u8; KEY_LEN],
    aad: &[u8],
) -> Result<Vec<u8>, CoreError> {
    let nonce = aead::random_nonce();
    let sealed = aead::seal(wrapping_key, &nonce, aad, key)?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Unwrap a key previously produced by `wrap_key`.
fn unwrap_key(
    wrapping_key: &[u8; KEY_LEN],
    wrapped: &[u8],
    aad: &[u8],
) -> Result<[u8; KEY_LEN], CoreError> {
    if wrapped.len() < NONCE_LEN {
        return Err(CoreError::Encoding("wrapped key too short".into()));
    }
    let (nonce, sealed) = wrapped.split_at(NONCE_LEN);
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce);
    let plain = aead::open(wrapping_key, &nonce_arr, aad, sealed)?;
    if plain.len() != KEY_LEN {
        return Err(CoreError::Aead("unwrapped key wrong length"));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&plain);
    Ok(key)
}

const DATA_KEY_AAD: &[u8] = b"mind-shell/vault/v1/data-key";
const ITEM_KEY_AAD: &[u8] = b"mind-shell/vault/v1/item-key";

fn item_aad(item_id: &str, version: u32) -> Vec<u8> {
    format!("{item_id}:{version}").into_bytes()
}

// ---- unlocked session -------------------------------------------------------

/// Key material for an unlocked vault. Never serialized, never crosses the FFI.
/// Zeroized on drop (and on `lock`).
///
/// On the WASM path this lives in WASM linear memory behind the `thread_local!`
/// store below. On the native path it is held inside a `HardenedSession`
/// (`session.rs`) whose key region is additionally `mlock`'d/`VirtualLock`'d —
/// see PRD-NATIVE §2. Either way the bytes never leave the core.
#[derive(ZeroizeOnDrop)]
pub struct Unlocked {
    /// Unwrapped vault data key.
    data_key: [u8; KEY_LEN],
    /// Stretched master key (wrap subkey is what re-wrap/change-password need).
    #[zeroize(skip)]
    stretched: SecretBox<StretchedKey>,
    /// Salt used to derive the current stretched key (for change_password reuse
    /// is NOT done — change_password rolls a fresh salt; kept for completeness).
    #[zeroize(skip)]
    salt: Vec<u8>,
}

thread_local! {
    static SESSIONS: RefCell<HashMap<u32, Unlocked>> = RefCell::new(HashMap::new());
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

// ---- contract operations ----------------------------------------------------

/// Generate a 128-bit salt.
fn random_salt() -> [u8; 16] {
    use rand::RngCore;
    let mut s = [0u8; 16];
    crate::rng::os_rng().fill_bytes(&mut s);
    s
}

/// `create_vault`: fresh random data key, wrapped by the stretched master key.
/// Does NOT unlock.
pub fn create_vault(
    master_password: &str,
    params: KdfParams,
) -> Result<VaultBootstrap, CoreError> {
    let params = params.clamped();
    let salt = random_salt();
    let stretched = kdf::derive_stretched_key(master_password.as_bytes(), &salt, params)?;
    let wrap_key_bytes = kdf::expose_wrap_key(&stretched);

    let data_key = aead::random_key();
    let wrapped = wrap_key(&wrap_key_bytes, &data_key, DATA_KEY_AAD)?;

    Ok(VaultBootstrap {
        kdf: params,
        salt_b64: b64_encode(&salt),
        wrapped_data_key_b64: b64_encode(&wrapped),
    })
}

/// Store-free unlock: derive the stretched key and unwrap the data key into an
/// `Unlocked` value, WITHOUT inserting it into any session store. Both the WASM
/// `thread_local!` store and the native hardened store build on this so the
/// crypto logic exists exactly once. Errors (generically) on wrong password
/// (AEAD tag failure).
pub fn derive_unlocked(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_data_key_b64: &str,
) -> Result<Unlocked, CoreError> {
    let salt = b64_decode(salt_b64)?;
    let stretched = kdf::derive_stretched_key(master_password.as_bytes(), &salt, params)?;
    let wrap_key_bytes = kdf::expose_wrap_key(&stretched);

    let wrapped = b64_decode(wrapped_data_key_b64)?;
    let data_key = unwrap_key(&wrap_key_bytes, &wrapped, DATA_KEY_AAD)?;

    Ok(Unlocked { data_key, stretched, salt })
}

/// `unlock`: derive the stretched key, unwrap the data key, stash both keyed by
/// a fresh handle. Errors (generically) on wrong password (AEAD tag failure).
pub fn unlock(
    master_password: &str,
    salt_b64: &str,
    params: KdfParams,
    wrapped_data_key_b64: &str,
) -> Result<u32, CoreError> {
    let unlocked = derive_unlocked(master_password, salt_b64, params, wrapped_data_key_b64)?;

    let handle = alloc_handle();
    SESSIONS.with(|s| {
        s.borrow_mut().insert(handle, unlocked);
    });
    Ok(handle)
}

/// `lock`: zeroize + drop the session. Idempotent.
pub fn lock(handle: u32) {
    SESSIONS.with(|s| {
        // Removing drops `Unlocked`, which zeroizes the data key (and the
        // SecretBox<StretchedKey> zeroizes its subkeys on its own drop).
        s.borrow_mut().remove(&handle);
    });
}

/// Store-free `encrypt_item`: operate on an already-unlocked session. Random
/// per-item key, AEAD the plaintext under it with the item AAD, wrap the per-item
/// key under the data key. Shared by the WASM store and the native store.
pub fn encrypt_item_with(
    sess: &Unlocked,
    item_id: &str,
    version: u32,
    plaintext_json: &str,
) -> Result<SealedItem, CoreError> {
    let item_key = aead::random_key();
    let nonce = aead::random_nonce();
    let aad = item_aad(item_id, version);
    let ciphertext = aead::seal(&item_key, &nonce, &aad, plaintext_json.as_bytes())?;
    let wrapped_item_key = wrap_key(&sess.data_key, &item_key, ITEM_KEY_AAD)?;

    Ok(SealedItem {
        ciphertext_b64: b64_encode(&ciphertext),
        nonce_b64: b64_encode(&nonce),
        wrapped_item_key_b64: b64_encode(&wrapped_item_key),
    })
}

/// Store-free `decrypt_item`: operate on an already-unlocked session. Unwrap the
/// per-item key, verify AAD + tag, decrypt.
pub fn decrypt_item_with(
    sess: &Unlocked,
    item_id: &str,
    version: u32,
    sealed: &SealedItem,
) -> Result<String, CoreError> {
    let wrapped_item_key = b64_decode(&sealed.wrapped_item_key_b64)?;
    let item_key = unwrap_key(&sess.data_key, &wrapped_item_key, ITEM_KEY_AAD)?;

    let nonce_bytes = b64_decode(&sealed.nonce_b64)?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(CoreError::Encoding("nonce wrong length".into()));
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&nonce_bytes);

    let ciphertext = b64_decode(&sealed.ciphertext_b64)?;
    let aad = item_aad(item_id, version);
    let plain = aead::open(&item_key, &nonce, &aad, &ciphertext)?;

    String::from_utf8(plain).map_err(|_| CoreError::Aead("plaintext not utf-8"))
}

/// Store-free `change_password`: derive from `new_password` (fresh salt), RE-WRAP
/// the existing data key only, and update the session's stretched key + salt
/// in place so its handle stays valid. Bulk item ciphertext is untouched.
pub fn change_password_with(
    sess: &mut Unlocked,
    new_password: &str,
    params: KdfParams,
) -> Result<VaultBootstrap, CoreError> {
    let params = params.clamped();
    let new_salt = random_salt();
    let new_stretched = kdf::derive_stretched_key(new_password.as_bytes(), &new_salt, params)?;
    let new_wrap_key = kdf::expose_wrap_key(&new_stretched);

    // Re-wrap the SAME data key under the new stretched key.
    let wrapped = wrap_key(&new_wrap_key, &sess.data_key, DATA_KEY_AAD)?;

    // Update the live session so the handle keeps working post-change.
    sess.stretched = new_stretched;
    sess.salt = new_salt.to_vec();

    Ok(VaultBootstrap {
        kdf: params,
        salt_b64: b64_encode(&new_salt),
        wrapped_data_key_b64: b64_encode(&wrapped),
    })
}

/// `encrypt_item`: random per-item key, AEAD the plaintext under it with the
/// item AAD, wrap the per-item key under the data key.
pub fn encrypt_item(
    handle: u32,
    item_id: &str,
    version: u32,
    plaintext_json: &str,
) -> Result<SealedItem, CoreError> {
    SESSIONS.with(|s| {
        let map = s.borrow();
        let sess = map.get(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
        encrypt_item_with(sess, item_id, version, plaintext_json)
    })
}

/// `decrypt_item`: unwrap the per-item key, verify AAD + tag, decrypt.
pub fn decrypt_item(
    handle: u32,
    item_id: &str,
    version: u32,
    sealed: &SealedItem,
) -> Result<String, CoreError> {
    SESSIONS.with(|s| {
        let map = s.borrow();
        let sess = map.get(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
        decrypt_item_with(sess, item_id, version, sealed)
    })
}

/// `change_password`: derive from `new_password` (fresh salt) and RE-WRAP the
/// existing data key only. Bulk item ciphertext is untouched. The session's
/// stretched key + salt are updated in place so the handle stays valid.
pub fn change_password(
    handle: u32,
    new_password: &str,
    params: KdfParams,
) -> Result<VaultBootstrap, CoreError> {
    SESSIONS.with(|s| {
        let mut map = s.borrow_mut();
        let sess = map.get_mut(&handle).ok_or(CoreError::Session("unknown or locked handle"))?;
        change_password_with(sess, new_password, params)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: KdfParams = KdfParams::FLOOR;

    #[test]
    fn create_unlock_roundtrip() {
        let boot = create_vault("correct horse", PARAMS).unwrap();
        let h = unlock("correct horse", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64)
            .unwrap();
        let sealed = encrypt_item(h, "item-1", 1, r#"{"pw":"s3cret"}"#).unwrap();
        let pt = decrypt_item(h, "item-1", 1, &sealed).unwrap();
        assert_eq!(pt, r#"{"pw":"s3cret"}"#);
        lock(h);
    }

    #[test]
    fn wrong_password_fails_unlock() {
        let boot = create_vault("right", PARAMS).unwrap();
        let r = unlock("wrong", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64);
        assert!(r.is_err());
    }

    #[test]
    fn tampered_item_ciphertext_fails() {
        let boot = create_vault("pw", PARAMS).unwrap();
        let h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        let mut sealed = encrypt_item(h, "i", 1, "hello").unwrap();
        // Flip a byte in the ciphertext.
        let mut raw = b64_decode(&sealed.ciphertext_b64).unwrap();
        raw[0] ^= 0xff;
        sealed.ciphertext_b64 = b64_encode(&raw);
        assert!(decrypt_item(h, "i", 1, &sealed).is_err());
        lock(h);
    }

    #[test]
    fn aad_mismatch_item_id_or_version_fails() {
        let boot = create_vault("pw", PARAMS).unwrap();
        let h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        let sealed = encrypt_item(h, "item-A", 3, "data").unwrap();
        assert!(decrypt_item(h, "item-B", 3, &sealed).is_err(), "wrong id must fail");
        assert!(decrypt_item(h, "item-A", 4, &sealed).is_err(), "wrong version must fail");
        assert_eq!(decrypt_item(h, "item-A", 3, &sealed).unwrap(), "data");
        lock(h);
    }

    #[test]
    fn change_password_preserves_data_key() {
        let boot = create_vault("old-pw", PARAMS).unwrap();
        let h = unlock("old-pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();

        // Encrypt an item BEFORE the password change.
        let sealed = encrypt_item(h, "login-1", 1, r#"{"u":"alice"}"#).unwrap();

        // Change the master password (re-wraps the data key only).
        let new_boot = change_password(h, "new-pw", PARAMS).unwrap();
        assert_ne!(new_boot.salt_b64, boot.salt_b64);
        assert_ne!(new_boot.wrapped_data_key_b64, boot.wrapped_data_key_b64);

        // The pre-change item still decrypts on the SAME handle.
        assert_eq!(decrypt_item(h, "login-1", 1, &sealed).unwrap(), r#"{"u":"alice"}"#);
        lock(h);

        // And a fresh unlock with the NEW password + NEW bootstrap reads it too.
        let h2 = unlock("new-pw", &new_boot.salt_b64, new_boot.kdf, &new_boot.wrapped_data_key_b64)
            .unwrap();
        assert_eq!(decrypt_item(h2, "login-1", 1, &sealed).unwrap(), r#"{"u":"alice"}"#);
        // Old password must NOT unlock the new bootstrap.
        assert!(unlock("old-pw", &new_boot.salt_b64, new_boot.kdf, &new_boot.wrapped_data_key_b64)
            .is_err());
        lock(h2);
    }

    #[test]
    fn lock_invalidates_handle_and_is_idempotent() {
        let boot = create_vault("pw", PARAMS).unwrap();
        let h = unlock("pw", &boot.salt_b64, boot.kdf, &boot.wrapped_data_key_b64).unwrap();
        lock(h);
        lock(h); // idempotent, no panic
        assert!(encrypt_item(h, "x", 1, "y").is_err());
    }
}
