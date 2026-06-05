//! Native Solid-OIDC transport: discovery, dynamic client registration, PKCE,
//! DPoP, and the authorization-code token exchange (PRD-NATIVE §3.1, N0 spike).
//!
//! ## §8 Q1 decision — thin native PKCE/DPoP client (not `solid-client-authn-node`)
//!
//! We implement a focused native client here rather than adapting
//! `@inrupt/solid-client-authn-node`, because:
//!   1. That library is **JavaScript** — wrong runtime for the process that must
//!      hold the DPoP private key. Shipping a Node runtime inside the Tauri app
//!      to run it would be a large, awkward dependency.
//!   2. Its flow assumes an HTTP-server redirect URI; our callback is a **custom
//!      URL scheme / universal link** delivered by the deep-link plugin — exactly
//!      the path that library does not support (PRD-NATIVE §3.1).
//!   3. The DPoP key + tokens stay **in the Rust process**, never the webview —
//!      the same custody posture as the vault keys (HARD rule #1, by analogy).
//! Solid-OIDC is plain OIDC + PKCE + DPoP over standard discovery, so a small
//! Rust client is both simpler and more secure than embedding a JS runtime.
//!
//! ## Crypto policy
//!
//! All auth-transport crypto uses **vetted RustCrypto crates** (`p256`/`ecdsa`,
//! `sha2`, `rand` OsRng, `base64`) **in this layer only** — never hand-rolled,
//! and never inside the vault `crypto-core` (its audit surface stays vault-only).
//! None of this touches vault key material.
//!
//! ## Logging
//!
//! NEVER log tokens, the DPoP private key, the authorization code, or the PKCE
//! verifier (HARD rule #5). This module logs nothing.

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// base64url, no padding — used for PKCE, JWT segments, and the JWK thumbprint.
const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Transport-level auth errors. Messages are safe to surface (no secrets).
#[derive(Debug)]
pub enum OidcError {
    Discovery(String),
    Registration(String),
    Token(String),
    Http(String),
    Jwt(&'static str),
}

impl std::fmt::Display for OidcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OidcError::Discovery(m) => write!(f, "oidc discovery failed: {m}"),
            OidcError::Registration(m) => write!(f, "oidc client registration failed: {m}"),
            OidcError::Token(m) => write!(f, "oidc token exchange failed: {m}"),
            OidcError::Http(m) => write!(f, "oidc http error: {m}"),
            OidcError::Jwt(m) => write!(f, "jwt error: {m}"),
        }
    }
}
impl std::error::Error for OidcError {}

// ---- discovery --------------------------------------------------------------

/// The subset of the OIDC discovery document we use. `issuer` is retained for
/// the ID-token issuer-match check (a verification hardening follow-up);
/// `allow(dead_code)` until that lands.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ProviderMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    /// Dynamic client registration endpoint (`/.oidc/reg` on CSS).
    #[serde(default)]
    pub registration_endpoint: Option<String>,
}

/// Fetch `<issuer>/.well-known/openid-configuration`.
pub async fn discover(
    http: &reqwest::Client,
    issuer: &str,
) -> Result<ProviderMetadata, OidcError> {
    let base = issuer.trim_end_matches('/');
    let url = format!("{base}/.well-known/openid-configuration");
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| OidcError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(OidcError::Discovery(format!("status {}", resp.status())));
    }
    resp.json::<ProviderMetadata>()
        .await
        .map_err(|e| OidcError::Discovery(e.to_string()))
}

// ---- dynamic client registration -------------------------------------------

/// `client_secret` is part of the RFC 7591 response shape but unused for our
/// public PKCE client (token endpoint auth = none); kept for completeness.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ClientRegistration {
    pub client_id: String,
    /// Public native clients typically get no secret; `None` for PKCE-only.
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// Register a public native client (PKCE, no secret) for our redirect URI.
/// Returns the issued `client_id`. CSS supports RFC 7591 dynamic registration.
pub async fn register_client(
    http: &reqwest::Client,
    registration_endpoint: &str,
    redirect_uri: &str,
) -> Result<ClientRegistration, OidcError> {
    let body = serde_json::json!({
        "client_name": "mind-shell (native)",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // PKCE public client: no client authentication at the token endpoint.
        "token_endpoint_auth_method": "none",
        "application_type": "native",
        "scope": "openid webid offline_access",
        // DPoP-bound access tokens.
        "dpop_bound_access_tokens": true,
    });
    let resp = http
        .post(registration_endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| OidcError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(OidcError::Registration(format!("status {}", resp.status())));
    }
    resp.json::<ClientRegistration>()
        .await
        .map_err(|e| OidcError::Registration(e.to_string()))
}

// ---- PKCE -------------------------------------------------------------------

/// A PKCE pair: the secret `verifier` (kept in-process) and the public
/// `challenge` (sent in the authorization request).
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Generate a PKCE pair: 32 CSPRNG bytes → base64url verifier; challenge =
/// base64url(SHA-256(verifier)) (RFC 7636 S256).
pub fn gen_pkce() -> Pkce {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let verifier = B64URL.encode(raw);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = B64URL.encode(digest);
    Pkce { verifier, challenge }
}

/// A CSPRNG `state` / `jti` value: 16 random bytes, base64url.
pub fn gen_random_token() -> String {
    let mut raw = [0u8; 16];
    OsRng.fill_bytes(&mut raw);
    B64URL.encode(raw)
}

/// The DPoP `ath` claim for a resource request = base64url(SHA-256(access_token))
/// (RFC 9449 §4.1). Binds the proof to the specific access token it carries.
pub fn ath_for(access_token: &str) -> String {
    B64URL.encode(Sha256::digest(access_token.as_bytes()))
}

// ---- DPoP -------------------------------------------------------------------

/// The DPoP proof-of-possession keypair. The ES256 private key lives ONLY here
/// in the Rust process (never the webview, never the pod). One key per session.
pub struct DpopKey {
    signing: SigningKey,
}

impl DpopKey {
    /// Generate a fresh ES256 (P-256) keypair from the OS CSPRNG.
    pub fn generate() -> Self {
        DpopKey { signing: SigningKey::random(&mut OsRng) }
    }

    /// The public key as a JWK (the `jwk` header of every DPoP proof). Only the
    /// PUBLIC coordinates are exported — the private scalar never leaves `self`.
    fn public_jwk(&self) -> serde_json::Value {
        let vk = self.signing.verifying_key();
        // `VerifyingKey::to_encoded_point` (inherent) → uncompressed 0x04||X||Y.
        let point = vk.to_encoded_point(false);
        let x = point.x().expect("P-256 point has X");
        let y = point.y().expect("P-256 point has Y");
        serde_json::json!({
            "kty": "EC",
            "crv": "P-256",
            "x": B64URL.encode(x),
            "y": B64URL.encode(y),
        })
    }

    /// RFC 7638 JWK thumbprint (SHA-256 over the canonical EC JWK). Used by the
    /// next milestone to assert the access token's `cnf.jkt` binding and for
    /// diagnostics; covered by tests today.
    #[allow(dead_code)]
    pub fn jkt(&self) -> String {
        let jwk = self.public_jwk();
        // Canonical member order for EC keys: crv, kty, x, y.
        let canonical = format!(
            r#"{{"crv":"P-256","kty":"EC","x":{x},"y":{y}}}"#,
            x = jwk["x"],
            y = jwk["y"],
        );
        B64URL.encode(Sha256::digest(canonical.as_bytes()))
    }

    /// Build a DPoP proof JWT for `(htm, htu)`. `ath` (access-token hash) is
    /// included when proving possession on a resource request that carries an
    /// access token; `None` for the token-endpoint proof.
    ///
    /// Header: { typ: "dpop+jwt", alg: "ES256", jwk: <public EC JWK> }
    /// Claims: { htu, htm, jti, iat[, ath] }  (Solid-OIDC / RFC 9449)
    pub fn proof(&self, htm: &str, htu: &str, ath: Option<&str>) -> Result<String, OidcError> {
        self.proof_with_nonce(htm, htu, ath, None)
    }

    /// As [`proof`], but also embeds a server-supplied `nonce` claim when the
    /// resource server demands one (RFC 9449 §8, `use_dpop_nonce`).
    pub fn proof_with_nonce(
        &self,
        htm: &str,
        htu: &str,
        ath: Option<&str>,
        nonce: Option<&str>,
    ) -> Result<String, OidcError> {
        let header = serde_json::json!({
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": self.public_jwk(),
        });
        let iat = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| OidcError::Jwt("clock before epoch"))?
            .as_secs();
        let mut claims = serde_json::json!({
            "htu": htu,
            "htm": htm,
            "jti": gen_random_token(),
            "iat": iat,
        });
        if let Some(ath) = ath {
            claims["ath"] = serde_json::Value::String(ath.to_string());
        }
        if let Some(nonce) = nonce {
            claims["nonce"] = serde_json::Value::String(nonce.to_string());
        }
        self.sign_jwt(&header, &claims)
    }

    /// Sign a compact JWS (ES256). The signature is the IEEE-P1363 r||s form
    /// (64 bytes), as JWT requires — `p256` produces this via `Signature::to_bytes`.
    fn sign_jwt(
        &self,
        header: &serde_json::Value,
        claims: &serde_json::Value,
    ) -> Result<String, OidcError> {
        let h = B64URL.encode(serde_json::to_vec(header).map_err(|_| OidcError::Jwt("header"))?);
        let c = B64URL.encode(serde_json::to_vec(claims).map_err(|_| OidcError::Jwt("claims"))?);
        let signing_input = format!("{h}.{c}");
        let sig: Signature = self.signing.sign(signing_input.as_bytes());
        let s = B64URL.encode(sig.to_bytes());
        Ok(format!("{signing_input}.{s}"))
    }
}

// ---- authorization-code token exchange --------------------------------------

/// DPoP-bound tokens from the token endpoint. These live ONLY in the Rust
/// process. We extract the WebID for the webview but never hand it the tokens.
/// `token_type` / `expires_in` are parsed for the refresh milestone (deciding
/// when to renew); `allow(dead_code)` until that path reads them.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// The OIDC ID token (a JWT) — carries the `webid` claim (Solid-OIDC).
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// Exchange the authorization `code` (+ PKCE verifier) at the token endpoint,
/// presenting a DPoP proof bound to that endpoint. Returns the DPoP-bound tokens.
pub async fn exchange_code(
    http: &reqwest::Client,
    meta: &ProviderMetadata,
    dpop: &DpopKey,
    client_id: &str,
    code: &str,
    pkce_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, OidcError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", pkce_verifier),
    ];

    // First attempt with no server nonce. DPoP proof for POST <token_endpoint>
    // (no `ath` at the token endpoint).
    let proof = dpop.proof("POST", &meta.token_endpoint, None)?;
    let mut resp = http
        .post(&meta.token_endpoint)
        .header("DPoP", proof)
        .form(&form)
        .send()
        .await
        .map_err(|e| OidcError::Http(e.to_string()))?;

    // RFC 9449 §8: the authorization server MAY require a DPoP nonce at the token
    // endpoint (HTTP 400 `use_dpop_nonce` + a `DPoP-Nonce` header). Retry ONCE
    // with a fresh proof carrying the server nonce. (Single retry, no loop — same
    // pattern as the pod-resource path; without this, sign-in fails on OPs that
    // demand a token-endpoint nonce.)
    if !resp.status().is_success() {
        if let Some(nonce) = resp
            .headers()
            .get("DPoP-Nonce")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
        {
            let proof = dpop.proof_with_nonce("POST", &meta.token_endpoint, None, Some(&nonce))?;
            resp = http
                .post(&meta.token_endpoint)
                .header("DPoP", proof)
                .form(&form)
                .send()
                .await
                .map_err(|e| OidcError::Http(e.to_string()))?;
        }
    }

    if !resp.status().is_success() {
        // Surface the status only — the body may echo request params.
        return Err(OidcError::Token(format!("status {}", resp.status())));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| OidcError::Token(e.to_string()))
}

/// Extract the WebID from an ID token's `webid` claim (falling back to `sub` if
/// the provider puts the WebID there). Verifies NOTHING cryptographically beyond
/// JSON shape — the token came over TLS straight from the token endpoint we
/// just called, so this is decode, not trust-establishment. (A hardening
/// follow-up could verify the ID token signature against `jwks_uri`.)
pub fn webid_from_id_token(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let bytes = B64URL.decode(payload_b64).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("webid")
        .and_then(|v| v.as_str())
        .or_else(|| claims.get("sub").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let p = gen_pkce();
        // Recompute the challenge from the verifier and compare.
        let expect = B64URL.encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expect);
        // base64url, no padding.
        assert!(!p.challenge.contains('='));
        assert!(!p.challenge.contains('+') && !p.challenge.contains('/'));
    }

    #[test]
    fn pkce_verifier_is_high_entropy_and_unique() {
        let a = gen_pkce().verifier;
        let b = gen_pkce().verifier;
        assert_ne!(a, b);
        // 32 bytes → 43 base64url chars (no pad).
        assert_eq!(a.len(), 43);
    }

    #[test]
    fn dpop_proof_is_three_segment_es256_jwt_with_required_claims() {
        let key = DpopKey::generate();
        let jwt = key.proof("POST", "https://pod.mindpods.org/.oidc/token", None).unwrap();
        let segs: Vec<&str> = jwt.split('.').collect();
        assert_eq!(segs.len(), 3, "compact JWS has 3 segments");

        let header: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(segs[0]).unwrap()).unwrap();
        assert_eq!(header["typ"], "dpop+jwt");
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["jwk"]["kty"], "EC");
        assert_eq!(header["jwk"]["crv"], "P-256");
        // The private scalar must NOT appear in the JWK header.
        assert!(header["jwk"].get("d").is_none(), "private key leaked into JWK");

        let claims: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(segs[1]).unwrap()).unwrap();
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["htu"], "https://pod.mindpods.org/.oidc/token");
        assert!(claims["jti"].is_string());
        assert!(claims["iat"].is_number());
        assert!(claims.get("ath").is_none(), "no ath at token endpoint");

        // ES256 signature is 64 bytes (r||s).
        assert_eq!(B64URL.decode(segs[2]).unwrap().len(), 64);
    }

    #[test]
    fn dpop_proof_signature_verifies() {
        use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
        let key = DpopKey::generate();
        let jwt = key.proof("GET", "https://pod.mindpods.org/resource", Some("abc")).unwrap();
        let segs: Vec<&str> = jwt.split('.').collect();
        let signing_input = format!("{}.{}", segs[0], segs[1]);
        let sig = Signature::from_slice(&B64URL.decode(segs[2]).unwrap()).unwrap();
        let vk: VerifyingKey = *key.signing.verifying_key();
        assert!(vk.verify(signing_input.as_bytes(), &sig).is_ok());

        // `ath` present on a resource request.
        let claims: serde_json::Value =
            serde_json::from_slice(&B64URL.decode(segs[1]).unwrap()).unwrap();
        assert_eq!(claims["ath"], "abc");
        assert_eq!(claims["htm"], "GET");
    }

    #[test]
    fn webid_extracted_from_id_token_webid_claim() {
        // Forge a JWT with only the payload populated (signature segment unused
        // by the extractor).
        let payload = B64URL.encode(br#"{"webid":"https://alice.pod.example/profile/card#me","sub":"x"}"#);
        let token = format!("aGVhZGVy.{payload}.c2ln");
        assert_eq!(
            webid_from_id_token(&token).as_deref(),
            Some("https://alice.pod.example/profile/card#me")
        );
    }

    #[test]
    fn jkt_is_stable_base64url_sha256() {
        let key = DpopKey::generate();
        let a = key.jkt();
        let b = key.jkt();
        assert_eq!(a, b, "thumbprint is deterministic for a key");
        assert_eq!(B64URL.decode(&a).unwrap().len(), 32, "SHA-256 = 32 bytes");
    }
}
