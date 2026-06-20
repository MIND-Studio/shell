# PRD — `shell`: The Mind "Everything App" Shell + Vault

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-01
> **One-liner:** A Dock-style shell that wraps identity and hosts every Mind app on one
> surface — shipping with **Vault**, a zero-knowledge password manager whose crypto core
> is written in secure Rust (compiled to WASM, with a native sidecar path).

This PRD is a **validated synthesis** of four parallel research sweeps run on
2026-06-01: (1) the existing `mind-prototypes` conventions, (2) the Mind protocol spec in
`architecture/`, (3) the live `mindpods.org` deployment, and (4) 2025/2026 best practice for
secure password-manager crypto in Rust. Sources and confidence flags are in §12.

---

## 1. Vision & scope

Today the Mind prototypes are **independent sibling apps** (drive, builder, codespaces, dock…),
each its own Next.js surface. The architecture spec already names the missing layer that ties them
together — **the Dock shell** — but no prototype implements it in full. `dock` is a
*front-door launcher* (a grid of app tiles); it has **no workspace rail, no project switcher, no
in-app waffle**.

`shell` builds that shell, faithfully to the wireframe and to the protocol, and proves it
out by hosting one genuinely demanding app inside it: **Vault**, an end-to-end-encrypted password
manager. Vault is the right flagship because it stress-tests the hardest protocol guarantees at
once — *the pod is the source of truth*, *the host never sees plaintext*, *secrets are scoped by
WAC* — and it is the most legible "why privacy-first matters" demo we can ship.

**Two layers, one prototype (per scope decision 2026-06-01):**

| Layer | What it is | Maps to |
|---|---|---|
| **Shell** | The identity-wrapping surface: workspace rail, project switcher, app switcher (waffle), app menu, app body, account switcher | `architecture/src/apps.md` → "Dock"; the supplied wireframe |
| **Vault** | The flagship hosted app: a zero-knowledge password manager with a Rust crypto core | A *sandboxed app* per `architecture/src/protocol/01-pod-layout.md` |

**Out of scope for v0:** cross-pod secret sharing standardization, browser-extension autofill,
mobile, Vault team/org sharing beyond a single WAC-grant demo, and replacing `dock`
(the shell is a *new exploration*, not a migration — see §11).

---

## 2. Background: what we are building **on top of**

### 2.1 The Mind protocol (`architecture/`) — the load-bearing facts

The shell is not a UI invention; the protocol already specifies it. Quoting the canonical docs:

- **Four nested primitives** (`architecture/src/protocol/01-pod-layout.md`, `CONTEXT.md`):
  - **Account** — *"one email/password credential carrying exactly one WebID and one personal
    Workspace."* A human may hold several Accounts; switching Account switches **both identity and
    data**. → the wireframe's **account switcher**.
  - **WebID** — *"the single, stable URI others grant you access by."* One per Account, reused
    across every Workspace (decision `0006`).
  - **Workspace** — *"the primary organisational unit and long-lived home for data"* = a Solid Pod
    with the MIND folder structure. The thing apps are *enabled in*. → the wireframe's **workspace
    rail** (each rail icon = a Workspace the Account owns/joined).
  - **Project** — *"an optional scope inside a Workspace: a subfolder `/projects/{id}/` with its own
    permissions."* → the wireframe's **project switcher** ("Product" in the mock).

- **The Dock shell is explicitly defined** (`architecture/src/apps.md`):
  > *"Sign in once with your WebID and land here: your Accounts and Workspaces, the current Project,
  > and every app enabled in that Workspace as a tile… Dock is the front door — and it is **not an
  > app**. It's the shell that wraps identity."*

  It has **two faces**: the **desktop** (full home surface) and the **waffle** (compact app-grid in
  every app's navbar). Dock discovers apps by *"reading which apps are enabled in the current
  Workspace — joining the `/apps/` zone… against a registry of known Mind apps (name → hosted URL →
  icon)."* Pin/reorder/hide layout is Dock's **own** state at `/apps/dock/`.

- **App data model** (`01-pod-layout.md`):
  - **Sandboxed apps** keep data in `/apps/{name}/`; other apps can't read it without a grant. **←
    Vault is a sandboxed app.**
  - **Domain surfaces** read/write a shared top-level container (`/calendar/`, `/contacts/`).
  - The workspace-wide view of an app is **computed, not stored**: the union of
    `/apps/{name}/ ∪ /projects/*/apps/{name}/`, evaluated under the requester's own credentials (so
    no-access projects simply don't appear — no leakage).
  - **Vocabulary:** `@prefix mind: <https://mind.dev/ns/v1#>`; reuse `schema:`, `as:`, `vcard:`,
    `ical:`, `ldp:`, `solid:`.

- **Identity & security** (`architecture/src/architecture.md`, decision `0001`):
  - WebID/Solid-OIDC sign-in: *"Your password (or passkey) never touches the app — only your pod
    host sees it."*
  - **Two-session split** (`decisions/apps/dock/0001`): everyday **WebID session in the browser**;
    the **CSS account session server-side only, encrypted, never logged**.
  - **End-to-end encryption** is a first-class, app-layer concern: *"Apps that need it (Chat) can
    layer per-conversation keys on top — the protocol doesn't define the key exchange."* → **Vault
    owns its own key hierarchy; the protocol does not dictate it.**

- **Four governance tenets** (`architecture.md`) the shell + Vault must honor:
  1. **Pod is the source of truth** (no "export" feature — nothing is held hostage).
  2. **Workers are replaceable.**
  3. **Protocol over plumbing** (a spec, not a shared lib — *"a Rust app and a Python worker can
     speak to the same pod without importing each other's code"* — directly licenses our Rust core).
  4. **Coordinate through data** (components sync via pod reads/writes, not RPC).

### 2.2 The prototype conventions we must match

From the survey of `drive`, `dock`, `builder`, `mind-shared-ui`:

- **Stack (pinned):** Next.js **16.2.6**, React **19.2.4**, `@inrupt/solid-client` **^3.0.0** +
  `solid-client-authn-{browser,node}`, Tailwind **v4** (no config file), `better-sqlite3` for
  local indexer caches, `tsx scripts/*.ts` for seed/smoke.
- **Login:** the shared **`MindLoginCard`** from **`@mind-studio/core`** (the `mind-shared-ui`
  tarball — *never* a `file:` symlink; Turbopack rejects out-of-root symlinks). Exports:
  `.` (login), `./apps` (the `apps.ttl` registry helpers), `./launcher` (`MindAppLauncher` grid).
  After editing shared UI run `mind-shared-ui/scripts/sync.sh`.
- **Default OIDC issuer:** `https://pods.mindpods.org/` (override via `NEXT_PUBLIC_SOLID_ISSUER`).
  One issuer ⇒ silent re-auth across siblings.
- **The OIDC single-flight rule (non-negotiable):** `handleIncomingRedirect` must be memoized to a
  module-level promise and called **exactly once** — otherwise the one-time auth code is redeemed
  twice and the user lands signed-out. Reference impl: `drive/src/lib/solid/auth.ts:78`.
  *(`mind-dock`/`mind-builder` are flagged at-risk; the shell must single-flight from day one.)*
- **Pod I/O:** POSIX-shaped wrappers over LDP (`drive/src/lib/solid/pod-fs.ts`). Known
  Solid limits to design around: **no atomic move/rename** (copy+delete, ACLs don't follow), **no
  atomic recursive delete**, **slug is advisory** (read `Location`), **default Content-Type is
  `application/octet-stream`** (always pass it), **no server-side search/versioning/trash**.
- **Hard rules:** *never invent a central database for user data* (pod is truth; SQLite is a
  local, per-device cache only); *never send secret bytes to our backend*; *don't unify siblings.*
- **GitHub Packages:** `.npmrc` scopes `@mind-studio` → `npm.pkg.github.com`; `NODE_AUTH_TOKEN`
  (read:packages PAT) needed before `npm install`.

### 2.3 The live deployment (`mindpods.org`) we must slot into

`mindpods-infra` went **live 2026-05-31** (clean cutover off `*.duckdns.org`). Single Hetzner VM
(`37.27.80.161`, SSH `mind-codespaces`), one Caddy edge, 8 containers. Live hosts: apex (landing),
`dock.`, `drive.`, `builder.`, `codespaces.` (git-bridge), **`pods.mindpods.org` = CSS v7 = the
OIDC issuer**. Greenfield pod (`seed.json` empty); self-signup via the bridge.

**To add `shell` as `shell.mindpods.org`** (pattern from `docs/APP-DOCKERFILE.md`):
1. App repo: `output: "standalone"` in `next.config.ts`; prod `Dockerfile` (`node:22-alpine`,
   BuildKit `npm_token` secret for `@mind-studio/*`, NEXT_PUBLIC as **build-args**); `.npmrc`;
   `.github/workflows/release.yml` (`IMAGE_NAME: mind-shell`).
2. Bake all sibling launcher URLs as build-args: `NEXT_PUBLIC_APP_{DOCK,DRIVE,BUILDER,CODESPACES}_URL`.
3. Add a `mind:App` tile for the shell/Vault to `mind-shared-ui/src/apps/catalog.ts` → `DEFAULT_APPS`
   (static `process.env.NEXT_PUBLIC_APP_*_URL` — Next won't inline dynamic keys), publish a new
   `@mind-studio/core`, bump consumers.
4. Infra: Caddy vhost `reverse_proxy shell:3000`, service in `compose.yml`
   (`HOSTNAME=0.0.0.0`/`PORT=3000`), `MIND_SHELL_IMAGE` in `images.env`, DNS A record.
5. Tag → CI pushes image + prints `@sha256` → paste digest into box `images.env` → `deploy.sh`.

**Deploy gotchas to honor:** `NEXT_PUBLIC_*` is **build-time-inlined** (domain change = rebuild,
not compose edit; hard-reload tabs after); a Caddyfile-only change needs
`up -d --force-recreate caddy` (single-file bind-mount inode trap); GHCR images are private (box
uses `ghcr.env` PAT); `workflow_dispatch` builds committed HEAD (commit build-arg edits first).

---

## 3. The Shell — product spec

The shell is the surface in the wireframe. Mapping each labelled region to a protocol primitive and
a data source:

```
┌──┬─────────────────┬───────────────────────────────────────┐
│  │ ▼ Product       │                                        │   Workspace rail  → Workspaces the
│🐔│  (project)      │                                        │     Account owns/joined (rail icons)
│H │ 👤 Drive   [⊞]  │                                        │   Project switcher → /projects/{id}/
│B │  (current app)  │            App Body                    │   App switcher [⊞] → the "waffle"
│▌S│                 │       (active app's main view)         │   App menu        → active app's nav
│M │  App Menu       │                                        │   App body        → active app surface
│  │                 │                                        │   Account switcher → Accounts (WebIDs)
│+ │─────────────────│                                        │
│⚙ │ 🐔 S. Heusser ▲ │                                        │
└──┴─────────────────┴───────────────────────────────────────┘
```

| Wireframe region | Behaviour | Source of truth |
|---|---|---|
| **Workspace rail** (left) | Vertical list of Workspaces; click to switch; active one ringed. `+` creates a Workspace; ⚙ opens Workspace settings. | Workspaces the current Account owns or was WAC-granted into (each is a pod). Membership in `workspace.ttl`. |
| **Project switcher** (top) | Dropdown of Projects in the current Workspace (+ "All / no project"). | `/projects/*/project.ttl` |
| **Current app + App switcher (waffle ⊞)** | Shows active app; the waffle opens the app-grid (`MindAppLauncher`) to jump apps without leaving the shell. | Apps enabled in the Workspace = `/apps/` zone joined against the catalog. Layout state in `/apps/shell/`. |
| **App menu** | The active app's own left-nav, rendered by the app. | Per-app. |
| **App body** | The active app's main surface, rendered by the app. | Per-app. |
| **Account switcher** (bottom) | Current Account + dropdown to switch/add Account, account settings, light/dark, logout. | Accounts = WebIDs the user has signed into (multi-account, like the mock's two "Sebastian Heusser"). |

**Shell ↔ app embedding model (key v0 decision — see §11):** v0 hosts apps as **first-party
in-process surfaces** (the shell renders the app's React tree directly), starting with Vault. The
shell exposes a small context (`useShell()` → current WebID, workspace pod root, project, authed
`fetch`) so an app reads/writes its own `/apps/{name}/` zone. A later iteration can host *external*
apps via `<iframe>` + `postMessage` against their hosted URLs (the `mindpods.org` subdomains) — out
of scope for v0.

**Shell's own pod state** (`/apps/shell/` per the protocol's "Dock layout is its own state"):
- `layout.ttl` — pinned/ordered/hidden app tiles, theme preference.
- `recents.ttl` — recent apps/projects for the desktop face.

---

## 4. Vault — product spec (the flagship app)

**Vault** is a zero-knowledge password manager. The encrypted vault lives in the user's pod under
`/apps/vault/`; **all** crypto happens client-side in a Rust core; the pod host and any worker see
only ciphertext, wrapped keys, KDF params, and salt.

### 4.1 User-facing features (v0)

- **Unlock:** master password → Rust core derives the key (Argon2id) → unwraps the vault data key.
- **Items:** logins (URL, username, password, notes, TOTP), secure notes, cards. Per-item encryption.
- **Generate:** CSPRNG password & diceware passphrase generator (configurable length/classes).
- **Auto-lock:** on idle/blur/screen-lock; locking **zeroizes** in-memory keys.
- **Clipboard:** copy with auto-clear (~30 s), restoring prior contents.
- **Breach check:** HIBP **k-anonymity** range API — SHA-1 locally, send only the 5-char prefix.
- **TOTP:** RFC 6238 codes for items that store an `otpauth://` seed.
- **One sharing demo:** WAC-grant a single item-folder (e.g. `github/`) read access to another
  WebID/app, proving folder-scoped sharing (no per-item ACL bookkeeping in v0).

### 4.2 Vault pod data model (`/apps/vault/`)

```
/apps/vault/
  manifest.ttl        # mind:App self-declaration (name, icon, hosted URL) for Dock discovery
  vault.ttl           # public, non-secret metadata: KDF params, salt, wrapped vault data key,
                      #   schema version, item index (item IDs + non-secret labels/URLs ONLY)
  items/
    {itemId}.enc      # AEAD ciphertext of one item; wrapped per-item key + nonce + AAD(itemId,ver)
```

- **Nothing secret is ever stored in plaintext** — not even item titles if the user opts into
  "hide names" (then `vault.ttl` holds opaque IDs only). Default v0: titles/URLs in the index are
  cleartext for search; passwords/notes/TOTP seeds always encrypted. *(Flag: this is the 1Password
  vs "hide everything" tradeoff — see §11.)*
- **Local SQLite cache** (`.vault-data/`, gitignored) indexes decrypted titles for fast search
  **in memory only**; never persists plaintext to disk. Pod remains the source of truth.

---

## 5. The secure Rust crypto core (validated brief)

The core is the heart of Vault and the reason this prototype exists. It compiles to **WASM** for the
in-pod web experience and to a **native lib** for an optional hardened sidecar. **One audited
codebase, two targets.**

### 5.1 Key derivation — Argon2id

- **Algorithm: Argon2id** (RFC 9106; OWASP first choice). Hybrid resists both GPU/ASIC brute force
  (memory-hard) and side-channel timing. **Not** PBKDF2 (time-hard only; ~100× cheaper to crack),
  bcrypt (≤4 KiB, 72-byte input cap), or scrypt (acceptable fallback only).
- **Parameters — calibrated, not fixed (sources deliberately disagree, see §12 flag):** a vault
  unlock is a *local, interactive, once-per-session* op, so we go well above OWASP's *login-server*
  baseline (m=19 MiB, t=2, p=1 — our absolute floor). **Default toward RFC 9106's "second
  recommended" zone: m ≥ 64 MiB, t=3, p=4**, then **calibrate at runtime to a ~0.5–1 s unlock** on
  the user's device and **store the chosen params in `vault.ttl`** so any device can reproduce them.
  Salt = 128-bit random; derived key = 256-bit.
- **Flow (Bitwarden-style, but Argon2id by default — not their PBKDF2-600k default):**
  master password + salt → Argon2id → **Master Key (256-bit)** → HKDF-expand → **Stretched Master
  Key** (separate enc/MAC subkeys). The master/stretched key never leaves the device, is never
  stored.

### 5.2 Vault encryption & envelope/key-wrapping

- **Envelope encryption:** a random 256-bit **vault data key** (CSPRNG) encrypts content; it is
  **wrapped** by the stretched master key and stored in `vault.ttl` (= Bitwarden's "Protected
  Symmetric Key" / 1Password's key hierarchy).
- **Master-password change is cheap:** re-derive the KDF key and **re-wrap** the data key only —
  bulk ciphertext untouched. (Full *key rotation* = new data key + re-encrypt everything is a
  separate, explicit, heavier operation.)
- **AEAD cipher: XChaCha20-Poly1305** (preferred over AES-256-GCM). Decisive reason: a **192-bit
  nonce** makes **random nonces safe indefinitely** — critical when multiple devices write to the
  pod with no shared nonce counter. AES-256-GCM's 96-bit nonce is catastrophic on reuse and hits
  birthday risk ~2³². (Throughput is irrelevant for a vault.) **Do not** copy the legacy
  AES-CBC+HMAC that Bitwarden/KeePassXC still default to — padding-oracle class; AEAD verifies the
  tag before decrypting.
- **Per-item keys:** each item gets its own key, wrapped by the vault data key (two-level
  hierarchy). Bounded blast radius, selective sharing, small sync diffs, no whole-vault decrypt to
  read one item. **Bind per-item AAD** (`itemId` + version) to prevent ciphertext-swapping.
- **Optional 1Password-style "Secret Key":** a high-entropy second secret combined with the master
  password so pod-stolen ciphertext is uncrackable even against a weak master password — strong fit
  for the pod model where the blob is comparatively exposed. *(Consider for v0.2.)*

### 5.3 Memory hygiene in Rust

- **`zeroize`** — volatile-write + compiler-fence wipes that aren't optimized away;
  `#[derive(ZeroizeOnDrop)]`. **Documented limits to honor:** no defense vs hardware/µarch side
  channels; for `Vec`/`String` it can't erase copies left by reallocation/moves — so **pre-allocate
  and prefer fixed-size arrays for keys**.
- **`secrecy`** — `SecretBox`/`SecretString` (the old bare `Secret` was renamed); access only via
  `ExposeSecret`, blocks `Debug`/logging/serde. Wrap master key, derived keys, decrypted secrets.
- **`subtle`** — constant-time comparison (`ConstantTimeEq`) for any secret comparison; never `==`.
  (AEAD tag verification in the AEAD crates is already constant-time.)
- **`mlock`/`VirtualLock`** (via `region`/`memsec`) to pin key pages out of swap — **native only;
  unavailable in WASM** (flag as a native-sidecar advantage).

### 5.4 Crate choices (audit status noted)

- **Use (RustCrypto):** `argon2`; **`chacha20poly1305`** (XChaCha20Poly1305 — *NCC Group audit, no
  significant findings*); `aes-gcm` (also NCC-reviewed 2020); `zeroize`, `secrecy`, `subtle`;
  `rand`+`OsRng`/`getrandom` for CSPRNG; `totp-rs`; a maintained Shamir crate.
- **Acceptable alt:** `dryoc` (pure-Rust libsodium-compatible).
- **Avoid:** `sodiumoxide` (deprecated, **RUSTSEC-2021-0137**), `rust-crypto`
  (**RUSTSEC-2016-0005**), `ring` for this use (no Argon2/XChaCha20 + maintenance churn), and any
  unaudited hobby crypto. Run **`cargo audit`/`cargo-deny`** in CI as a standing control.

### 5.5 Architecture & the WASM-vs-native tradeoff

- **Zero-knowledge invariant:** encrypt/decrypt only client-side in the Rust core; only ciphertext +
  wrapped keys + KDF params + salt reach the pod. The Solid server is an **untrusted store**.
- **Tiny FFI boundary** — plaintext secrets and raw keys **never** cross into JS. The core exposes:
  `derive_key`, `unlock`, `encrypt_item`/`decrypt_item`, `change_password (rewrap)`, `rotate_keys`,
  `generate_password`, `totp_code`, `hibp_prefix`. JS receives only ciphertext, non-secret outputs,
  or short-lived display values.
- **WASM (default for the web shell):** zero install, runs in every Solid surface. **Caveats to
  document:** no `mlock`; weaker memory-copy control (JS/GC heap); weaker constant-time guarantees
  (stock WASM isn't timing-safe by spec); exposed to the browser/XSS surface → **strict CSP** is
  mandatory.
- **Native sidecar (Tauri, hardened path):** real `mlock`, AES-NI, full constant-time, process
  isolation JS can't read. Heavier to distribute.
- **Recommendation:** ship the **same Rust core** to both; WASM is the convenient in-pod path
  (with caveats + strict CSP), the Tauri sidecar is the hardened desktop path.

---

## 6. Pod data model (combined)

```
{workspacePod}/
  profile/card#me           # WebID (FOAF/vCard) — name, avatar (shell account switcher)
  workspace.ttl             # members + roles (owner/member/guest) → workspace rail + settings
  apps/
    shell/                  # the shell's OWN state (layout, recents, theme)
      layout.ttl
      recents.ttl
    vault/                  # the Vault app — sandboxed, zero-knowledge
      manifest.ttl
      vault.ttl             # KDF params, salt, wrapped data key, non-secret item index
      items/{itemId}.enc    # per-item AEAD ciphertext + wrapped per-item key
  projects/{id}/
    project.ttl             # project members + roles → project switcher
    apps/vault/…            # (future) project-scoped vault items; union-computed view
```

Vocabulary: `mind: <https://mind.dev/ns/v1#>`, reusing `schema:`/`vcard:`/`as:`/`ldp:`/`solid:`.

---

## 7. Tech stack & local conventions

| Concern | Choice |
|---|---|
| Framework | Next.js **16.2.6** (App Router, Turbopack), React **19.2.4** |
| Styling | Tailwind **v4** (`@tailwindcss/postcss`, no config); `@mind-studio/ui` design system; accent **TBD** (suggest indigo `#6366f1` to distinguish from siblings) |
| Solid | `@inrupt/solid-client` ^3, `solid-client-authn-{browser,node}`; single-flight `handleIncomingRedirect` |
| Login | `MindLoginCard` from `@mind-studio/core` (tarball + `sync.sh`) |
| Crypto | **Rust core** → `wasm-bindgen`/`wasm-pack` → loaded by the Vault app; optional Tauri native sidecar |
| Local cache | `better-sqlite3` (`.vault-data/`, in-memory plaintext index only, gitignored) |
| Scripts | `tsx scripts/*.ts` (`seed:demo`, `smoke:*`) |
| Dev port | **3100** · CSS port **3101** (free; beyond landing's 3090) |
| OIDC issuer | default `https://pods.mindpods.org/`; local override `http://localhost:3101/` |

**Directory shape (to scaffold next, matching siblings):**
```
shell/
  PRD.md                      ← this file
  AGENTS.md  CLAUDE.md (@AGENTS.md)  README.md
  package.json  next.config.ts  tsconfig.json  postcss.config.mjs  .npmrc  Dockerfile
  docker-compose.yml  infra/css/
  crypto-core/                ← Rust crate (cdylib for wasm + lib for native), cargo audit in CI
    Cargo.toml  src/lib.rs
  src/
    app/ (layout, page, /login/callback, /shell, /settings)
    components/ (WorkspaceRail, ProjectSwitcher, AppSwitcher/waffle, AccountSwitcher, AppMenu, AppBody)
    apps/vault/ (the flagship app surface, consuming the wasm crypto core)
    lib/solid/ (session, auth single-flight, pod-fs)
    lib/shell/ (workspace/project/app context — useShell())
    lib/vault/ (wasm bindings, item model)
  scripts/ (seed-demo.ts, smoke-*.ts)
  state dirs (gitignored): .css-data/ .vault-data/ .next/
```

---

## 8. Security threat model (summary)

- **In scope:** untrusted pod host / network (sees only ciphertext); stolen pod blob (resisted by
  Argon2id + envelope encryption, optionally a Secret Key); device idle exposure (auto-lock +
  zeroize); clipboard leakage (auto-clear); breach exposure (HIBP k-anonymity, password never
  leaves device).
- **Residual / documented:** XSS in the web surface can reach decrypted secrets while unlocked →
  **strict CSP, no third-party scripts, single-flight auth, audit deps**; WASM weakens
  memory/constant-time hygiene vs native (hence the sidecar path); clipboard history managers can
  still capture copies; `zeroize` doesn't defend hardware side channels or guarantee no realloc
  copies.
- **Trust floor (governance, not a bug):** you can't beat "trust your pod host or self-host" — the
  host holds the encrypted blob and the account credentials. Stated plainly per the architecture's
  honesty about pod-host trust.
- **Process control:** independent crypto review before any real-data use; `cargo audit` + `npm
  audit`/`cargo-deny` in CI; never log secret types.

---

## 9. Milestones

1. **M0 — Scaffold.** Folder, `package.json`, Next 16 + Tailwind v4, `@mind-studio/core` login,
   single-flight auth, `docker-compose` CSS on :3101, seed script. Sign-in round-trips.
2. **M1 — Shell.** Workspace rail + account switcher (multi-WebID) + waffle app switcher + app body
   frame; shell state in `/apps/shell/`. Renders one placeholder app.
3. **M2 — Rust core.** `crypto-core` crate: Argon2id (calibrated) + XChaCha20-Poly1305 envelope +
   per-item keys + zeroize/secrecy/subtle; `cargo audit` in CI; `wasm-pack` build; unit + KAT tests.
4. **M3 — Vault app.** Unlock, item CRUD (per-item AEAD to `/apps/vault/items/`), generator,
   auto-lock+zeroize, clipboard auto-clear. Pod is source of truth; in-memory search index.
5. **M4 — Hardening features.** HIBP k-anonymity breach check, TOTP, master-password change
   (re-wrap), one WAC-grant sharing demo.
6. **M5 — Project scope + ship.** Project switcher + union view; `release.yml` + Dockerfile;
   catalog tile; `mindpods-infra` wiring → `shell.mindpods.org`.
7. **M6 (stretch) — Tauri native sidecar** for the hardened crypto path (mlock + AES-NI).
   Promoted to a first-class **mobile-first native track** (desktop + iOS/Android, same codebase,
   same Rust core) — design owned by the companion doc [`PRD-NATIVE.md`](./PRD-NATIVE.md).

---

## 10. Success criteria

- Sign in once at `pods.mindpods.org`, land in the shell, switch Workspace / Project / app and add a
  second Account — all from the wireframe surface.
- Create a Vault item; confirm **only ciphertext** is written to the pod (inspect `*.enc` raw — no
  plaintext); decrypt it back on a second device using the stored KDF params.
- Master-password change re-wraps without re-encrypting items.
- Lock → in-memory keys zeroized; HIBP check never sends the full password; deps pass `cargo
  audit`.
- Deployed live at `shell.mindpods.org`, discoverable as a tile in the existing dock launcher.

---

## 11. Open questions / decisions to make

1. **Shell vs `dock`.** The shell supersedes dock's *launcher* concept. v0 treats it as a
   **new exploration**, not a migration; decide later whether to fold dock into the shell or keep
   dock as the lightweight front door. *(Don't unify siblings without intent.)*
2. **App embedding.** v0 = first-party in-process apps (Vault). External-app hosting via
   `iframe`+`postMessage` against `*.mindpods.org` URLs is deferred — needs a shell↔app message
   protocol and a security review (cross-origin secret isolation).
3. **Item-name visibility.** Default v0 stores item titles/URLs in a cleartext index for search;
   offer an opt-in "hide everything" mode (opaque IDs only). Pick the default.
4. **Argon2id parameters.** Sources disagree by an order of magnitude (OWASP login-server ≥19 MiB
   vs RFC 9106 up to 2 GiB). Decision: **calibrate to device timing**, floor at OWASP, target RFC
   "second recommended" zone, store params per-vault. Confirm the calibration target (~0.5–1 s).
5. **Secret Key (1Password-style).** Adopt the two-secret derivation in v0 or defer to v0.2?
   Stronger against pod-blob theft but adds a recovery-UX burden.
6. **WASM vs sidecar default.** v0 ships WASM (convenience) with strict CSP; native sidecar is M6
   stretch. Confirm acceptable for the prototype's threat posture.
7. **Multi-workspace data.** How the rail enumerates Workspaces an Account joined (vs owns) — needs
   a registry of joined-workspace pods; lean on `workspace.ttl` membership + a per-account index.

---

## 12. Research provenance & validation

This PRD synthesizes four sweeps (2026-06-01). Confidence: **[H]** primary source corroborated,
**[M]** single good/vendor source, **[!]** contested — verify before building.

- **Prototype conventions [H]** — read across `drive`, `dock`, `builder`,
  `mind-shared-ui` (file:line refs inline in §2.2). Source of truth = each prototype's `AGENTS.md` +
  `package.json`; re-check before scaffolding.
- **Mind protocol [H]** — `architecture/src/{architecture.md, apps.md, projects.md}`,
  `src/protocol/01-pod-layout.md`, `src/decisions/{architecture/0001, apps/dock/0001}`, `CONTEXT.md`.
  The wireframe is the spec's "Dock" — quotes in §2.1.
- **Deployment [H]** — `mindpods-infra/{caddy/Caddyfile, compose.yml, images.env, scripts/deploy.sh,
  docs/DEPLOYMENT.md, docs/APP-DOCKERFILE.md}`. Note: infra `README.md` "🚧 scaffold" line is
  **stale** — the stack is live; trust `images.env`/`DEPLOYMENT.md`.
- **Secure Rust crypto [H]/[!]** — OWASP Password Storage Cheat Sheet; **RFC 9106** (Argon2),
  **RFC 6238** (TOTP); Bitwarden, 1Password, KeePassXC security whitepapers; RustCrypto crate docs
  (`argon2`, `chacha20poly1305`, `aes-gcm`, `zeroize`, `secrecy`, `subtle`); **NCC Group 2020**
  RustCrypto AEAD review; **RustSec** RUSTSEC-2021-0137 / 2016-0005; HIBP k-anonymity range API.

  **Flagged contested points [!]:** (a) Argon2id parameter magnitude (OWASP vs RFC 9106) — §5.1;
  (b) AEAD choice — XChaCha20-Poly1305 preferred over the legacy AES-CBC+HMAC that shipping managers
  still default to — §5.2; (c) Bitwarden's *default* is PBKDF2-600k, not Argon2id — we default to
  Argon2id; (d) WASM weakens memory/constant-time hygiene vs native — §5.5.

> **This is a research-backed design brief, not a verified implementation.** The crypto core must
> get an independent security review before it touches real secrets, and all crates pinned + scanned
> with `cargo audit` in CI.
