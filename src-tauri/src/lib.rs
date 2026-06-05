//! mind-shell native (Tauri) entrypoint.
//!
//! Tauri shape (PRD-NATIVE §2, §5): the existing Next.js shell is the webview
//! frontend; `crypto-core` is wired as a NATIVE path dependency (rlib), not
//! WASM, and surfaced to the webview via `#[tauri::command]` wrappers in
//! [`commands`]. The audited crate is unchanged — one core, two bindings.
//!
//! ZERO-KNOWLEDGE INVARIANT (AGENTS.md HARD rule #1, mirrored from
//! `crypto-core/CONTRACT.md`): the unlocked vault session lives ONLY in this
//! Rust process, in Tauri-managed state behind an opaque numeric handle. No
//! command returns raw keys or plaintext to the webview — only ciphertext,
//! wrapped keys, KDF params, salts, or short-lived display values.

mod auth;
mod commands;
mod oidc;
mod pod_fetch;
mod state;

use state::AppState;

/// Build and run the Tauri application. Shared by the desktop `main.rs` and the
/// mobile (iOS/Android) harnesses, hence `#[cfg_attr(mobile, ...)]`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Deep-link: delivers the `org.mindpods.shell://auth/callback?...` (desktop) /
        // universal-link (mobile) OIDC redirect back into the app. The handler
        // is registered in `auth::register_deep_link` so the callback is
        // processed exactly once (single-flight, HARD rule #3).
        .plugin(tauri_plugin_deep_link::init())
        // Opens the SYSTEM browser / system auth session for the OIDC flow.
        // Never an embedded webview (PRD-NATIVE §3.1).
        .plugin(tauri_plugin_opener::init())
        // The unlocked-session store + auth state. Opaque to the webview.
        .manage(AppState::new())
        .setup(|app| {
            auth::register_deep_link(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // --- Vault crypto surface (CONTRACT.md) ---
            commands::calibrate_kdf,
            commands::create_vault,
            commands::unlock,
            commands::lock,
            commands::encrypt_item,
            commands::decrypt_item,
            commands::change_password,
            commands::generate_password,
            commands::generate_passphrase,
            commands::totp_at,
            commands::hibp_prefix,
            commands::vault_lock_state,
            // --- Native auth (OIDC PKCE + DPoP + deep-link) ---
            commands::auth_start,
            commands::auth_status,
            commands::auth_logout,
            // --- Authenticated pod I/O (DPoP-signed, from the Rust process) ---
            pod_fetch::pod_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mind-shell");
}
