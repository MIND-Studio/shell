# Code review + native-track readiness — `mind-shell-v0`

> Reviewer pass, 2026-06-02 · scope: correctness, the 6 HARD security rules
> (AGENTS.md), code quality, milestone status (PRD.md M0–M6), and native-track
> readiness (PRD-NATIVE.md). This doc is advisory; the owning teammates apply the
> fixes (crypto-dev → `crypto-core`, rust-dev → `src-tauri`, frontend-dev →
> `src/lib/platform` + Next config).

## TL;DR

The web shell + Vault is in **good shape**: `cargo test` passes (32/32 after the
task-#2 native additions; was 23/23 at first review), `tsc --noEmit` is clean,
the crypto core is correct and matches `CONTRACT.md`, and the
6 HARD security rules are upheld in the reviewed code. Functionally the prototype
is roughly **M0–M4 complete** (shell chrome, Rust core, full Vault CRUD, HIBP +
TOTP + master-password re-wrap), with M5/M6 partially scaffolded.

For the **native track**, the state as of this pass (two crypto-core items
landed in task #2 between the first review draft and this update):

1. **[RESOLVED in task #2] `thread_local!` session store.** Native callers now use
   the new `crypto_core::native` module, whose store is a process-global
   `OnceLock<Mutex<HashMap<u32, HardenedSession>>>` (verified across threads).
   `envelope::*` keeps `thread_local!` for the WASM path. **`native::*` is the
   only supported native entrypoint** — calling `envelope::unlock` directly on
   native is a trap (compiles, passes a single-thread test, loses sessions under
   Tauri's tokio pool). See §3.3.
2. **[RESOLVED in task #5] `next.config.ts` static export.** Now
   `output: isTauri ? "export" : "standalone"` (TAURI env gate); both builds
   verified. `src/lib/platform/` auth seam built. See §3.2. A mechanical
   **follow-up (task #6)** remains: rewire `ConnectForm`/Vault call sites through
   `getPlatform()` so native auth actually flows.
3. **[OPEN, src-tauri — rust-dev task #4] CSP `connect-src` omits the HIBP host**;
   the export/build wiring (`frontendDist: ../out`, `npm run export`) and the
   native command bodies (`commands.rs`/`auth.rs`/`state.rs`) aren't written yet.
   Must target `crypto_core::native::*`, not `envelope::*` (see §3.3 trap).
4. **[RESOLVED in task #2] mlock/VirtualLock added** (`crypto-core/src/memlock.rs`):
   the unlocked data key is pinned into physical RAM, best-effort, zeroize-then-
   munlock on drop. See §3.4.

The remaining work (#3 and the #6 follow-up) does not require widening the
FFI/command contract; the task-#2 crypto work kept the WASM FFI byte-for-byte
unchanged. The native path of `crypto-core` is **usable from Rust today via
`native::*`**.

---

## 1. Security invariants (the 6 HARD rules, AGENTS.md)

| # | Rule | Status | Evidence |
|---|---|---|---|
| 1 | Zero-knowledge: plaintext/keys never cross the FFI | **Upheld** | `crypto-core/src/lib.rs` wasm exports return only base64/handles/display values; `Unlocked` keys live in `envelope.rs` behind a `u32` handle; `src/lib/vault/core.ts` + `crypto-contract.ts` marshal only ciphertext/params/handles. |
| 2 | Pod is the only store; no plaintext to disk | **Upheld** | `src/lib/vault/model.ts` writes only `vault.ttl` (non-secret index + KDF params + wrapped key) and opaque `items/{id}.enc`. No SQLite cache is implemented yet; nothing persists plaintext. `localStorage` holds only WebID/issuer/return-path (`accounts.ts`, `session.ts`, `auth.ts`). |
| 3 | Single-flight OIDC | **Upheld** | `src/lib/solid/auth.ts` memoizes `handleIncomingRedirect` to a module-level promise (`redirectHandled`); both `ensureSession` and `completeLoginRedirect` share it. No second call site found. `restorePreviousSession` deliberately avoided (documented loop reason). |
| 4 | No bespoke crypto in JS | **Upheld** | All KDF/AEAD/TOTP/HIBP-hash is in Rust (`kdf.rs`/`aead.rs`/`totp.rs`/`hibp.rs`). JS only base64-frames the sealed blob (`packSealed`/`unpackSealed`) and does the HIBP suffix string-compare — no crypto. |
| 5 | Never log secrets | **Upheld** | Zero `console.*` in `src/`; only `console_error_panic_hook` in Rust. Errors are generic ("Wrong master password", "decryption failed") — no secret material in messages. |
| 6 | Independent crypto review + `cargo audit`/`cargo deny` in CI | **Partial** | `crypto-core/deny.toml` exists; CI wiring for audit/deny should be confirmed in `.github/workflows/`. Independent review is a process gate, not a code item. |

**No HARD-rule violations found in the reviewed code.**

### Crypto correctness (crypto-core)

- **AEAD** (`aead.rs`): XChaCha20-Poly1305 only, 24-byte random nonce, AAD bound,
  generic decrypt errors (no padding/oracle distinction). Round-trip / wrong-key
  / tamper / AAD-mismatch tests present.
- **Envelope** (`envelope.rs`): two-level key hierarchy (stretched → data key →
  per-item key), wrap = `nonce||ct||tag` with purpose-bound AAD, item AAD =
  `"{id}:{version}"` (anti-swap/rollback). `change_password` re-wraps the data
  key only and updates the live session in place — matches PRD §5.2.
- **KDF** (`kdf.rs`): Argon2id (v0x13) + HKDF-SHA256 into separate enc/wrap
  subkeys; `KdfParams::clamped()` floors at OWASP (19 MiB/t=2/p=1) so a tampered
  persisted param can't downgrade below baseline; `calibrate_kdf` linear-scales
  memory to a ~750 ms target, capped at 1 GiB. Sound.
- **TOTP** (`totp.rs`): hand-rolled HMAC-SHA1 HOTP/TOTP; **passes the RFC 6238
  Appendix B known-answer vectors**. Good.
- **HIBP** (`hibp.rs`): SHA-1 → 5-char prefix + 35-char suffix; only the prefix
  is sent (`ItemDetail.tsx` queries `api.pwnedpasswords.com/range/{prefix}` and
  compares the suffix locally). k-anonymity correct; password never leaves device.
- **Memory hygiene**: `Unlocked`/`StretchedKey` derive `ZeroizeOnDrop`; keys are
  fixed `[u8; 32]`; `SecretBox<StretchedKey>`; `subtle`-based `ct_eq` available.
  `lock()` removes (drops→zeroizes) the session.

**Minor / non-blocking quality notes (crypto-core):**
- Diceware list in `generate.rs` contains duplicate words ("mango" appears
  twice), which marginally lowers per-word entropy. Cosmetic for a prototype;
  PRD §5 already flags swapping in the full EFF list for high-stakes use.
- `Unlocked.salt` is stored but unused by current logic (`change_password` rolls
  a fresh salt). Harmless; comment already acknowledges it.

---

## 2. Milestone status vs PRD.md (M0–M6)

| Milestone | State | Notes |
|---|---|---|
| **M0 Scaffold** | **Done** | Next 16.2.6 + React 19.2.4 + Tailwind v4, `@mind-studio/core` login (`ConnectForm.tsx`), single-flight auth, CSS docker-compose (:3101 per AGENTS), seed/smoke scripts. `tsc` clean. |
| **M1 Shell** | **Done (v0 scope)** | Workspace rail, project switcher, app switcher (waffle), account switcher, app menu/body all present in `src/components/shell/`; shell state model + `useShell()` context. Renders Vault as the in-process app. Multi-workspace rail intentionally holds only the owned pod for now (PRD §11 Q7 — joined-workspace index deferred). |
| **M2 Rust core** | **Done** | `crypto-core` full: Argon2id+HKDF, XChaCha20-Poly1305 envelope, per-item keys, zeroize/secrecy/subtle, `wasm-pack` target, 23 unit+KAT tests passing. `deny.toml` present. |
| **M3 Vault app** | **Done** | Unlock/setup, item CRUD (login/note/card) with per-item AEAD to `items/`, generator, auto-lock (`autolock.ts`) + zeroize on lock, clipboard auto-clear (`clipboard.ts`). Pod is source of truth; in-memory index (no SQLite cache yet — fine, the index lives in `vault.ttl`). |
| **M4 Hardening** | **Mostly done** | HIBP k-anonymity ✔, TOTP ✔, master-password change/re-wrap ✔. **Gap:** the one WAC-grant *sharing demo* (folder-scoped ACL) is **not implemented** (no `acl`/`wac`/`grant` code in `src/`). |
| **M5 Project scope + ship** | **Partial** | Project switcher exists; union-view of project-scoped vault is future (model `appZone` takes a project arg). `Dockerfile`, `release.yml`, `DEPLOY.md` present. Catalog tile + infra wiring to `shell.mindpods.org` not verified here. |
| **M6 Native (Tauri)** | **In progress (advancing fast)** | `src-tauri/` scaffolded; native crypto commands + `state.rs`/`commands.rs`/`auth.rs` wired (task #4); JS platform seam + static export (task #5); all app call sites routed through `getPlatform()` for both auth and crypto (task #6). **Remaining:** the N0 native OIDC token exchange (PKCE + DPoP) spike (task #7) and the native authed-`fetch` decision (§3.1). See §3. |

---

## 3. Native-track readiness (PRD-NATIVE.md)

### 3.1 Is pod I/O client-side only? — **Yes.**

All pod reads/writes go through `src/lib/solid/pod-fs.ts` using
`session().fetch` from `@inrupt/solid-client-authn-browser` (the in-browser
SDK). The shell context (`src/lib/shell/context.tsx`) and the Vault model
(`src/lib/vault/model.ts`) only ever call these client wrappers. There is **no
server-side pod access** in the app. `@inrupt/solid-client-authn-node` is a
dependency but is imported **only** by `scripts/seed-demo.ts` and
`scripts/smoke-vault.ts` (Node tooling), never by `src/`.

→ A static frontend with no Node runtime can do all of Vault's pod I/O. Good for
Tauri.

**Native authed-`fetch` bridge — the one remaining native pod-I/O gap (DECIDED;
in progress):** the JS pod-I/O layer is built around `session().fetch`, which on
web is the `@inrupt/solid-client-authn-browser` authed fetch (DPoP-bound, managed
by the SDK). On native, the OIDC/DPoP exchange happens in Rust (`auth.rs`/
`oidc.rs`), so the frontend needs an authed fetch after sign-in.

**Decision (team-lead):** route native pod I/O **through a Tauri command** so the
DPoP private key stays entirely in the Rust process and never reaches the webview
(the stronger-isolation option; consistent with the FFI/HARD-rule posture). The
rejected alternative was injecting the token into a JS `fetch` wrapper — simpler
but would expose DPoP key material to JS.

- **Task #8 (rust-dev) — LANDED:** the DPoP-signing `pod_fetch` Tauri command
  (`src-tauri/src/pod_fetch.rs`); reviewed sound (see §3.4). Key stays in Rust;
  response headers preserved un-collapsed.
- **Task #9 (frontend-dev, was blocked on #8) — now unblocked:** route
  `pod-fs.ts` through a platform-provided fetch (`getPlatform().pod.fetch`) on
  native; web keeps `session().fetch`.
- **Contract detail (honored on both sides):** headers pass as `Array<[string,
  string]>` (not a plain object) so **duplicate `Link` headers survive** — the
  `@inrupt` SDK parses response `Link` rels for resource metadata, and
  `getFile`/`overwriteFile`/`createContainerAt` rely on `content-type` +
  `Location`/source URL; a map would collapse them. (`readdir` itself is
  body-driven via `getContainedResourceUrlAll`, so the real break would have been
  writes/metadata, not listing.)

The `session().fetch`-shaped seam is preserved; the last native pod-I/O wiring
step is task #9, not a blocker for the rest of the stack. Native **auth** itself
is fully settled on both sides (event name `auth-callback`, payload `{ ok }`).

### 3.2 Any server-only Next feature blocking static export? — **No (the config flag is now resolved).**

Scanned and **clear**:
- No server actions (`"use server"`) anywhere.
- No route handlers (`app/**/route.ts`).
- No `middleware.ts`.
- No dynamic route segments (`[id]` etc.).
- Every app/component file is `"use client"` except `app/layout.tsx` and
  `app/connect/page.tsx`; the latter only reads `process.env.NEXT_PUBLIC_*` at
  module scope (build-time inlined — safe under export).

**The original `output: "standalone"` blocker is RESOLVED (task #5).**
`next.config.ts` now gates it: `output: isTauri ? "export" : "standalone"`, keyed
on a `TAURI` env var set by the `tauri:dev`/`tauri:build` scripts (inherited by
Tauri's before-commands). The Docker/web build keeps `standalone` untouched.
Verified by frontend-dev: `npm run build` (standalone) and `TAURI=1 npm run build`
(export → `out/`) both pass.

Watch-outs, all checked by frontend-dev:
- `next/image`: **zero** usages in `src` — no impact. `images.unoptimized: true`
  is set under the TAURI branch anyway as a safety net for future `<Image>` use.
- `trailingSlash`: left **unset** (default). Export emits
  `shell.html`/`connect.html`/`login/callback.html` (no trailing slash); the
  callback logic in `auth.ts` uses `startsWith("/login/callback")`, robust either
  way. Flipping `trailingSlash: true` is a knob for rust-dev to try **only** if
  Tauri's `asset://` origin misbehaves at native runtime (their
  `src-tauri`/`frontendDist` territory) — not changed pre-emptively.

### 3.3 Is `crypto-core`'s native (rlib) path usable from Rust today? — **Yes, via `native::*`.**

- `Cargo.toml` declares `crate-type = ["cdylib", "rlib"]`; all `#[wasm_bindgen]`
  exports are inside `#[cfg(target_arch = "wasm32")] mod wasm`, and wasm-only
  helpers (`time::now_ms` web path, `getrandom` `js` feature) are properly
  `cfg`-gated. The pure-Rust modules (`kdf`, `aead`, `generate`, `totp`, `hibp`)
  are `pub` and callable directly. `cargo test` (native) passes 32/32.
- `src-tauri/Cargo.toml` already consumes it as `crypto-core = { path =
  "../crypto-core" }`. `src-tauri/src/lib.rs` registers Tauri commands whose
  names mirror `CONTRACT.md` exactly — the right shape; **the command bodies
  (`commands.rs`/`auth.rs`/`state.rs`) are not yet written** (task #4).

**The original `thread_local!` session blocker is RESOLVED (task #2).** The fix
was the recommended one and it keeps the FFI unchanged:

- `crypto-core/src/native.rs` (`#![cfg(not(target_arch = "wasm32"))]`) is the
  native analogue of the `wasm` module. Its session store is a process-global
  `static OnceLock<Mutex<HashMap<u32, HardenedSession>>>` with a separate
  `Mutex<u32>` handle counter — thread-safe, so a handle minted on one Tauri
  worker thread stays valid for `encrypt_item`/`decrypt_item` on another. Verified
  by `native::tests::native_create_unlock_roundtrip_across_threads`.
- `envelope.rs` **still** uses `thread_local!` for the WASM path (correct — WASM
  is single-threaded). The crypto logic was refactored into store-free fns
  (`envelope::derive_unlocked` / `encrypt_item_with` / `decrypt_item_with` /
  `change_password_with` over `&Unlocked`) so the WASM thread-local store and the
  native global store share **one** implementation — no divergence risk.

> **TRAP for rust-dev (task #4):** on native, do **not** call `envelope::unlock`
> / `envelope::encrypt_item` directly — those use the per-thread WASM store and
> will silently lose the session across Tauri's tokio pool (compiles, passes a
> single-thread unit test, fails at runtime). **`crypto_core::native::*` is the
> supported native entrypoint.**

### 3.4 Other native observations

- **mlock/VirtualLock is now present (task #2):** `crypto-core/src/memlock.rs`
  (`cfg(not(wasm32))`) pins the unlocked data-key region into physical RAM —
  `libc::mlock` on Unix (added `libc` only under `cfg(all(not(wasm32), unix))`),
  `VirtualLock` via an inline `kernel32` decl on Windows (no `region`/`memsec`
  dep). `HardenedSession` boxes `Unlocked` and pins that allocation; zeroize-then-
  `munlock` on drop. Best-effort: an `RLIMIT_MEMLOCK` refusal degrades to
  `LockState::Unlocked` (reported via `native::lock_state()`, never fatal, never
  logged). **Documented limitation:** the stretched wrap key behind `SecretBox`
  is a separate heap alloc — zeroize-on-drop but not separately `mlock`'d; only
  the data key (which decrypts everything) is pinned. Extending the pin to the
  wrap key would be a reasonable follow-up if full coverage is wanted.
- **CSP `connect-src` — RESOLVED + corrected architectural understanding (task
  #4/#8).** `tauri.conf.json` now allows `https://api.pwnedpasswords.com` (HIBP)
  and `http://localhost:3101` (local CSS). **Important correction to my original
  note:** CSP `connect-src` only gates the **webview's own** fetches (e.g. the
  HIBP call in `ItemDetail.tsx`, and the issuer origin for any in-webview auth
  bits). The authed **pod I/O does NOT go through the webview** on native — it
  runs through the `pod_fetch` Tauri command (`src-tauri/src/pod_fetch.rs`,
  `reqwest` in the Rust process), which CSP does not gate. So users' pods on
  **arbitrary hosts work without a CSP entry**; my earlier "connect-src may need
  to be broader" concern is **moot for pod I/O**. The remaining v0 CSP limitation
  (documented in `src-tauri/README.md`) is narrow: only the webview's *own* direct
  fetches need their host allowlisted, and deriving `connect-src` from the
  configured issuer origin is a later-milestone nicety, not a blocker.
- **Native pod-fetch (`pod_fetch.rs`) reviewed — sound, HARD-rules intact.** The
  DPoP key + access token stay in the Rust process; the proof is minted under a
  short session lock and released before the network `await` (Send-correct, key
  never copied out); URL scheme is validated (`http`/`https` only); one DPoP-nonce
  retry per RFC 9449 §8 (no loop); request/response bodies are uniformly base64.
  **Response headers are correctly preserved** as an ordered `Vec<(String,
  String)>` built by iterating `resp.headers()` — so duplicate `Link` headers,
  `content-type`, and `Location` survive (the watch-item I raised for #8 was
  already handled; comments cite the rationale). frontend-dev's #9 rebuilds via
  `new Headers(pairs)` + `append()`, faithful end-to-end.
- **Native auth (PRD-NATIVE §3.1) — was the gating research risk; now SETTLED.**
  Native uses deep-link + PKCE + DPoP via the system browser (`auth.rs`/
  `oidc.rs`), not an embedded webview; `src/lib/platform/` is the seam with
  `ensureSession()`/`session().fetch` preserved. Event/payload contract settled
  (`auth-callback` / `{ ok }`). The only remaining native pod-I/O step is wiring
  `pod-fs.ts` through `getPlatform().pod.fetch` (task #9, blocked on #8 which has
  landed). The N0 spike (task #7) proved the flow.

---

## 4. Cross-cutting quality

- **Pod-fs** correctly accounts for Solid limits (whole-file PUT, no atomic
  move, `no-store` to dodge stale containment triples, recursive `rmrf`).
- **Auth** comments are unusually good — they explain *why* `restorePreviousSession`
  is avoided and *why* single-flight matters. Keep this when abstracting into
  `src/lib/platform/`.
- **Turtle handling** in `model.ts` is hand-rolled regex parse/serialize. Robust
  enough for the controlled `vault.ttl` shape it writes, but it is the most
  fragile spot if the vocabulary grows; a real Turtle parser would be safer
  long-term (non-blocking for v0).
- **`UnlockScreen`** yields to the event loop before the blocking Argon2id stretch
  so the spinner paints — nice touch, but the WASM unlock is synchronous on the
  main thread; a Web Worker would avoid UI jank on high KDF params (future).

---

## 5. Recommended sequencing for the native track

1. ~~crypto-dev: native global-Mutex session store + mlock~~ — **DONE (task #2):
   `crypto_core::native` + `memlock.rs`.**
2. ~~frontend-dev: conditional `output: "export"` + tauri scripts +
   `src/lib/platform/` auth seam~~ — **DONE (task #5):** `output: isTauri ?
   "export" : "standalone"`, `src/lib/platform/` with web (delegates to the
   existing single-flight `auth.ts`, no new redirect call site) and native (maps
   to `auth_start`/`auth_status`) impls; `ensureSession()`/`session().fetch`
   stay the stable interface.
3. ~~rust-dev: native `commands.rs`/`auth.rs`/`state.rs` against
   `crypto_core::native::*`; CSP `connect-src` HIBP host~~ — **DONE (task #4):**
   `src-tauri/src/{commands,auth,oidc,state}.rs` all present; `connect-src` now
   includes `https://api.pwnedpasswords.com` (and `http://localhost:3101` for the
   local CSS issuer) — verified in `tauri.conf.json`.
4. ~~rewire call sites through `getPlatform()`~~ — **DONE (task #6):** auth call
   sites (`ConnectForm`, `app/page`, `app/settings`, `shell/context`,
   `login/callback`) route through `getPlatform().auth`; Vault (`model.ts`,
   `vault/index.tsx`, `ItemDetail`/`ItemEditor`/`PasswordGenerator`) consumes
   `getPlatform().crypto.getCore()`. Single `handleIncomingRedirect` call site
   preserved; `session().fetch` kept as the pod-I/O interface. Verified green
   (typecheck, standalone build, `smoke:vault`).
5. **N0 auth spike (task #7, IN PROGRESS):** native deep-link → PKCE → DPoP →
   authenticated pod read — the gating risk per PRD-NATIVE §6. Reconcile
   `native.rs`↔`auth.rs` when it lands.
6. **Native authed-`fetch` bridge (§3.1) — DECIDED, in progress:** team-lead chose
   the Tauri-command route (DPoP key stays in Rust). Task #8 (rust-dev:
   `pod_fetch` command) → task #9 (frontend-dev: route `pod-fs.ts` through
   `getPlatform().pod.fetch` on native, blocked on #8). Contract: headers as
   `Array<[string, string]>` to preserve duplicate `Link` headers. Last native
   pod-I/O wiring step.
