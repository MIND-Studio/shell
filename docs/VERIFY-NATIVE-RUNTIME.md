# Native runtime verification — `mind-shell-v0` (Tauri track)

> Runtime verification pass, 2026-06-02 · scope: actually *running* the native
> Tauri build and exercising the OIDC + `pod_fetch` networking paths against a
> **live** Solid server, beyond the compile-and-unit-test status recorded in
> [`REVIEW-NATIVE-READINESS.md`](./REVIEW-NATIVE-READINESS.md).
>
> Environment: macOS (darwin 25.5), Rust 1.89, `@tauri-apps/cli` 2.11.2, live
> Community Solid Server on `http://localhost:3101/` (`mind-shell-css` docker,
> `alice@mind-shell.local` seeded with one vault item).

## TL;DR

The native track is **runtime-verified end to end** for everything that does not
require a human at the system browser. Two real bugs were found *only* by running
against a live IdP — both fixed and re-verified. The single remaining unproven
piece is the interactive authorization-code leg inside the system browser →
deep-link callback, which is inherently manual (no headless path exists).

## What was verified at runtime

| # | Check | How | Result |
|---|---|---|---|
| 1 | Native unit tests | `cargo test` in `src-tauri/` + `crypto-core/` | **42 pass** (10 + 32) |
| 2 | Native app boots | ran `target/*/mind-shell`; macOS registers it as a GUI app, WebKit spawns, embedded frontend served, stable, no panic | **PASS** |
| 3 | OIDC discovery (live) | `oidc::discover("http://localhost:3101/")` | **PASS** — endpoints resolved |
| 4 | RFC 7591 dynamic registration (live) | `oidc::register_client(...)` against `/.oidc/reg` | **PASS** (after Bug 1 fix) — `201`, `client_id` issued |
| 5 | DPoP-bound access token (live) | client-credentials grant at `/.oidc/token`, DPoP proof bound to the **native `DpopKey`**, single nonce-retry | **PASS** — token endpoint did *not* demand a nonce on this OP |
| 6 | Real `pod_fetch` GET container (live) | `do_pod_fetch` → `GET alice/apps/vault/items/` | **PASS** — `200`, **7 `Link` headers preserved** (duplicate-`Link` marshaling proven on real CSS output), 673 B turtle |
| 7 | Zero-knowledge holds through native path | `pod_fetch` GET of `it-49f3b4f2…​.enc` (164 B) | **PASS** — body is **opaque** (not JSON, no plaintext markers) through the native transport |
| 8 | 4xx returned, not thrown | `pod_fetch` GET of a non-existent resource | **PASS** — surfaces `404` (so `@inrupt`'s `exists()`/404 handling works) |

Checks 3–8 are the [`live_native_pod_fetch_end_to_end`](../src-tauri/src/pod_fetch.rs)
`#[ignore]`d integration test. It mints a real DPoP-bound token via CSS
client-credentials (the same path `scripts/smoke-vault.ts` uses) **bound to the
native `DpopKey`**, then drives the actual `do_pod_fetch` command path — so the
whole zero-trust-of-webview pod-I/O chain runs against a live pod with no
interactive login. Run it with:

```bash
docker compose up -d && npm run seed:demo          # CSS on :3101, alice seeded
cd src-tauri && cargo test -- --ignored --nocapture live_native_pod_fetch_end_to_end
```

The token + DPoP key never leave the Rust process in this test, exactly as in the
shipping path (HARD rule #1 preserved).

## Bugs found by runtime verification (both fixed)

### Bug 1 — redirect URI scheme rejected by the IdP (`invalid_redirect_uri`)

`mindshell://auth/callback` is a **single-label** custom scheme. CSS /
`oidc-provider` enforces **RFC 8252 §7.1** and rejects it at dynamic
registration:

> `redirect_uris for native clients using Custom URI scheme should use reverse
> domain name based scheme`

This would have broken native sign-in entirely (registration → `400`). Fixed by
switching to the reverse-DNS scheme **`org.mindpods.shell://auth/callback`**
(matches the bundle identifier `org.mindpods.shell`). Verified: registration now
returns `201`. Changed in `src-tauri/src/auth.rs` (`DEEP_LINK_SCHEME`,
`REDIRECT_URI`), `src-tauri/tauri.conf.json` (`plugins.deep-link.desktop.schemes`),
and the doc comments in `lib.rs`/`commands.rs`.

### Bug 2 — deep-link routing guard never matched

`auth.rs`'s `on_open_url` handler guarded on
`url.scheme() == "…" && url.path() == "/auth/callback"`. The `url` crate parses
`<scheme>://auth/callback` with **`host = "auth"`, `path = "/callback"`** (the
`//` introduces an authority), so that guard could never fire — the primary
desktop callback route was dead code (only the cold-start string-prefix fallback
would have worked). Fixed to match the full URL string against the canonical
`REDIRECT_URI` prefix, which is robust to the host/path split.

## Not verifiable here (inherently manual)

- **Interactive authorization-code leg.** The authorization request opens in the
  **system browser** (never an embedded webview — PRD-NATIVE §3.1), the user
  authenticates, and the OP redirects to `org.mindpods.shell://auth/callback`,
  which the OS hands back to the app via `tauri-plugin-deep-link`. There is no
  headless way to drive a human login + OS deep-link dispatch. The *transport*
  underneath it (discovery, registration, PKCE construction, DPoP proofs, the
  token exchange shape, WebID extraction, single-flight `pending` consumption) is
  unit-tested and, for everything except the code-for-token swap, live-verified
  via the client-credentials path above. To exercise the full leg manually:

  ```bash
  cd src-tauri && npm run tauri:dev    # or: cargo tauri dev
  # In the app: Sign in → system browser → authenticate → returns to the app;
  # then unlock Vault, create an item, and confirm only ciphertext hits the pod
  # (npm run smoke:vault).
  ```

## Docker headless GUI render (Linux / WebKitGTK)

To exercise the actual window without macOS Screen-Recording/Automation
permissions, the app was built and run **headless in Docker** under Xvfb and
screenshotted (`docker/tauri-linux-test/`). **Fidelity caveat:** this is the
**Linux WebKitGTK** webview, NOT the macOS/iOS WKWebView that ships; it verifies
the frontend bundle + Tauri command wiring render and run under a real Tauri
webview, but is a proxy for the Mac build. The system-browser OIDC leg still
can't run in a container.

Result: **PASS** — the app launched, loaded the embedded production frontend
(`--features custom-protocol`), and rendered the full connect/login UI
(`MindLoginCard`: "Continue with Mind", "Use a different pod", dark theme + indigo
accent, "You will sign in at localhost:3101"). An `xdotool` click registered
(scrollbar/focus change), confirming a live, interactive DOM rather than a frozen
frame. Screenshots: `docker/tauri-linux-test/artifacts/`.

Reproduce:
```bash
docker build -t mind-shell-tauri-linux-test docker/tauri-linux-test
docker run --rm -v "$PWD":/work -v mind_shell_tauri_linux_target:/target \
  -e CARGO_TARGET_DIR=/target --shm-size=1g \
  mind-shell-tauri-linux-test bash /work/docker/tauri-linux-test/run-in-container.sh
```

This also surfaced that `is_dev()` is `!cfg!(feature = "custom-protocol")` — a
plain `cargo build` (no CLI) loads `devUrl` and shows "Could not connect to
localhost" until `--features custom-protocol` is passed (see Build fixes below).

## Build / packaging fixes (macOS `tauri build`)

Found while running `npm run tauri:build` on macOS:

1. **Corrupt/placeholder icons → `.icns` generation failed** (`Failed to create
   app icon: Png CRC error`). All four `src-tauri/icons/*.png` were 1×1 stubs
   (one corrupt). Fixed: generated a proper 1024×1024 source
   (`scripts/gen-icon-source.py`, pure stdlib — indigo tile + white padlock) and
   ran `tauri icon` to produce a valid set (`.icns`/`.ico`/iOS/Android). `.app`
   now bundles.
2. **DMG bundling failed** (`error running bundle_dmg.sh`, `exit 64`).
   `bundle_dmg.sh` drives **Finder via AppleScript** to style the DMG window,
   which needs Automation permission. Fixed: set `bundle.targets` to `["app"]`
   (default build no longer needs Finder) and added `npm run tauri:build:dmg`
   (`CI=true … --bundles dmg`) which passes the script's `--skip-jenkins` path to
   produce a (plain) DMG without AppleScript. Verified: 2.7 MB valid UDIF image.
3. **Missing `custom-protocol` feature** in `src-tauri/Cargo.toml`. Added (kept
   OUT of `default` so `tauri dev` still hot-reloads) so plain `cargo build
   --features custom-protocol` / CI / the Docker harness produce a real
   production binary. The Tauri CLI already enabled it for `tauri build`, so the
   macOS `.app` was unaffected — but the declaration is now template-correct.

## Follow-ups (not blocking)

- **Token-endpoint DPoP-Nonce.** This CSS instance did *not* require a DPoP nonce
  at the token endpoint, so `oidc::exchange_code` (which has no token-endpoint
  nonce retry, unlike `pod_fetch`) succeeds here. Some Solid OPs *do* require it
  (RFC 9449 §8). Hardening: add the same single nonce-retry to `exchange_code`.
- **ID-token signature verification.** `webid_from_id_token` decodes (does not
  verify) the ID token — acceptable since it arrives over TLS straight from the
  token endpoint, but verifying against `jwks_uri` is a noted hardening item.
- **Release artifact.** ✅ Done — `target/release/mind-shell` rebuilt after the
  scheme fix; verified the binary embeds `org.mindpods.shell://auth/callback` and
  no stale `mindshell` literal. (A full `tauri build` `.app`/`.dmg` bundle was not
  produced here — needs Apple signing config; the binary itself is current.)
- **`cargo audit` + `cargo deny`** remain standing CI controls (PRD §8); not run
  in this environment.
