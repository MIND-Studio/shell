//! `crypto-core` — the zero-knowledge crypto core for the mind-shell Vault.
//!
//! ONE codebase, two targets:
//!   * native `rlib`/`cdylib` for `cargo test` and the future Tauri sidecar
//!   * `wasm32` `cdylib` (via `wasm-pack`) for the in-pod web app
//!
//! All `#[wasm_bindgen]` exports live behind `#[cfg(target_arch = "wasm32")]`
//! in the `wasm` module, so the pure-Rust core compiles and is tested natively.
//! The plain Rust functions in `kdf`/`aead`/`envelope`/`generate`/`totp`/`hibp`
//! are the real implementation; the wasm shims are thin marshalling wrappers.
//!
//! ZERO-KNOWLEDGE INVARIANT (PRD §5.5 / CONTRACT.md): raw key material and
//! plaintext secrets never cross the FFI. Unlocked keys live in WASM linear
//! memory behind an opaque u32 session handle; JS receives only ciphertext,
//! wrapped keys, KDF params, salts, or short-lived display values.

pub mod aead;
pub mod envelope;
pub mod error;
pub mod generate;
pub mod hibp;
pub mod identity;
pub mod kdf;
pub mod rng;
pub mod time;
pub mod totp;

// Native-only: memory hardening + the native (Tauri) API surface. Gated off
// wasm32 so the web path is unaffected and never pulls `libc`.
#[cfg(not(target_arch = "wasm32"))]
pub mod memlock;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;

pub use envelope::{SealedItem, VaultBootstrap};
pub use error::CoreError;
pub use generate::PwGenOptions;
pub use kdf::KdfParams;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use serde::{Deserialize, Serialize};
    use wasm_bindgen::prelude::*;

    // ---- JS-facing struct shapes (camelCase where the TS contract uses it) --

    #[derive(Serialize, Deserialize)]
    struct JsKdfParams {
        m_kib: u32,
        t: u32,
        p: u32,
    }
    impl From<JsKdfParams> for KdfParams {
        fn from(v: JsKdfParams) -> Self {
            KdfParams { m_kib: v.m_kib, t: v.t, p: v.p }
        }
    }
    impl From<KdfParams> for JsKdfParams {
        fn from(v: KdfParams) -> Self {
            JsKdfParams { m_kib: v.m_kib, t: v.t, p: v.p }
        }
    }

    #[derive(Serialize)]
    struct JsVaultBootstrap {
        kdf: JsKdfParams,
        salt_b64: String,
        wrapped_data_key_b64: String,
    }
    impl From<VaultBootstrap> for JsVaultBootstrap {
        fn from(v: VaultBootstrap) -> Self {
            JsVaultBootstrap {
                kdf: v.kdf.into(),
                salt_b64: v.salt_b64,
                wrapped_data_key_b64: v.wrapped_data_key_b64,
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    struct JsSealedItem {
        ciphertext_b64: String,
        nonce_b64: String,
        wrapped_item_key_b64: String,
    }
    impl From<SealedItem> for JsSealedItem {
        fn from(v: SealedItem) -> Self {
            JsSealedItem {
                ciphertext_b64: v.ciphertext_b64,
                nonce_b64: v.nonce_b64,
                wrapped_item_key_b64: v.wrapped_item_key_b64,
            }
        }
    }
    impl From<JsSealedItem> for SealedItem {
        fn from(v: JsSealedItem) -> Self {
            SealedItem {
                ciphertext_b64: v.ciphertext_b64,
                nonce_b64: v.nonce_b64,
                wrapped_item_key_b64: v.wrapped_item_key_b64,
            }
        }
    }

    // The TS contract uses `avoidAmbiguous` (camelCase) for this one field.
    #[derive(Serialize, Deserialize)]
    struct JsPwGenOptions {
        length: u32,
        upper: bool,
        lower: bool,
        digits: bool,
        symbols: bool,
        #[serde(rename = "avoidAmbiguous")]
        avoid_ambiguous: bool,
    }
    impl From<JsPwGenOptions> for PwGenOptions {
        fn from(v: JsPwGenOptions) -> Self {
            PwGenOptions {
                length: v.length,
                upper: v.upper,
                lower: v.lower,
                digits: v.digits,
                symbols: v.symbols,
                avoid_ambiguous: v.avoid_ambiguous,
            }
        }
    }

    #[derive(Serialize)]
    struct JsHibpPrefix {
        prefix: String,
        suffix: String,
    }

    fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
    }
    fn from_js<T: for<'de> Deserialize<'de>>(v: JsValue) -> Result<T, JsValue> {
        serde_wasm_bindgen::from_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
    }
    fn err(e: CoreError) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    // ---- exported FFI surface ----------------------------------------------

    /// Install the panic hook. Call once on module load.
    #[wasm_bindgen]
    pub fn init() {
        console_error_panic_hook::set_once();
    }

    #[wasm_bindgen(js_name = calibrateKdf)]
    pub fn calibrate_kdf(target_ms: f64) -> Result<JsValue, JsValue> {
        let params = kdf::calibrate_kdf(target_ms).map_err(err)?;
        to_js(&JsKdfParams::from(params))
    }

    #[wasm_bindgen(js_name = createVault)]
    pub fn create_vault(master_password: String, params: JsValue) -> Result<JsValue, JsValue> {
        let params: JsKdfParams = from_js(params)?;
        let boot = envelope::create_vault(&master_password, params.into()).map_err(err)?;
        to_js(&JsVaultBootstrap::from(boot))
    }

    #[wasm_bindgen]
    pub fn unlock(
        master_password: String,
        salt_b64: String,
        params: JsValue,
        wrapped_data_key_b64: String,
    ) -> Result<u32, JsValue> {
        let params: JsKdfParams = from_js(params)?;
        envelope::unlock(&master_password, &salt_b64, params.into(), &wrapped_data_key_b64)
            .map_err(err)
    }

    #[wasm_bindgen]
    pub fn lock(handle: u32) {
        envelope::lock(handle);
    }

    #[wasm_bindgen(js_name = encryptItem)]
    pub fn encrypt_item(
        handle: u32,
        item_id: String,
        version: u32,
        plaintext_json: String,
    ) -> Result<JsValue, JsValue> {
        let sealed =
            envelope::encrypt_item(handle, &item_id, version, &plaintext_json).map_err(err)?;
        to_js(&JsSealedItem::from(sealed))
    }

    #[wasm_bindgen(js_name = decryptItem)]
    pub fn decrypt_item(
        handle: u32,
        item_id: String,
        version: u32,
        sealed: JsValue,
    ) -> Result<String, JsValue> {
        let sealed: JsSealedItem = from_js(sealed)?;
        envelope::decrypt_item(handle, &item_id, version, &sealed.into()).map_err(err)
    }

    #[wasm_bindgen(js_name = changePassword)]
    pub fn change_password(
        handle: u32,
        new_password: String,
        params: JsValue,
    ) -> Result<JsValue, JsValue> {
        let params: JsKdfParams = from_js(params)?;
        let boot = envelope::change_password(handle, &new_password, params.into()).map_err(err)?;
        to_js(&JsVaultBootstrap::from(boot))
    }

    #[wasm_bindgen(js_name = generatePassword)]
    pub fn generate_password(opts: JsValue) -> Result<String, JsValue> {
        let opts: JsPwGenOptions = from_js(opts)?;
        generate::generate_password(opts.into()).map_err(err)
    }

    #[wasm_bindgen(js_name = generatePassphrase)]
    pub fn generate_passphrase(words: u32, separator: String) -> Result<String, JsValue> {
        generate::generate_passphrase(words, &separator).map_err(err)
    }

    #[wasm_bindgen(js_name = totpAt)]
    pub fn totp_at(
        secret_b32: String,
        unix_seconds: f64,
        period: u32,
        digits: u32,
    ) -> Result<String, JsValue> {
        if !(0.0..=9.007e15).contains(&unix_seconds) {
            return Err(JsValue::from_str("unix_seconds out of range"));
        }
        totp::totp_at(&secret_b32, unix_seconds as u64, period, digits).map_err(err)
    }

    /// `totp_now`: contract NOTE says WASM has no trustworthy clock; the host
    /// should use `totpAt`. We still expose it, sourcing time from the host
    /// `Date.now()` via js_sys, for convenience.
    #[wasm_bindgen(js_name = totpNow)]
    pub fn totp_now(secret_b32: String, period: u32, digits: u32) -> Result<String, JsValue> {
        let now_ms = js_sys::Date::now();
        let secs = (now_ms / 1000.0) as u64;
        totp::totp_at(&secret_b32, secs, period, digits).map_err(err)
    }

    #[wasm_bindgen(js_name = hibpPrefix)]
    pub fn hibp_prefix(password: String) -> Result<JsValue, JsValue> {
        let r = hibp::hibp_prefix(&password);
        to_js(&JsHibpPrefix { prefix: r.prefix, suffix: r.suffix })
    }

    // ---- identity / DID layer (PRD-DID §5.9) -------------------------------
    //
    // The master seed + Ed25519 private key NEVER cross the FFI: the seed enters
    // once (base64) to mint a session and is zeroized; thereafter only the opaque
    // handle, the public did:key, and detached signatures cross the boundary.

    /// Mint a master-identity session from a base64 32-byte seed. Returns the
    /// opaque handle. The seed is used once and zeroized; never retained.
    #[wasm_bindgen(js_name = identityFromSeed)]
    pub fn identity_from_seed(seed_b64: String) -> Result<u32, JsValue> {
        identity::identity_from_seed_b64(&seed_b64).map_err(err)
    }

    /// The master `did:key` for a session (public material only).
    #[wasm_bindgen(js_name = masterDid)]
    pub fn master_did(handle: u32) -> Result<String, JsValue> {
        identity::master_did(handle).map_err(err)
    }

    /// Detached EdDSA signature (base64) over the UTF-8 `payload` (the canonical
    /// JCS binding document — PRD-DID §5.5).
    #[wasm_bindgen(js_name = signDetached)]
    pub fn sign_detached(handle: u32, payload: String) -> Result<String, JsValue> {
        identity::sign_detached(handle, payload.as_bytes()).map_err(err)
    }

    /// Verify a detached signature against a `did:key`. Pure — no handle needed.
    #[wasm_bindgen(js_name = verifyBinding)]
    pub fn verify_binding(
        did: String,
        payload: String,
        signature_b64: String,
    ) -> Result<bool, JsValue> {
        identity::verify_binding(&did, payload.as_bytes(), &signature_b64).map_err(err)
    }

    /// Zeroize + drop the identity session. Idempotent.
    #[wasm_bindgen(js_name = identityLock)]
    pub fn identity_lock(handle: u32) {
        identity::identity_lock(handle);
    }

    // ---- identity keystore (C1: envelope-wrapped seed) ---------------------
    //
    // The seed is generated/unwrapped INSIDE Rust and never crosses the FFI. The
    // wallet persists only the keystore (public did + KDF params/salt + wrapped
    // seed ciphertext) and holds the opaque handle.

    #[derive(Serialize)]
    struct JsIdentityCreated {
        did: String,
        kdf: JsKdfParams,
        salt_b64: String,
        wrapped_seed_b64: String,
        handle: u32,
    }

    #[derive(Serialize)]
    struct JsIdentityUnlocked {
        did: String,
        handle: u32,
    }

    /// Generate a fresh master identity, wrap its seed under `master_password`,
    /// mint a session, and return the persistable keystore + the handle.
    #[wasm_bindgen(js_name = identityCreate)]
    pub fn identity_create(master_password: String, params: JsValue) -> Result<JsValue, JsValue> {
        let params: JsKdfParams = from_js(params)?;
        let (ks, handle) = identity::identity_create(&master_password, params.into()).map_err(err)?;
        to_js(&JsIdentityCreated {
            did: ks.did,
            kdf: ks.kdf.into(),
            salt_b64: ks.salt_b64,
            wrapped_seed_b64: ks.wrapped_seed_b64,
            handle,
        })
    }

    /// Unwrap the seed from a stored keystore, mint a session, and return the
    /// public did:key + handle. Errors generically on a wrong master password.
    #[wasm_bindgen(js_name = identityUnlock)]
    pub fn identity_unlock(
        master_password: String,
        salt_b64: String,
        params: JsValue,
        wrapped_seed_b64: String,
    ) -> Result<JsValue, JsValue> {
        let params: JsKdfParams = from_js(params)?;
        let (did, handle) =
            identity::identity_unlock(&master_password, &salt_b64, params.into(), &wrapped_seed_b64)
                .map_err(err)?;
        to_js(&JsIdentityUnlocked { did, handle })
    }
}
