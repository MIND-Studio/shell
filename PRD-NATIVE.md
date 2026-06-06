# PRD — `shell` Native Track: The Everything App in Your Pocket

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-01
> **One-liner:** Ship the *same* `shell` shell + Vault as a **Tauri** app for
> **mobile (iOS/Android) and desktop**, **mobile-first** — one codebase, one Rust core,
> the hardened crypto path for free, and a vault that actually lives in your pocket.

This is a **companion** to [`PRD.md`](./PRD.md), not a replacement. It covers **only** the
native/mobile-specific concerns. For the shell surface, the Vault app, the pod data model, the
crypto core, and the threat model, **`PRD.md` is authoritative** — this doc points back to it
rather than re-deriving it.

---

## 0. The decision (why this is not a new prototype)

We considered a separate sibling prototype for a Tauri/mobile app and **rejected it**. Tauri's
model is "Rust backend + system-webview frontend," so a Tauri build of this shell *is the existing
Next.js frontend wrapped*, with `crypto-core/` serving as the native backend instead of being
compiled to WASM. Forking would mean duplicating or cross-importing the shell, Vault, and crypto
core between siblings — fighting the workspace's "independent siblings explore *different things*"
convention for no gain.

**Decision (2026-06-01):** Tauri is a **first-class delivery target inside `shell`**, not a
sibling. `PRD.md` already commits to this in spirit — *"ship the same Rust core to both"* (`PRD.md`
§5.5) — and lists it as M6. This doc **promotes** that from "stretch sidecar" to a real,
mobile-first track, and owns the native problems M6 hand-waved.

What changes vs `PRD.md`'s "out of scope for v0":
- **Mobile** moves from out-of-scope to the *headline* target.
- **Browser-extension autofill** stays out; **native OS autofill** (iOS/Android) comes in.
- The web shell at `shell.mindpods.org` remains the primary in-pod surface; native is an
  **additional** delivery of the same code, not a migration off the web.

In-house precedent: `compass/` (root workspace) is already a Tauri (Rust) desktop app — reuse its
build/signing patterns and lessons.

---

## 1. Why mobile-first is *correct* (not a stretch)

A password manager's dominant real-world use is **autofill on a phone**. A desktop-first vault that
treats mobile as an afterthought is backwards. Mobile-first also forces the right constraints early:
touch targets, biometric unlock as the default unlock, offline-first, and a tight app body that the
desktop layout is then a superset of — not the reverse.

The flagship demo gets *stronger*, not weaker, on mobile: "your secrets live in **your** pod,
encrypted by a Rust core that runs **on your device** with real OS-grade key protection, and you
autofill them into any app" is the most legible privacy-first story we can ship.

---

## 2. The big architectural win: the hardened crypto path comes for free

`PRD.md` §5.5 frames a tradeoff: WASM is convenient but lacks `mlock`, has weaker memory-copy
control (JS/GC heap), weaker constant-time guarantees, and lives on the XSS surface. The native
build **resolves every one of those** without changing the FFI contract:

| Concern (WASM caveat, `PRD.md` §5.5 / §8) | Native (Tauri + Rust core) |
|---|---|
| No `mlock` (keys can hit swap) | Real `mlock`/`VirtualLock` in the Rust process |
| Weak memory-copy control (GC heap) | Keys stay in native Rust memory; `zeroize` is meaningful |
| No constant-time guarantee (WASM spec) | Native codegen + AES-NI; `subtle` behaves as intended |
| Keys reachable via XSS in the webview | Crypto runs in the **Rust process**, not the webview — JS can't read it |

Crucially, **the FFI contract does not widen** (AGENTS.md HARD rule #1; `crypto-core/CONTRACT.md`).
On native, the "opaque session handle" stops being a WASM linear-memory handle and becomes a handle
into a separate Rust process the webview cannot inspect — strictly *better* isolation, same surface.
Plaintext/keys still never cross into JS. `create_vault`, `unlock`, `encrypt_item`/`decrypt_item`,
`change_password`, `rotate_keys`, `generate_password`, `totp_code`, `hibp_prefix` are unchanged.

**Build shape:** `crypto-core/` is already a dual-target crate (cdylib for wasm + lib for native —
`PRD.md` §7 directory shape). The web shell calls it via `wasm-bindgen`; the Tauri shell calls the
*same crate* via Tauri commands (`#[tauri::command]` wrappers). One audited crate, two bindings.

---

## 3. The hard problems this track must own

These are the things M6 waved off. Each is flagged with a confidence/risk marker:
**[H]** well-understood, **[M]** vendor-documented path, **[!]** genuine research risk.

### 3.1 Solid OIDC in a native webview — **[!]** the single biggest risk

The web shell's single-flight `handleIncomingRedirect` (AGENTS.md HARD rule #3; `src/lib/solid/
auth.ts`) assumes **browser** redirect semantics. Native is different:

- The OIDC redirect must return to the app via a **custom URL scheme / deep link** (e.g.
  `mindshell://auth/callback`) or platform auth sessions (`ASWebAuthenticationSession` on iOS,
  Custom Tabs / `androidx.browser` on Android) — **not** an in-app webview, which breaks IdP cookie
  SSO and is increasingly rejected by providers.
- `@inrupt/solid-client-authn-browser` was **not** designed for custom-scheme callbacks. We likely
  need `solid-client-authn-node` driving a native flow, or a thin custom DPoP/PKCE handler over the
  CSS OIDC endpoints, with the callback delivered by Tauri's deep-link plugin.
- The "silent re-auth across siblings" SSO benefit (the shared `pod.mindpods.org` issuer) depends
  on the IdP seeing its cookie — which a system browser / `ASWebAuthenticationSession` *can*
  provide but an embedded webview cannot.

**This must be the first spike.** Everything else assumes a signed-in session. Recommend a
throwaway proof: native deep-link → PKCE → DPoP-bound token → authenticated pod read, before any UI.

### 3.2 OS autofill — **[M]**

Native autofill lives **outside the webview**, in a separate OS-provided extension process:
- **iOS:** AutoFill Credential Provider Extension (ASCredentialProviderViewController).
- **Android:** Autofill Framework (`AutofillService`) and/or Credential Manager.

Both need the **Rust core reachable from the extension process** to decrypt the requested credential
on demand — the extension can't share the main app's unlocked in-memory session trivially. Options:
a shared keychain/keystore-wrapped session key, or re-unlock-with-biometric inside the extension.
This is platform-specific glue beyond Tauri and is a notable scoping cost — candidate for a later
milestone, not v0-native.

### 3.3 Biometric unlock — **[M]**

Mobile-first unlock should be **Face ID / Touch ID / Android BiometricPrompt**, not re-typing the
master password each time. Pattern: the master-password-derived key wraps a **device unlock key**;
the device unlock key is stored in the **Secure Enclave / Android Keystore**, released only on
biometric success, and used to unwrap the vault session. The master password remains the root of
trust (and the only recovery path) — biometrics are a convenience cache, never a second secret that
leaves the device. Tauri has a biometric plugin; the key-wrapping logic belongs in `crypto-core`.

### 3.4 Offline-first + sync — **[M]**

Phones go offline; "pod is the source of truth" (AGENTS.md HARD rule #2) needs a **local encrypted
cache** of `items/{itemId}.enc` + the non-secret index, with sync-on-reconnect and conflict
handling (last-writer-wins per item is acceptable for v0; surface conflicts rather than silently
dropping). The cache stores **ciphertext only** — never plaintext to disk (HARD rule #2). The
existing `better-sqlite3` in-memory index pattern (`PRD.md` §7) becomes a persisted *ciphertext*
cache on native.

### 3.5 Distribution & crypto export — **[M]**

App Store / Play Store review, code signing (Apple Developer + Android keystore), and **export
compliance declarations** for shipping cryptography. Standard but real overhead; needs to be in the
plan, not discovered at submission. Desktop adds notarization (macOS) and installer signing.

### 3.6 CSP & webview hardening — **[H]**

Native removes the open-web XSS exposure but the webview still renders our UI: keep the strict CSP
(`PRD.md` §8), disable Tauri APIs the frontend doesn't need (capability allowlist), and never expose
a Tauri command that returns plaintext/keys (mirrors the FFI rule).

---

## 4. Frontend strategy (decided: reuse the web shell)

Per scope decision, the native app **reuses the `shell` Next.js frontend**, made responsive
and touch-first — one frontend codebase. Implications:

- The shell chrome (workspace rail, project switcher, waffle, account switcher, app menu, app body —
  `PRD.md` §1) needs **mobile layouts**: the rail collapses to a drawer/bottom-sheet, the waffle
  becomes a full-screen launcher, the app body is single-column.
- Tauri serves the built static frontend (or the dev server in dev). Next.js must export in a
  Tauri-compatible mode — verify SSR/server-action usage; native runs without a Node server, so the
  shell's pod I/O must be **client-side** (it already is, per the single-flight browser auth model —
  but the native auth swap in §3.1 changes this).
- Platform branches (deep-link auth, biometric, autofill bridge) live behind a thin
  `src/lib/platform/` abstraction: `web` impl (current) vs `native` impl (Tauri commands). The
  shell and Vault UI stay platform-agnostic.

---

## 5. Directory additions

Additive to `PRD.md` §7 — nothing existing moves:

```
shell/
  src-tauri/                  ← NEW: Tauri shell (Rust)
    Cargo.toml                  depends on ../crypto-core (path) for native crypto
    tauri.conf.json             windows/mobile config, deep-link scheme, capability allowlist
    src/
      main.rs                   command registration, session handle, mlock setup
      commands.rs               #[tauri::command] wrappers over crypto-core (same FFI surface)
      auth.rs                   native OIDC: PKCE + DPoP + deep-link callback (§3.1)
    capabilities/               per-window capability allowlists (least privilege)
    gen/                        iOS/Android project scaffolds (tauri ios/android init)
  src/lib/platform/           ← NEW: web vs native abstraction (auth, biometric, autofill, storage)
  crypto-core/                  (unchanged — now also consumed as a native path dep)
```

---

## 6. Milestones (native track — sequenced after `PRD.md` M0–M4)

The web shell + Vault (`PRD.md` M0–M4) must exist first; this track wraps and hardens it.

1. **N0 — Auth spike [!].** Prove native deep-link → PKCE → DPoP → authenticated pod read on one
   platform. No UI. *Gate: if this doesn't work cleanly, the whole track re-plans.*
2. **N1 — Tauri desktop shell.** `src-tauri/` wraps the existing frontend on desktop; `crypto-core`
   wired as a native command (not WASM); `mlock` + native zeroize verified. Sign-in via N0 flow.
3. **N2 — Native crypto parity.** All `crypto-contract.ts` operations run through Tauri commands on
   native, KATs pass identically to the WASM path; confirm no plaintext/keys cross the command
   boundary (capability + manual audit).
4. **N3 — Mobile shell.** `tauri ios/android init`; responsive shell layouts (drawer rail,
   full-screen waffle, single-column body); runs on a device/simulator; offline ciphertext cache
   (§3.4).
5. **N4 — Biometric unlock.** Secure Enclave / Keystore device-key wrapping (§3.3); master password
   remains recovery root.
6. **N5 — OS autofill (stretch).** iOS Credential Provider + Android Autofill, decrypting via the
   core from the extension process (§3.2).
7. **N6 — Ship.** Signing, notarization, store submission + export-compliance (§3.5); TestFlight /
   internal track.

---

## 7. Success criteria (native)

- Sign in once on a phone via the **system auth flow** (not an embedded webview), land in the
  shell, and read a Vault item — all offline-capable after first sync.
- Create an item on the phone; confirm **only ciphertext** is written to the pod **and** to the
  local cache (inspect both raw — no plaintext); decrypt it on the web shell on another device using
  the stored KDF params (cross-surface, cross-impl parity).
- Unlock via biometric; master-password change still re-wraps without re-encrypting items.
- Keys never appear in the webview process; a Tauri capability audit shows no command returns secret
  types; `cargo audit`/`cargo-deny` pass for the native build.

---

## 8. Open questions / decisions to make

1. **Native auth library [!].** Adapt `solid-client-authn-node`, or write a thin PKCE/DPoP client
   against the CSS OIDC endpoints? Decide after the N0 spike.
2. **Autofill scope.** Is OS autofill (§3.2) in the first shipped native version, or a fast-follow?
   It's the highest-value mobile feature but the heaviest platform glue.
3. **Mobile shell scope.** Full shell on mobile, or does mobile **launch into Vault first** with the
   rest of the shell behind the waffle? (You leaned "reuse the full shell," but Vault-first launch is
   still a UX option.)
4. **Next.js export mode.** Confirm the shell can run as a static/CSR bundle inside Tauri with no
   server-side dependencies (server actions, RSC data fetching) — audit before N1.
5. **Sync conflict policy.** Last-writer-wins per item vs surfaced conflicts vs CRDT — start with
   LWW + visible conflict marker (§3.4)?
6. **Desktop-vs-mobile release ordering.** Desktop (N1–N2) is the lower-risk warm-up; mobile (N3+)
   is the actual goal. Ship desktop interim, or hold until mobile is ready?

---

## 9. Provenance

- **`PRD.md`** (this prototype) — authoritative for shell, Vault, crypto core, pod data model,
  threat model. This doc defers to it for all of those.
- **`crypto-core/CONTRACT.md`** — the FFI surface this track reuses unchanged on native.
- **Tauri 2** — stable cross-platform (desktop + iOS/Android) with the system webview; deep-link and
  biometric plugins; capability-based security model. In-house reference: `compass/` (root
  workspace) is a shipped Tauri app — reuse its build/signing patterns.
- **Solid native auth [!]** — `@inrupt/solid-client-authn-{node,browser}`; OIDC PKCE + DPoP. The
  custom-scheme callback path is **underexplored in the Solid ecosystem** — treat as a spike, not an
  assumption.
- **Platform autofill [M]** — Apple ASCredentialProvider; Android Autofill Framework / Credential
  Manager (vendor docs; verify current APIs before N5).
