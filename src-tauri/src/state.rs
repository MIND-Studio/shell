//! App-managed state held in Tauri's managed state.
//!
//! The unlocked vault session is NOT here: `crypto-core`'s native layer owns it
//! in a process-global, thread-safe, mlock'd store (`crypto_core::native`), and
//! the webview only ever holds the opaque `u32` handle. So the only state this
//! app process keeps is the native-auth session (below) — the DPoP private key
//! and tokens live here in the Rust process, NEVER in the webview (HARD rule #1
//! by analogy: the webview only ever receives the WebID, never tokens/keys).

use std::sync::Mutex;

use crate::oidc::{DpopKey, ProviderMetadata};

/// Native auth state. The webview reads only `web_id` (via `auth_status`); the
/// DPoP key + tokens in `session` and the in-flight `pending` flow never cross
/// the command boundary.
#[derive(Default)]
pub struct AuthState {
    /// WebID once the OIDC flow completes; `None` until signed in.
    pub web_id: Mutex<Option<String>>,
    /// In-flight authorization request. Consumed (`take`) by the deep-link
    /// callback so each flow completes exactly once (single-flight, HARD #3).
    pub pending: Mutex<Option<PendingFlow>>,
    /// The established session's secrets (DPoP key + DPoP-bound tokens). Held in
    /// the Rust process only; used to sign DPoP proofs for pod requests later.
    pub session: Mutex<Option<AuthSession>>,
}

/// One in-flight authorization request — everything the deep-link callback needs
/// to finish the code exchange. Holds the per-flow DPoP key and the discovered
/// provider metadata so the callback does no further network round-trips before
/// the token call. Cleared (`take`) the instant the callback consumes it.
pub struct PendingFlow {
    /// CSRF `state` — the callback's `state` param must match this exactly.
    pub state: String,
    /// PKCE verifier (secret) — proves we started this flow at the token endpoint.
    pub pkce_verifier: String,
    /// Discovered endpoints for `pending.issuer`.
    pub meta: ProviderMetadata,
    /// The (dynamically registered) public client id used in this flow.
    pub client_id: String,
    /// Redirect URI this flow was started with (must echo at the token endpoint).
    pub redirect_uri: String,
    /// The per-flow DPoP keypair; carried into the session on success.
    pub dpop: DpopKey,
}

/// The secrets of an established session. NEVER serialized to the webview.
///
/// These fields are populated by the OIDC token exchange and consumed by the
/// next milestone — signing DPoP-bound pod requests (access_token + dpop) and
/// silent token refresh (refresh_token). They're stored + dropped on logout
/// today; `allow(dead_code)` until the pod-request path reads them.
#[allow(dead_code)]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// The DPoP key the access token is bound to; signs DPoP proofs for pod
    /// requests. Stays in this process for the session's lifetime.
    pub dpop: DpopKey,
    pub web_id: String,
}

/// Everything `#[tauri::command]`s reach for via `tauri::State<AppState>`.
#[derive(Default)]
pub struct AppState {
    pub auth: AuthState,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
