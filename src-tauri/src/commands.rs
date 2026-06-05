//! `#[tauri::command]` wrappers over `crypto-core`'s NATIVE API + native auth.
//!
//! These are the ENTIRE surface the webview can invoke. They delegate to
//! `crypto_core::native::*` — the analogue of the WASM FFI, built on the same
//! store-free primitives, so the crypto logic exists exactly once and mirrors
//! `crypto-core/CONTRACT.md` one-to-one.
//!
//! ZERO-KNOWLEDGE INVARIANT (AGENTS.md HARD rule #1): the unlocked vault session
//! lives ONLY in the Rust process — `crypto-core`'s native store pins the data
//! key into RAM (`mlock`) and hands back an opaque `u32` handle. No command here
//! returns a raw key or plaintext secret — only ciphertext, wrapped keys, KDF
//! params, salts, or short-lived display values (a generated password, a TOTP
//! code, or a decrypted item the user explicitly asked to view).
//!
//! NEVER log secrets, master passwords, derived keys, or decrypted bodies
//! (HARD rule #5). These wrappers log nothing.

use serde::{Deserialize, Serialize};
use tauri::State;

use crypto_core::native;
use crypto_core::{CoreError, KdfParams, PwGenOptions, SealedItem, VaultBootstrap};

use crate::auth;
use crate::state::AppState;

/// The opaque session handle the webview holds. Meaningless outside this
/// process: it indexes the mlock'd, thread-safe unlocked-session store that
/// `crypto-core`'s native layer owns.
pub type Handle = u32;

/// Map a `CoreError` to a webview-safe string. `CoreError` is written to be
/// generic — no secret material, no which-step-failed leak (`error.rs`).
fn to_msg(e: CoreError) -> String {
    e.to_string()
}

// ---- serde shapes the webview passes/receives ------------------------------

/// `KdfParams` already (de)serializes as the contract's `m_kib`/`t`/`p`.
pub type WireKdfParams = KdfParams;

/// `PwGenOptions` is not `Serialize`/`Deserialize` in the core, so mirror it
/// here with the contract's `avoidAmbiguous` camelCase field.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePwGenOptions {
    pub length: u32,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}
impl From<WirePwGenOptions> for PwGenOptions {
    fn from(v: WirePwGenOptions) -> Self {
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
pub struct WireHibpPrefix {
    pub prefix: String,
    pub suffix: String,
}

// ---- Vault crypto surface (CONTRACT.md) -------------------------------------
//
// crypto-core's native store is process-global + thread-safe (Mutex), so these
// commands can run on any of Tauri's async worker threads — no executor needed.

#[tauri::command]
pub fn calibrate_kdf(target_ms: f64) -> Result<WireKdfParams, String> {
    native::calibrate_kdf(target_ms).map_err(to_msg)
}

#[tauri::command]
pub fn create_vault(
    master_password: String,
    params: WireKdfParams,
) -> Result<VaultBootstrap, String> {
    native::create_vault(&master_password, params).map_err(to_msg)
}

/// Returns the opaque session handle. The unlocked keys stay pinned in the
/// native store; this number is all the webview ever sees.
#[tauri::command]
pub fn unlock(
    master_password: String,
    salt_b64: String,
    params: WireKdfParams,
    wrapped_data_key_b64: String,
) -> Result<Handle, String> {
    native::unlock(&master_password, &salt_b64, params, &wrapped_data_key_b64).map_err(to_msg)
}

#[tauri::command]
pub fn lock(handle: Handle) {
    native::lock(handle);
}

#[tauri::command]
pub fn encrypt_item(
    handle: Handle,
    item_id: String,
    version: u32,
    plaintext_json: String,
) -> Result<SealedItem, String> {
    native::encrypt_item(handle, &item_id, version, &plaintext_json).map_err(to_msg)
}

/// Returns the decrypted item JSON — a short-lived display value the user asked
/// to view. This is the ONLY plaintext that ever crosses the boundary, exactly
/// as the contract permits (it is the user's own secret, shown on demand).
#[tauri::command]
pub fn decrypt_item(
    handle: Handle,
    item_id: String,
    version: u32,
    sealed: SealedItem,
) -> Result<String, String> {
    native::decrypt_item(handle, &item_id, version, &sealed).map_err(to_msg)
}

#[tauri::command]
pub fn change_password(
    handle: Handle,
    new_password: String,
    params: WireKdfParams,
) -> Result<VaultBootstrap, String> {
    native::change_password(handle, &new_password, params).map_err(to_msg)
}

#[tauri::command]
pub fn generate_password(opts: WirePwGenOptions) -> Result<String, String> {
    native::generate_password(opts.into()).map_err(to_msg)
}

#[tauri::command]
pub fn generate_passphrase(words: u32, separator: String) -> Result<String, String> {
    native::generate_passphrase(words, &separator).map_err(to_msg)
}

#[tauri::command]
pub fn totp_at(
    secret_b32: String,
    unix_seconds: f64,
    period: u32,
    digits: u32,
) -> Result<String, String> {
    if !(0.0..=9.007e15).contains(&unix_seconds) {
        return Err("unix_seconds out of range".into());
    }
    native::totp_at(&secret_b32, unix_seconds as u64, period, digits).map_err(to_msg)
}

#[tauri::command]
pub fn hibp_prefix(password: String) -> WireHibpPrefix {
    let r = native::hibp_prefix(&password);
    WireHibpPrefix { prefix: r.prefix, suffix: r.suffix }
}

/// Non-secret hardening telemetry: whether the unlocked-key region for `handle`
/// is actually pinned into RAM (`true`) or the OS refused mlock (`false`).
/// Returns `None` for an unknown/locked handle. Touches no key bytes (HARD #1).
#[tauri::command]
pub fn vault_lock_state(handle: Handle) -> Option<bool> {
    use crypto_core::memlock::LockState;
    native::lock_state(handle).map(|s| matches!(s, LockState::Locked))
}

// ---- Native auth (OIDC PKCE + DPoP + deep-link callback) --------------------

/// Begin a native OIDC sign-in: build PKCE + DPoP, open the SYSTEM browser at
/// the authorization endpoint, and stash the pending flow (single-flight). The
/// redirect returns via the `org.mindpods.shell://auth/callback` deep link, handled once
/// in `auth::handle_callback`.
#[tauri::command]
pub async fn auth_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    issuer: String,
    client_id: Option<String>,
) -> Result<(), String> {
    auth::start(&app, &state, &issuer, client_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub signed_in: bool,
    pub web_id: Option<String>,
}

#[tauri::command]
pub fn auth_status(state: State<AppState>) -> AuthStatus {
    let web_id = state.auth.web_id.lock().ok().and_then(|g| g.clone());
    AuthStatus { signed_in: web_id.is_some(), web_id }
}

#[tauri::command]
pub fn auth_logout(state: State<AppState>) -> Result<(), String> {
    if let Ok(mut g) = state.auth.web_id.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.auth.pending.lock() {
        *g = None;
    }
    auth::logout(&state);
    Ok(())
}
