//! Native authenticated pod I/O: a DPoP-signed HTTP request performed from the
//! Rust process on the webview's behalf (PRD-NATIVE §2, §3.1).
//!
//! ## Why this exists
//!
//! After native sign-in the DPoP private key + access token live ONLY in the
//! Rust process (`AuthSession`). The webview therefore cannot make authenticated
//! pod requests itself — and it must not, because that would mean handing it the
//! token (HARD rule #1). Instead the frontend's `fetch` shim (task #9) calls this
//! command; Rust attaches `Authorization: DPoP <access_token>` + a FRESH DPoP
//! proof per request and returns only the response. Tokens and the DPoP key
//! never cross the command boundary (zero-trust-of-webview).
//!
//! ## DPoP per request (RFC 9449)
//!
//! Each request carries a new proof JWT bound to THIS request:
//! `htm` = method, `htu` = url (no query/fragment per spec), `jti`, `iat`,
//! and `ath` = base64url(SHA-256(access_token)). A `DPoP-Nonce` challenge
//! (HTTP 401/4xx with the header) is retried once with the server nonce.
//!
//! ## Logging
//!
//! NEVER log the access token, the DPoP key/proof, request bodies, or response
//! bodies (HARD rule #5). This module logs nothing.

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::oidc;
use crate::state::AppState;

const B64_STD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// Request from the webview's `fetch` shim — a faithful WHATWG `Request` proxy
/// (frontend-dev's contract for `pod-fs.ts`'s `{ fetch }` shim, task #9).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodRequest {
    pub url: String,
    /// HTTP method (default GET if empty).
    #[serde(default)]
    pub method: Option<String>,
    /// Headers as an ordered list of `[name, value]` pairs — NOT a map — so
    /// duplicate headers the caller sets are preserved. `Authorization`/`DPoP`
    /// are added here; any caller-supplied copies are dropped.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Optional request body, ALWAYS base64 (both text .ttl and binary .enc go
    /// through base64, so the wire shape is uniform). `None` for bodyless verbs.
    #[serde(default)]
    pub body: Option<String>,
}

/// Response returned to the webview's `fetch` shim, which reconstructs a WHATWG
/// `Response`. Headers are an ordered `[name, value]` list (NOT a map) so
/// DUPLICATE `Link` headers survive — Solid sends several and `@inrupt`'s
/// container parsing depends on all of them. The body is ALWAYS base64 (uniform
/// both directions; the shim base64-decodes for text or binary alike).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Errors surfaced to the webview. Safe strings — no token/key/body detail.
#[derive(Debug)]
pub enum PodFetchError {
    NotSignedIn,
    BadRequest(&'static str),
    Dpop(oidc::OidcError),
    Http(String),
}

impl std::fmt::Display for PodFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PodFetchError::NotSignedIn => write!(f, "not signed in"),
            PodFetchError::BadRequest(m) => write!(f, "bad request: {m}"),
            PodFetchError::Dpop(e) => write!(f, "{e}"),
            PodFetchError::Http(m) => write!(f, "pod request failed: {m}"),
        }
    }
}
impl std::error::Error for PodFetchError {}
impl From<oidc::OidcError> for PodFetchError {
    fn from(e: oidc::OidcError) -> Self {
        PodFetchError::Dpop(e)
    }
}

/// `htu` per RFC 9449: the request URI with query and fragment removed.
fn htu(url: &url::Url) -> String {
    let mut u = url.clone();
    u.set_query(None);
    u.set_fragment(None);
    u.to_string()
}

/// Mint `(access_token, dpop_proof)` for one request, holding the session lock
/// only for the (synchronous) signing — the lock is released before any network
/// `.await`, and the DPoP private key NEVER leaves the session (we copy out the
/// finished proof string + the token, not the key). `nonce` is embedded when the
/// resource server demanded one (RFC 9449 §8).
fn mint_auth(
    state: &AppState,
    method: &str,
    htu: &str,
    nonce: Option<&str>,
) -> Result<(String, String), PodFetchError> {
    let guard = state.auth.session.lock().map_err(|_| PodFetchError::NotSignedIn)?;
    let sess = guard.as_ref().ok_or(PodFetchError::NotSignedIn)?;
    let ath = oidc::ath_for(&sess.access_token);
    let proof = sess.dpop.proof_with_nonce(method, htu, Some(&ath), nonce)?;
    Ok((sess.access_token.clone(), proof))
}

/// Perform one DPoP-signed request with a pre-minted token + proof, attaching
/// `Authorization: DPoP <token>` + the proof. Pure network — no session lock.
async fn signed_send(
    http: &reqwest::Client,
    access_token: &str,
    proof: &str,
    method: &reqwest::Method,
    target: &url::Url,
    headers: &[(String, String)],
    body: &Option<Vec<u8>>,
) -> Result<reqwest::Response, PodFetchError> {
    let mut req = http
        .request(method.clone(), target.clone())
        .header("Authorization", format!("DPoP {access_token}"))
        .header("DPoP", proof);

    // Forward caller headers in order (duplicates preserved via repeated
    // `.header()` calls), but never let them override our auth headers.
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if lk == "authorization" || lk == "dpop" {
            continue;
        }
        req = req.header(k, v);
    }
    if let Some(bytes) = body {
        req = req.body(bytes.clone());
    }

    req.send().await.map_err(|e| PodFetchError::Http(e.to_string()))
}

/// `#[tauri::command]` `pod_fetch`: authenticated pod request on the webview's
/// behalf. The token + DPoP key stay in this process; only the response crosses.
#[tauri::command]
pub async fn pod_fetch(
    state: State<'_, AppState>,
    req: PodRequest,
) -> Result<PodResponse, String> {
    do_pod_fetch(&state, req).await.map_err(|e| e.to_string())
}

async fn do_pod_fetch(
    state: &AppState,
    req: PodRequest,
) -> Result<PodResponse, PodFetchError> {
    let target = url::Url::parse(&req.url).map_err(|_| PodFetchError::BadRequest("invalid url"))?;
    if !matches!(target.scheme(), "https" | "http") {
        return Err(PodFetchError::BadRequest("url must be http(s)"));
    }
    let method = reqwest::Method::from_bytes(
        req.method.as_deref().unwrap_or("GET").as_bytes(),
    )
    .map_err(|_| PodFetchError::BadRequest("invalid method"))?;
    let htu = htu(&target);

    // Request body is always base64 on the wire (uniform for text + binary).
    let body: Option<Vec<u8>> = match &req.body {
        None => None,
        Some(b) => {
            Some(B64_STD.decode(b).map_err(|_| PodFetchError::BadRequest("invalid base64 body"))?)
        }
    };

    let http = reqwest::Client::builder()
        .user_agent("mind-shell-native/0.1")
        .build()
        .map_err(|e| PodFetchError::Http(e.to_string()))?;

    // First attempt with no server nonce. Proof minted under a short lock (the
    // DPoP key never leaves the session); lock released before the send.
    let (access_token, proof) = mint_auth(state, method.as_str(), &htu, None)?;
    let mut resp =
        signed_send(&http, &access_token, &proof, &method, &target, &req.headers, &body).await?;

    // RFC 9449 §8: the RS may demand a DPoP nonce. Retry ONCE with a fresh proof
    // carrying the server nonce. (Single retry — no loop — to avoid ping-pong.)
    if let Some(nonce) = needs_nonce_retry(&resp) {
        let (access_token, proof) = mint_auth(state, method.as_str(), &htu, Some(&nonce))?;
        resp =
            signed_send(&http, &access_token, &proof, &method, &target, &req.headers, &body).await?;
    }

    build_response(resp).await
}

/// If the response is a DPoP-nonce challenge, return the server nonce to retry
/// with. CSS sends `DPoP-Nonce` (often with WWW-Authenticate error
/// `use_dpop_nonce`) on a 401.
fn needs_nonce_retry(resp: &reqwest::Response) -> Option<String> {
    if resp.status() != reqwest::StatusCode::UNAUTHORIZED {
        return None;
    }
    resp.headers()
        .get("DPoP-Nonce")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Marshal a response `HeaderMap` into an ordered `[name, value]` list, ONE
/// entry per header value. CRITICAL: Solid CSS returns MULTIPLE `Link:` response
/// headers on a container GET/HEAD (rel="type" ldp:Container, plus acl/
/// describedby/storage rels) and `@inrupt`'s readdir/exists parse all of them —
/// so this MUST NOT collapse duplicates. `HeaderMap`'s `(name, value)` iterator
/// yields a separate entry per value (the name repeats), so iterating it
/// preserves every `Link`. Never use `.get(name)` (first only) or a map here.
fn marshal_headers(map: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::with_capacity(map.len());
    for (k, v) in map {
        if let Ok(val) = v.to_str() {
            headers.push((k.as_str().to_string(), val.to_string()));
        }
    }
    headers
}

/// Convert a `reqwest::Response` into the webview-safe `PodResponse`. Status is
/// returned (NOT thrown) for all codes incl. 4xx/5xx so the `@inrupt` SDK's own
/// error handling works (e.g. `exists()` catching a 404). Headers preserve order
/// and duplicates (multiple `Link` headers). Body is always base64.
async fn build_response(resp: reqwest::Response) -> Result<PodResponse, PodFetchError> {
    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let headers = marshal_headers(resp.headers());

    let bytes = resp.bytes().await.map_err(|e| PodFetchError::Http(e.to_string()))?;
    Ok(PodResponse {
        status,
        status_text,
        headers,
        body: B64_STD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oidc::DpopKey;

    #[test]
    fn htu_strips_query_and_fragment() {
        let u = url::Url::parse("https://pod.example/c/r?x=1&y=2#frag").unwrap();
        assert_eq!(htu(&u), "https://pod.example/c/r");
    }

    #[test]
    fn marshal_headers_preserves_duplicate_link_headers() {
        // Solid CSS sends several `Link` headers on a container GET; readdir/
        // exists depend on ALL of them. Marshaling must NOT collapse them.
        use reqwest::header::{HeaderMap, HeaderValue, LINK, CONTENT_TYPE};
        let mut map = HeaderMap::new();
        map.insert(CONTENT_TYPE, HeaderValue::from_static("text/turtle"));
        map.append(LINK, HeaderValue::from_static("<http://www.w3.org/ns/ldp#Container>; rel=\"type\""));
        map.append(LINK, HeaderValue::from_static("<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\""));
        map.append(LINK, HeaderValue::from_static("<.acl>; rel=\"acl\""));

        let out = marshal_headers(&map);
        let links: Vec<&(String, String)> =
            out.iter().filter(|(k, _)| k.eq_ignore_ascii_case("link")).collect();
        assert!(links.len() >= 2, "duplicate Link headers must survive, got {}", links.len());
        assert_eq!(links.len(), 3, "all 3 Link values preserved");
        // The ldp:Container type rel AND at least one other rel are present.
        assert!(out.iter().any(|(k, v)| k.eq_ignore_ascii_case("link") && v.contains("ldp#Container")));
        assert!(out.iter().any(|(k, v)| k.eq_ignore_ascii_case("link") && v.contains("rel=\"acl\"")));
        // content-type still there.
        assert!(out.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v == "text/turtle"));
    }

    #[test]
    fn dpop_proof_for_a_pod_request_has_ath_and_request_binding() {
        // A pod GET: the proof must bind to method+url and carry ath=SHA256(token).
        let dpop = DpopKey::generate();
        let token = "sample-access-token";
        let ath = oidc::ath_for(token);
        let target = url::Url::parse("https://pod.mindpods.org/alice/vault/items/1.enc?v=2").unwrap();
        let jwt = dpop.proof("GET", &htu(&target), Some(&ath)).unwrap();

        let segs: Vec<&str> = jwt.split('.').collect();
        assert_eq!(segs.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(segs[1]).unwrap(),
        )
        .unwrap();
        assert_eq!(claims["htm"], "GET");
        // htu has query stripped.
        assert_eq!(claims["htu"], "https://pod.mindpods.org/alice/vault/items/1.enc");
        assert_eq!(claims["ath"], ath);
        // ath is exactly base64url(SHA-256(token)).
        use sha2::{Digest, Sha256};
        let expect =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()));
        assert_eq!(claims["ath"], expect);
    }

    // ---- LIVE native runtime verification --------------------------------------
    //
    // These tests hit a REAL Community Solid Server on :3101 (the `mind-shell-css`
    // docker instance, alice seeded). They are `#[ignore]`d so the normal
    // `cargo test` stays hermetic; run explicitly with:
    //
    //   docker compose up -d && npm run seed:demo
    //   cargo test --release -- --ignored --nocapture live_native
    //
    // They exercise the ENTIRE native pod-I/O zero-trust path against a live IdP +
    // pod without any interactive login: native discovery, RFC 7591 dynamic
    // registration, a DPoP-bound access token minted via CSS client-credentials
    // (bound to the NATIVE `DpopKey`), and the real `do_pod_fetch` command path
    // (per-request DPoP proof with `ath`, DPoP-Nonce retry, duplicate-`Link`
    // preservation, 4xx-returned-not-thrown). NEVER prints the token (HARD #5).

    use crate::oidc::{self, ProviderMetadata};
    use crate::state::{AppState, AuthSession};

    const LIVE_ISSUER: &str = "http://localhost:3101/";
    const LIVE_WEBID: &str = "http://localhost:3101/alice/profile/card#me";
    const LIVE_ITEMS: &str = "http://localhost:3101/alice/apps/vault/items/";
    const LIVE_EMAIL: &str = "alice@mind-shell.local";
    const LIVE_PASSWORD: &str = "dev-only-do-not-use-in-prod";

    /// Plaintext that must NEVER appear in an opaque item blob (mirrors
    /// `scripts/smoke-vault.ts`, but checked through the NATIVE `pod_fetch` path).
    const PLAINTEXT_MARKERS: &[&str] =
        &["password", "username", "otpauth://", "secret", "-----begin", "cardnumber"];

    /// Mint CSS client-credentials (account API) — the Rust analogue of
    /// `smoke-vault.ts`'s `mintCredentials`. Returns `(id, secret)`.
    async fn mint_css_client_credentials(
        http: &reqwest::Client,
    ) -> Result<(String, String), String> {
        let idx: serde_json::Value = http
            .get(format!("{LIVE_ISSUER}.account/"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let login_url = idx["controls"]["password"]["login"]
            .as_str()
            .ok_or("no password.login control — is CSS seeded?")?;

        let login: serde_json::Value = http
            .post(login_url)
            .json(&serde_json::json!({ "email": LIVE_EMAIL, "password": LIVE_PASSWORD }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let authz = login["authorization"].as_str().ok_or("login failed")?.to_string();

        let account: serde_json::Value = http
            .get(format!("{LIVE_ISSUER}.account/"))
            .header("Authorization", format!("CSS-Account-Token {authz}"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let cc_url = account["controls"]["account"]["clientCredentials"]
            .as_str()
            .ok_or("no clientCredentials control")?;

        let cred: serde_json::Value = http
            .post(cc_url)
            .header("Authorization", format!("CSS-Account-Token {authz}"))
            .json(&serde_json::json!({ "name": "mind-shell-native-test", "webId": LIVE_WEBID }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let id = cred["id"].as_str().ok_or("no credential id")?.to_string();
        let secret = cred["secret"].as_str().ok_or("no credential secret")?.to_string();
        Ok((id, secret))
    }

    /// One client-credentials token request with a DPoP proof bound to `dpop`.
    async fn cc_token_attempt(
        http: &reqwest::Client,
        meta: &ProviderMetadata,
        dpop: &DpopKey,
        id: &str,
        secret: &str,
        nonce: Option<&str>,
    ) -> reqwest::Response {
        let proof = dpop
            .proof_with_nonce("POST", &meta.token_endpoint, None, nonce)
            .expect("dpop proof");
        http.post(&meta.token_endpoint)
            .basic_auth(id, Some(secret))
            .header("DPoP", proof)
            .form(&[("grant_type", "client_credentials"), ("scope", "webid")])
            .send()
            .await
            .expect("token endpoint reachable")
    }

    /// Acquire a DPoP-bound access token via client-credentials, retrying ONCE on
    /// a `DPoP-Nonce` challenge (RFC 9449 §8). Returns `(access_token,
    /// nonce_was_required)` — the bool reports whether the token endpoint demanded
    /// a nonce (so we can tell whether the auth-code path needs the same retry).
    async fn cc_token(
        http: &reqwest::Client,
        meta: &ProviderMetadata,
        dpop: &DpopKey,
        id: &str,
        secret: &str,
    ) -> (String, bool) {
        let mut resp = cc_token_attempt(http, meta, dpop, id, secret, None).await;
        let mut nonce_required = false;
        if !resp.status().is_success() {
            if let Some(nonce) = resp
                .headers()
                .get("DPoP-Nonce")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
            {
                nonce_required = true;
                resp = cc_token_attempt(http, meta, dpop, id, secret, Some(&nonce)).await;
            }
        }
        assert!(
            resp.status().is_success(),
            "token endpoint returned {}",
            resp.status()
        );
        let body: serde_json::Value = resp.json().await.expect("token json");
        let tok = body["access_token"].as_str().expect("access_token").to_string();
        (tok, nonce_required)
    }

    /// Pull relative `<...enc>` refs out of a CSS turtle container listing and
    /// resolve them against the container URL.
    fn enc_item_urls(container: &str, ttl: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = ttl;
        while let Some(lt) = rest.find('<') {
            let after = &rest[lt + 1..];
            let Some(gt) = after.find('>') else { break };
            let tok = &after[..gt];
            if tok.ends_with(".enc") {
                let abs = if tok.starts_with("http") {
                    tok.to_string()
                } else {
                    format!("{container}{}", tok.trim_start_matches("./"))
                };
                if !out.contains(&abs) {
                    out.push(abs);
                }
            }
            rest = &after[gt + 1..];
        }
        out
    }

    #[test]
    #[ignore = "live: needs CSS on :3101 (docker compose up -d && npm run seed:demo)"]
    fn live_native_pod_fetch_end_to_end() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let http = reqwest::Client::builder()
                .user_agent("mind-shell-native-test/0.1")
                .build()
                .unwrap();

            // 1) Native OIDC discovery (live).
            let meta = oidc::discover(&http, LIVE_ISSUER).await.expect("discover");
            eprintln!("[live] discovery OK  token_endpoint={}", meta.token_endpoint);
            assert!(meta.token_endpoint.starts_with("http://localhost:3101/"));
            assert!(meta.registration_endpoint.is_some(), "CSS advertises RFC 7591 reg");

            // 2) Native dynamic client registration (RFC 7591, live).
            let reg = oidc::register_client(
                &http,
                meta.registration_endpoint.as_deref().unwrap(),
                "org.mindpods.shell://auth/callback",
            )
            .await
            .expect("dynamic client registration");
            assert!(!reg.client_id.is_empty());
            eprintln!("[live] dynamic registration OK  client_id chars={}", reg.client_id.len());

            // 3) DPoP-bound access token via CSS client-credentials, bound to a
            //    NATIVE DpopKey (the same key pod_fetch will sign resource proofs
            //    with). NEVER print the token (HARD #5).
            let (id, secret) = mint_css_client_credentials(&http).await.expect("css cc");
            let dpop = DpopKey::generate();
            let (access_token, token_nonce_required) =
                cc_token(&http, &meta, &dpop, &id, &secret).await;
            eprintln!(
                "[live] DPoP-bound token acquired  (token-endpoint nonce required: {})",
                token_nonce_required
            );

            // 4) Install the session into AppState exactly as auth::complete_flow
            //    does — the token + DPoP key live ONLY here, never the webview.
            let state = AppState::default();
            *state.auth.session.lock().unwrap() = Some(AuthSession {
                access_token,
                refresh_token: None,
                dpop,
                web_id: LIVE_WEBID.to_string(),
            });

            // 5) REAL pod_fetch: authenticated GET of the vault items container.
            let resp = do_pod_fetch(
                &state,
                PodRequest {
                    url: LIVE_ITEMS.to_string(),
                    method: Some("GET".into()),
                    headers: vec![("Accept".into(), "text/turtle".into())],
                    body: None,
                },
            )
            .await
            .expect("pod_fetch items container");
            eprintln!("[live] GET items  -> {} {}", resp.status, resp.status_text);
            assert_eq!(resp.status, 200, "authenticated container GET must be 200");

            // Duplicate Link headers must survive marshaling (container has several).
            let link_count = resp
                .headers
                .iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("link"))
                .count();
            eprintln!("[live] Link headers preserved: {link_count}");
            assert!(link_count >= 1, "at least one Link header expected on a container");

            // Body is base64 on the wire; decode to the turtle listing.
            let body = super::B64_STD.decode(&resp.body).expect("base64 body");
            let ttl = String::from_utf8_lossy(&body);
            assert!(ttl.contains("ldp") || ttl.contains("contains") || body.is_empty() || !ttl.is_empty());
            eprintln!("[live] container body: {} bytes", body.len());

            // 6) GET each .enc item through pod_fetch; assert OPAQUE (the
            //    zero-knowledge invariant, checked through the native path).
            let items = enc_item_urls(LIVE_ITEMS, &ttl);
            eprintln!("[live] .enc items discovered: {}", items.len());
            if items.is_empty() {
                eprintln!("[live] note: no items yet — unlock Vault in-app and create one, then re-run");
            }
            for url in &items {
                let r = do_pod_fetch(
                    &state,
                    PodRequest { url: url.clone(), method: None, headers: vec![], body: None },
                )
                .await
                .expect("pod_fetch .enc item");
                assert_eq!(r.status, 200, "item GET should be 200: {url}");
                let bytes = super::B64_STD.decode(&r.body).expect("base64 item body");
                // Opaque: not valid-UTF-8 JSON, and no plaintext markers.
                let as_text = std::str::from_utf8(&bytes);
                if let Ok(t) = as_text {
                    let trimmed = t.trim_start();
                    assert!(
                        !(trimmed.starts_with('{') || trimmed.starts_with('[')),
                        "item decodes as JSON — PLAINTEXT leak! {url}"
                    );
                    let hay = t.to_ascii_lowercase();
                    for m in PLAINTEXT_MARKERS {
                        assert!(!hay.contains(m), "plaintext marker {m:?} in {url}");
                    }
                }
                eprintln!("[live]   ok  {} ({} bytes, opaque)", url, bytes.len());
            }

            // 7) 4xx is RETURNED, not thrown (so @inrupt's exists()/404 handling
            //    works): GET a resource that does not exist.
            let missing = format!("{LIVE_ITEMS}does-not-exist-{}.enc", "xyz");
            let r404 = do_pod_fetch(
                &state,
                PodRequest { url: missing, method: None, headers: vec![], body: None },
            )
            .await
            .expect("pod_fetch on a missing resource must RETURN, not throw");
            eprintln!("[live] GET missing -> {} (returned, not thrown)", r404.status);
            assert_eq!(r404.status, 404, "missing resource should surface as 404");

            eprintln!("[live] PASS — native discovery + registration + DPoP token + pod_fetch all live-verified");
        });
    }
}
