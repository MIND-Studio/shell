# `src-tauri/` — mind-shell as a native Tauri app

The native delivery of `shell` (PRD-NATIVE.md): the **same** Next.js shell
frontend wrapped by Tauri 2, with `crypto-core/` wired as a **native path
dependency** (rlib) instead of WASM. One audited crypto crate, two bindings.

Owned by `rust-dev`. Edit **only** files under `src-tauri/`.

## Layout

```
src-tauri/
  Cargo.toml          path dep on ../crypto-core; lib(staticlib+cdylib+rlib)+bin for mobile
  build.rs            tauri_build::build()
  tauri.conf.json     deep-link scheme (mindshell://), strict CSP (§3.6), capabilities, mobile bundle ids
  capabilities/main.json   least-privilege allowlist (no fs / shell-exec / http / clipboard-read)
  icons/              PLACEHOLDER 1x1 PNGs — replace before any store/bundle build
  src/
    main.rs           thin desktop launcher → mind_shell_lib::run()
    lib.rs            plugin + managed-state + command registration (the run() entrypoint)
    state.rs          unlocked-session boundary (dedicated crypto thread) + auth state
    commands.rs       #[tauri::command] wrappers over crypto-core + auth (the ENTIRE webview surface)
    auth.rs           native OIDC PKCE + DPoP + deep-link callback skeleton (§3.1, N0 spike markers)
```

## Build & run

`cargo build` inside `src-tauri/` succeeds today (desktop, no extra tooling):

```bash
cd src-tauri && cargo build        # green, warning-free
```

### Smoke (what's verified)

- `cargo build` in `src-tauri/` — **green, warning-free**; produces the desktop
  binary `target/debug/mind-shell`.
- `cargo test` in `crypto-core/` — **all pass**, including `native::tests` that
  prove a session handle minted by `unlock` stays valid across threads (the exact
  Tauri-async-runtime hazard) and that no plaintext/keys leave the native API.
- The JS↔Rust wire contract matches `src/lib/platform/native.ts`'s `CMD` map:
  command names + camelCase arg keys (Tauri auto-maps camelCase→snake_case for
  top-level args; nested struct fields use serde, with `avoidAmbiguous` renamed)
  and the `auth-callback` event name (`auth::EVENT_AUTH_CALLBACK`), payload
  `{ ok: bool }` — the frontend then calls `auth_status` for `{ signedIn, webId }`.

Running the window needs the Tauri CLI (not installed here) + the frontend export
in `../out`; both are covered below.

To **run** the app you need the Tauri CLI, which is **not installed** in this env:

```bash
cargo install tauri-cli --version "^2"   # one-time
cargo tauri dev                          # builds frontend (npm run dev on :3100) + opens the window
cargo tauri build                        # production bundle (needs real icons — see below)
```

`cargo tauri dev`/`build` invoke `beforeDevCommand` / `beforeBuildCommand` from
`tauri.conf.json` (`npm run dev` / `npm run export`). Use `export`, NOT plain
`build`: frontend-dev's `npm run build` emits `output: "standalone"` (a `.next`
Node server), whereas `npm run export` sets `TAURI=1` → `next.config` switches to
static export into `../out` (`frontendDist`). A direct `cargo tauri build` with
plain `build` would find no static frontend. frontend-dev owns the Next config +
the `export` script.

## CSP `connect-src` (security review)

`tauri.conf.json`'s `connect-src` is intentionally narrow (strict CSP, §3.6):

- `'self' ipc: http://ipc.localhost` — the Tauri IPC bridge (command invokes).
- `https://api.pwnedpasswords.com` — the HIBP k-anonymity range API (only the
  5-char SHA-1 prefix is ever sent; the password/full hash never leave the device,
  CONTRACT.md `hibp_prefix`). **Required** or the breach check fails silently.
- `https://pods.mindpods.org` — the default Solid issuer + pod host.
- `http://localhost:3101` — the opt-in local CSS instance (per AGENTS.md).

**v0 limitation (documented, not a bug):** Solid pods can live on *arbitrary*
hosts, but this v0 `connect-src` allowlists only the default `pods.mindpods.org`
(and the local CSS). A user whose pod/issuer is on another origin will be blocked
by CSP until their host is added here. v0 ships with the default-issuer story
(`pods.mindpods.org`, the SSO hub per the prototypes' shared-login design); a
later milestone should derive `connect-src` from the configured issuer/pod origin
(or relax to a vetted pattern) rather than hardcoding hosts.

## Zero-knowledge boundary (HARD rule #1)

The unlocked vault session lives **only** in this Rust process. `commands.rs` is
the entire surface the webview can invoke and **no command returns a raw key or
plaintext secret** — only ciphertext, wrapped keys, KDF params, salts, or
short-lived display values (a generated password, a TOTP code, or a decrypted
item the user explicitly asked to view). The webview holds an opaque numeric
`Handle`; it indexes the session store the crypto thread owns. No command logs
secrets (HARD rule #5).

### Session store (crypto-dev task #2 — landed)

`commands.rs` calls `crypto_core::native::*` directly. That native layer owns the
unlocked-session store as a **process-global, thread-safe** `Mutex<HashMap<u32,
HardenedSession>>` with the data key **pinned into RAM (`mlock`)** and zeroized
on drop, so a handle minted by `unlock` stays valid across any of Tauri's async
worker threads (its `native::tests` prove cross-thread handle use). No executor
or extra synchronization is needed in this crate; `state.rs` therefore holds
**only** the native-auth session. `vault_lock_state(handle)` surfaces the
non-secret pinned/not-pinned signal (no key bytes) for telemetry.

## Authenticated pod I/O (pod_fetch.rs) — DPoP-signed, from Rust

After native sign-in the DPoP private key + access token live ONLY in the Rust
process, so the webview can't (and must not) make authenticated pod requests
itself. The `pod_fetch` command does it on the webview's behalf:

- **Command** (frontend-dev's WHATWG-faithful contract):
  `pod_fetch({ url, method?, headers?, body? })
  -> { status, statusText, headers, body }`. The frontend's native `fetch` shim
  (task #9) calls this and reconstructs a WHATWG `Response`; `@inrupt/
  solid-client` then uses that shim as its `fetch`.
  - **Headers are `Array<[name, value]>`, NOT a map** — both directions. Solid
    sends multiple `Link` headers and `@inrupt`'s container parsing depends on
    all of them, so duplicates must survive; a map would collapse them.
  - **Body is always base64**, both directions (uniform for text `.ttl` and
    binary `.enc` — the shim base64-decodes either way).
  - **Status is returned, never thrown** for 4xx/5xx, so the SDK's own error
    handling works (e.g. `exists()` catching a 404). `statusText` is the
    canonical reason phrase.
- **Per-request DPoP (RFC 9449):** a FRESH proof JWT per call — `htm` = method,
  `htu` = url with query/fragment stripped, `jti`, `iat`, and
  `ath` = base64url(SHA-256(access_token)) — plus `Authorization: DPoP <token>`.
  The proof is minted under a short lock (the DPoP key never leaves the session)
  and the lock is released before the network `.await`.
- **DPoP-Nonce:** a `401` + `DPoP-Nonce` challenge is retried **once** with a
  fresh proof carrying the server `nonce` (RFC 9449 §8).
- **Zero-trust of webview (HARD #1/#5):** the access token and DPoP key NEVER
  cross the command boundary — only the response does. Caller-supplied
  `Authorization`/`DPoP` headers are ignored. Nothing is logged.

Offline unit tests cover `htu` stripping and that a pod GET's DPoP proof binds
method+url and carries `ath = base64url(SHA-256(access_token))`. The live request
leg needs a signed-in session + a reachable pod (same env limit as auth).

## Native auth (auth.rs + oidc.rs) — N0 spike, IMPLEMENTED (§3.1)

The full native Solid-OIDC flow is implemented (no placeholders remain):

- **Discovery** — GET `<issuer>/.well-known/openid-configuration`.
- **Dynamic client registration** (RFC 7591) — a public *native* client
  (`token_endpoint_auth_method: none`, `dpop_bound_access_tokens: true`) for the
  `mindshell://auth/callback` redirect; a caller-supplied `client_id` is used if
  given.
- **PKCE** — `code_verifier` = 32 `OsRng` bytes (base64url, 43 chars);
  `code_challenge` = base64url(SHA-256(verifier)) (S256).
- **DPoP** — a per-flow ES256 (P-256) keypair (`p256`/`ecdsa`); proof JWTs carry
  `{typ:"dpop+jwt", alg:"ES256", jwk:<public EC JWK>}` + `{htu, htm, jti, iat[, ath]}`
  (RFC 9449). The **private key never leaves the Rust process** (same custody as
  vault keys) and is dropped/zeroized on logout.
- **Token exchange** — POST the authorization code + PKCE verifier to the token
  endpoint with the DPoP proof header; store the DPoP-bound tokens in-process.
- **WebID** — extracted from the ID token's `webid` claim (fallback `sub`),
  recorded in the in-process session and read by the webview via `auth_status`.
  It does NOT ride the `auth-callback` event (payload is `{ ok: bool }` only);
  tokens and the DPoP key never leave the Rust process.

Single-flight (HARD rule #3) is preserved: the deep-link callback `take()`s the
pending flow before the async exchange, so a replayed/duplicate callback finds no
pending flow and is dropped; the `state` param is matched (CSRF) before use.

### §8 Q1 decision — thin native PKCE/DPoP client (not `solid-client-authn-node`)

We implemented a focused native client in `oidc.rs` rather than adapting
`@inrupt/solid-client-authn-node`, because: (1) that library is **JavaScript** —
the wrong runtime for the process that must hold the DPoP private key, and
embedding a Node runtime would be a heavy dependency; (2) its flow assumes an
HTTP-server redirect, not the **custom-scheme / universal-link callback** we use
(PRD-NATIVE §3.1); (3) keeping the DPoP key + tokens **in the Rust process** (not
the webview) mirrors the vault key-custody posture. Solid-OIDC is plain OIDC +
PKCE + DPoP over standard discovery, so a small audited-crate Rust client is both
simpler and more secure than embedding a JS runtime.

### Crypto policy

Auth-transport crypto uses **vetted RustCrypto crates in this layer only**
(`p256`/`ecdsa`, `sha2`, `rand` OsRng, `base64`) — never hand-rolled, and **not**
inside the vault `crypto-core` (its audit surface stays vault-only). None of it
touches vault key material.

### What's tested vs. needs a live IdP

Unit tests (`cargo test` in `src-tauri/`, 7 pass) cover the offline-verifiable
crypto: PKCE challenge = S256(verifier), verifier entropy/uniqueness, the DPoP
proof JWT structure + required claims, **DPoP signature round-trip verification**,
the JWK thumbprint, the WebID extractor, and the authorization-URL builder. The
network legs (discovery, registration, token exchange) and the end-to-end
deep-link round-trip need a running app + a live IdP — see manual steps below.

### Manual end-to-end verification (needs Tauri CLI + a live IdP)

`cargo build`/`cargo test` pass with no extra tooling. Driving the real sign-in
needs the Tauri CLI (not installed here) and a reachable issuer:

```bash
cargo install tauri-cli --version "^2"     # one-time
export NEXT_PUBLIC_SOLID_ISSUER=https://pods.mindpods.org/   # or a local CSS
cd src-tauri && cargo tauri dev            # builds the frontend + opens the window
# In the app: click "Continue with Mind" -> the SYSTEM browser opens at the
# issuer's /.oidc/auth -> sign in -> the IdP redirects to
# mindshell://auth/callback?code=...&state=... -> the OS hands that deep link to
# the running app -> auth.rs exchanges the code (with a DPoP proof) and emits
# the `auth-callback` event { ok: true } -> the frontend calls auth_status and
# reads { signedIn:true, webId } -> the shell renders signed-in.
```

Verify: (a) the browser that opens is the **system** browser, not an in-app
webview; (b) `auth_status` returns the WebID after the round-trip; (c) the
webview never receives a token OR the WebID via the event — the `auth-callback`
payload is `{ ok: true }` only, and the WebID is read separately via `auth_status`
(inspect the IPC payloads to confirm no token ever crosses).
A local CSS instance (`docker compose up`, issuer `http://localhost:3101/`) works
too once added to the CSP `connect-src` (see above).

## Mobile (iOS / Android) — scaffolding only, not device-built here

`tauri.conf.json` carries the bundle identifier (`org.mindpods.shell`),
`iOS.developmentTeam` (replace `REPLACE_WITH_APPLE_TEAM_ID`), `android.minSdkVersion`,
and the `deep-link.mobile` associated-domain config. The `Cargo.toml` lib
crate-types (`staticlib`+`cdylib`) and the `#[cfg_attr(mobile, ...)]` entrypoint
are mobile-ready. Generating the actual native projects (`gen/`, gitignored) and
building for a device requires platform toolchains that are **out of this env**:

```bash
cargo tauri ios init        # needs Xcode + Apple Developer account
cargo tauri android init    # needs Android SDK/NDK + JDK
```

Run those on a machine with the toolchains; they create `gen/apple` / `gen/android`.

## Icons

`icons/*.png` are **1×1 placeholders** so `cargo build` works. Before a bundle
(`cargo tauri build`) or store submission, replace them with real assets
(`cargo tauri icon path/to/logo.png` regenerates the full set, including the
`.icns`/`.ico` re-added to `tauri.conf.json`).
