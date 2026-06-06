//! Native Solid-OIDC orchestration: deep-link callback + single-flight (HARD #3).
//!
//! ## Why this is different from the web shell
//!
//! The web shell's single-flight `handleIncomingRedirect` (AGENTS.md HARD #3,
//! `src/lib/solid/auth.ts`) relies on BROWSER redirect semantics. Native returns
//! the OIDC redirect to the app via a custom URL scheme / deep link
//! (`org.mindpods.shell://auth/callback?...` on desktop, an associated-domain universal
//! link on mobile) — handed to us by `tauri-plugin-deep-link`. The authorization
//! request itself opens in the SYSTEM browser / system auth session
//! (`ASWebAuthenticationSession` iOS, Custom Tabs Android), NEVER an embedded
//! webview, so (a) IdP-cookie SSO across siblings keeps working and (b) providers
//! don't reject the flow.
//!
//! The transport (discovery, registration, PKCE, DPoP, token exchange) lives in
//! [`crate::oidc`]; this module owns the app wiring + single-flight semantics.
//!
//! ## Single-flight (HARD #3)
//!
//! Exactly one in-flight authorization request at a time, in
//! `AppState::auth.pending`. The deep-link callback CONSUMES it (`take()`) before
//! the network exchange, so a duplicate / replayed callback finds no pending flow
//! and is dropped. The `state` parameter binds the callback to the request we
//! started (CSRF).
//!
//! ## Secrets / logging
//!
//! The DPoP private key + tokens live ONLY in this process (`AuthSession`); the
//! webview only ever receives the WebID. NEVER log tokens, keys, the auth code,
//! or the PKCE verifier (HARD rule #5). This module logs nothing.

use tauri::{Emitter, Listener, Manager};

use crate::oidc;
use crate::state::{AppState, AuthSession, PendingFlow};

/// Event emitted to the webview when the deep-link OIDC callback finishes
/// (§3.1). The payload is the MINIMAL non-secret signal `{ ok: bool }` — no
/// tokens, keys, or even the WebID ride the event (HARD rule #5). On `ok:true`
/// the frontend calls `auth_status` to read `{ signedIn, webId }`. Name is the
/// agreed JS↔Rust contract (frontend-dev's centralized EVENT const) — keep both
/// sides in sync.
pub const EVENT_AUTH_CALLBACK: &str = "auth-callback";

/// The custom URL scheme the IdP redirect comes back on. MUST be a reverse-DNS
/// scheme (RFC 8252 §7.1): Solid OPs (CSS/`oidc-provider`) reject single-label
/// native schemes at dynamic registration with `invalid_redirect_uri`
/// ("redirect_uris for native clients using Custom URI scheme should use reverse
/// domain name based scheme"). It matches the bundle identifier in
/// `tauri.conf.json` so the OS routes the scheme to this app.
const DEEP_LINK_SCHEME: &str = "org.mindpods.shell";

/// The redirect URI the IdP sends the user back to. Desktop uses the custom
/// scheme; mobile uses the associated-domain universal link configured in
/// `tauri.conf.json` (`deep-link.mobile`). Kept here as the single source.
const REDIRECT_URI: &str = "org.mindpods.shell://auth/callback";

/// Local auth errors. Messages are safe to surface to the webview (no secrets).
#[derive(Debug)]
pub enum AuthError {
    Config(String),
    Flow(&'static str),
    Browser(String),
    Oidc(oidc::OidcError),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Config(m) => write!(f, "auth config error: {m}"),
            AuthError::Flow(m) => write!(f, "auth flow error: {m}"),
            AuthError::Browser(m) => write!(f, "could not open system browser: {m}"),
            AuthError::Oidc(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for AuthError {}
impl From<oidc::OidcError> for AuthError {
    fn from(e: oidc::OidcError) -> Self {
        AuthError::Oidc(e)
    }
}

/// Shared HTTP client for the OIDC round-trips (rustls, no system OpenSSL).
fn http_client() -> Result<reqwest::Client, AuthError> {
    reqwest::Client::builder()
        .user_agent("mind-shell-native/0.1")
        .build()
        .map_err(|e| AuthError::Browser(e.to_string()))
}

/// Register the deep-link handler ONCE at startup. Every incoming
/// `org.mindpods.shell://auth/callback` URL is routed to `handle_callback`.
pub fn register_deep_link(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;

    // On desktop dev/release, register the runtime scheme handler so the OS hands
    // `org.mindpods.shell://` URLs to this running instance. (Production installs
    // also declare it in the bundle manifest via tauri.conf.json.)
    #[cfg(desktop)]
    {
        let _ = app.deep_link().register(DEEP_LINK_SCHEME);
    }

    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // Match on the full URL string, NOT `url.scheme()` + `url.path()`:
            // the `url` crate parses `<scheme>://auth/callback` with host="auth"
            // and path="/callback" (the `//` introduces an authority), so a
            // `path() == "/auth/callback"` guard never matches. Prefix-matching
            // the canonical redirect URI is robust to that split.
            if url.as_str().starts_with(REDIRECT_URI) {
                handle_callback(&handle, url.as_str());
            }
        }
    });

    // Belt-and-suspenders: some platforms deliver the cold-start URL as an event
    // rather than via `on_open_url`. `handle_callback` is single-flight (the
    // pending `take`), so double-delivery is harmless.
    let handle2 = app.handle().clone();
    app.listen("deep-link://new-url", move |event| {
        if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
            for url in urls {
                if url.starts_with(REDIRECT_URI) {
                    handle_callback(&handle2, &url);
                }
            }
        }
    });

    Ok(())
}

/// Start a native sign-in: discover the issuer, dynamically register a public
/// client, build PKCE + a per-flow DPoP key, record the single in-flight flow,
/// and open the SYSTEM browser at the authorization endpoint. Completion arrives
/// asynchronously via the deep-link callback.
pub async fn start(
    app: &tauri::AppHandle,
    state: &AppState,
    issuer: &str,
    client_id: Option<&str>,
) -> Result<(), AuthError> {
    if issuer.is_empty() {
        return Err(AuthError::Config("issuer is required".into()));
    }
    let http = http_client()?;

    // 1) OIDC discovery.
    let meta = oidc::discover(&http, issuer).await?;

    // 2) Client: use a caller-provided id, else dynamically register a public
    //    native client (PKCE, no secret) for our redirect URI.
    let client_id = match client_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => {
            let reg_ep = meta
                .registration_endpoint
                .as_deref()
                .ok_or(AuthError::Flow("issuer has no registration_endpoint"))?;
            oidc::register_client(&http, reg_ep, REDIRECT_URI).await?.client_id
        }
    };

    // 3) PKCE + per-flow DPoP key + CSRF state.
    let pkce = oidc::gen_pkce();
    let oidc_state = oidc::gen_random_token();
    let dpop = oidc::DpopKey::generate();

    // 4) Authorization URL (params from discovery).
    let auth_url = build_authorization_url(
        &meta.authorization_endpoint,
        &client_id,
        REDIRECT_URI,
        &oidc_state,
        &pkce.challenge,
    );

    // 5) Record the single in-flight flow BEFORE opening the browser, so the
    //    callback can never arrive without a matching pending entry (HARD #3).
    {
        let mut pending = state
            .auth
            .pending
            .lock()
            .map_err(|_| AuthError::Flow("pending lock poisoned"))?;
        *pending = Some(PendingFlow {
            state: oidc_state,
            pkce_verifier: pkce.verifier,
            meta,
            client_id,
            redirect_uri: REDIRECT_URI.to_string(),
            dpop,
        });
    }

    // 6) Open the SYSTEM browser (NOT an embedded webview) so the IdP session
    //    cookie is visible and SSO across siblings works (§3.1).
    open_system_browser(app, &auth_url)?;
    Ok(())
}

/// Handle one deep-link auth callback. SINGLE-FLIGHT (HARD #3): consume the
/// pending flow first; a second/replayed callback finds nothing and is dropped.
/// The token exchange is async, so we parse + validate synchronously (under the
/// lock) and spawn the network step onto the Tauri/tokio runtime.
fn handle_callback(app: &tauri::AppHandle, url: &str) {
    let state = app.state::<AppState>();

    // Consume (take) the pending flow up-front. After this, no other callback can
    // complete the same flow.
    let pending = match state.auth.pending.lock() {
        Ok(mut g) => g.take(),
        Err(_) => return,
    };
    let Some(pending) = pending else {
        // No in-flight flow → spurious/replayed callback. Drop silently.
        return;
    };

    // Parse the callback params.
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return,
    };
    let (mut code, mut got_state) = (None, None);
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            _ => {}
        }
    }

    // Bind the callback to the request we started (CSRF). On mismatch we have
    // already consumed `pending`, so the flow is permanently closed (HARD #3).
    if got_state.as_deref() != Some(pending.state.as_str()) {
        return;
    }
    let Some(code) = code else { return };

    // Async token exchange on the runtime. `pending` owns its DPoP key + meta, so
    // no shared state is needed for the network step.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if complete_flow(&app, pending, &code).await.is_err() {
            // Minimal non-secret failure signal; never log token/code/key detail.
            let _ = app.emit(EVENT_AUTH_CALLBACK, serde_json::json!({ "ok": false }));
        }
    });
}

/// Run the authorization-code exchange and publish the resolved session.
async fn complete_flow(
    app: &tauri::AppHandle,
    pending: PendingFlow,
    code: &str,
) -> Result<(), AuthError> {
    let http = http_client()?;
    let tokens = oidc::exchange_code(
        &http,
        &pending.meta,
        &pending.dpop,
        &pending.client_id,
        code,
        &pending.pkce_verifier,
        &pending.redirect_uri,
    )
    .await?;

    // WebID from the ID token's `webid` claim (Solid-OIDC).
    let web_id = tokens
        .id_token
        .as_deref()
        .and_then(oidc::webid_from_id_token)
        .ok_or(AuthError::Flow("no webid in id_token"))?;

    let state = app.state::<AppState>();

    // Store the session secrets (DPoP key + tokens) in-process. The WebID is
    // recorded for `auth_status` to read; it is NOT put on the event. The DPoP
    // key moves out of `pending` into the long-lived session so future pod
    // requests can sign DPoP proofs bound to the same access token.
    if let Ok(mut g) = state.auth.session.lock() {
        *g = Some(AuthSession {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            dpop: pending.dpop,
            web_id: web_id.clone(),
        });
    }
    if let Ok(mut g) = state.auth.web_id.lock() {
        *g = Some(web_id);
    }

    // Minimal non-secret success signal. The frontend calls `auth_status` to
    // read `{ signedIn, webId }` — no identity rides the event (HARD rule #5).
    let _ = app.emit(EVENT_AUTH_CALLBACK, serde_json::json!({ "ok": true }));
    Ok(())
}

/// Clear all native-auth secrets (tokens, DPoP key) held in the Rust process.
/// `web_id` / `pending` are cleared by the caller (`commands::auth_logout`).
pub fn logout(state: &AppState) {
    if let Ok(mut g) = state.auth.session.lock() {
        // Dropping `AuthSession` drops the `SigningKey` (zeroized by `p256` on
        // drop) and the token strings.
        *g = None;
    }
}

// ---- helpers ----------------------------------------------------------------

/// Open `url` in the system browser via the opener plugin (system auth session
/// on mobile). NEVER an in-app webview (§3.1).
fn open_system_browser(app: &tauri::AppHandle, url: &str) -> Result<(), AuthError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AuthError::Browser(e.to_string()))
}

/// Build the authorization-endpoint URL from the discovered endpoint. Solid-OIDC
/// scopes: `openid webid` (+ `offline_access` for a refresh token).
fn build_authorization_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    pkce_challenge: &str,
) -> String {
    let mut u = url::Url::parse(authorization_endpoint)
        .unwrap_or_else(|_| url::Url::parse("https://invalid.local/").unwrap());
    u.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "openid webid offline_access")
        .append_pair("state", state)
        .append_pair("code_challenge", pkce_challenge)
        .append_pair("code_challenge_method", "S256");
    u.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_url_has_pkce_and_required_params() {
        let url = build_authorization_url(
            "https://pods.mindpods.org/.oidc/auth",
            "client-123",
            REDIRECT_URI,
            "state-xyz",
            "challenge-abc",
        );
        let parsed = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["client_id"], "client-123");
        assert_eq!(q["redirect_uri"], REDIRECT_URI);
        assert_eq!(q["code_challenge"], "challenge-abc");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "state-xyz");
        assert!(q["scope"].contains("webid"));
        assert!(q["scope"].contains("offline_access"));
    }
}
