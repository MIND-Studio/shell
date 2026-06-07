# This is NOT the Next.js you know

This prototype uses **Next.js 16.2.6** + **React 19.2.4**. APIs have shifted from
training-cutoff knowledge (App Router, Turbopack, `cookies()`, server actions).
Before relying on what you "know", read `node_modules/next/dist/docs/` for the
actual current API.

# shell — agent rules

**Read this before editing any file here.** This is a sibling prototype — its own
app, ports, data, docs. Do not unify it with sibling prototypes. The full design
is in `PRD.md`; this file is the operational rulebook.

## What it is

Two layers in one prototype (PRD §1):

- **Shell** — the Dock-style surface that wraps identity: workspace rail, project
  switcher, app-switcher "waffle", app menu, app body, account switcher. It is
  **not an app** — it's the shell that hosts apps. Maps 1:1 to the wireframe and
  to `architecture/src/apps.md` ("Dock").
- **Vault** — the flagship hosted app: a **zero-knowledge** password manager whose
  crypto core is **Rust → WASM** (`crypto-core/`). The pod stores only ciphertext.

## Privacy / security invariants — HARD rules

1. **Zero-knowledge for Vault.** Plaintext secrets and raw keys **never** leave the
   Rust core (they never cross the WASM FFI). The pod, the network, and any worker
   see only ciphertext, wrapped keys, KDF params, and salt. The crypto contract is
   `crypto-core/CONTRACT.md` (mirrored in `src/lib/vault/crypto-contract.ts`) — it
   is authoritative; do not widen the FFI.
2. **Pod is the source of truth.** Never invent a central database for user data.
   Any SQLite/in-memory index is a *local, per-device cache* only and must never
   persist plaintext secrets to disk.
3. **Single-flight OIDC (non-negotiable).** `handleIncomingRedirect` is memoized in
   `src/lib/solid/auth.ts` and must be called exactly once per page load. The shell
   mounts many session-aware components at once — never add a second call site.
4. **No bespoke crypto in JS.** All encryption/decryption/KDF happens in the audited
   Rust core. The JS side only marshals base64 + shows short-lived display values.
5. **Never log** secrets, master passwords, derived keys, decrypted item bodies.
   OK to log: WebID, route, status, latency, event type.
6. **Independent crypto review required** before the core touches real secrets;
   `cargo audit` + `cargo deny` are standing CI controls (PRD §8).

## Stack & layout

- Next.js 16.2.6 + React 19.2.4 + `@inrupt/solid-client` ^3 +
  `solid-client-authn-{browser,node}` + Tailwind v4 (no config file) + `tsx`.
- **Design system:** built on `@mind-studio/ui` (shadcn-native), default **Mind**
  brand, **dark** default. Indigo (`#6366f1`) accent on the login card only.
  `globals.css` imports `@mind-studio/ui/dist/styles.css` + `@source`s its dist.
  RSC gotcha: don't import `Card`/`Badge`/`cn` into server components.
- **Login:** shared `MindLoginCard` from `@mind-studio/core` (`ConnectForm.tsx`).
- `@mind-studio/ui` + `@mind-studio/core` install from **GitHub Packages** —
  `export NODE_AUTH_TOKEN=<read:packages PAT>` before `npm install`. To iterate on
  the shared UI locally, install the `mind-shared-ui` `npm pack` tarball.
- `crypto-core/` — the Rust crate. `npm run wasm` builds it to
  `src/lib/vault/pkg/` (gitignored). `cargo test` runs the pure-Rust core.
- `src/lib/solid/` — pod I/O (`pod-fs.ts`), auth single-flight (`auth.ts`),
  session (`session.ts`), profile (`profile.ts`).
- `src/lib/shell/` — the shell context (`useShell()`) + types contract (`types.ts`).
- `src/lib/vault/` — wasm loader + item model (consumes `crypto-contract.ts`).
- `src/components/shell/` — rail / switchers / chrome. `src/apps/vault/` — Vault UI.

## Pod data model (PRD §6)

```
{workspacePod}/
  profile/card#me        WebID (name, avatar) → account switcher
  workspace.ttl          members + roles → rail + settings
  apps/shell/            shell's own state (layout.ttl, recents.ttl)
  apps/vault/            Vault — sandboxed, zero-knowledge
    manifest.ttl  vault.ttl  items/{itemId}.enc
  projects/{id}/         project.ttl (+ project-scoped apps, union-computed)
```

Vocab: `mind: <https://mind.dev/ns/v1#>`, reusing `schema:`/`vcard:`/`as:`/`ldp:`/`solid:`.

## Ports

Dev app **:3100** · stock CSS **:3101** · DID-aware CSS **:3102**. (Beyond
landing's :3090; nothing collides.) See "Workspaces & DID" for the two servers.

## Workspaces & DID — both worlds

A workspace is a **pod owned by the signed-in WebID**, listed in that identity's
index at `{homePod}apps/shell/workspaces.ttl` (PRD-IDENTITY §4). "Add a workspace
→ Create new" is **name-only** (PRD-DID §5.7 *hybrid*): the user types a name and
the shell does the rest.

- **Flow** (`createWorkspace` in `src/lib/shell/context.tsx` →
  `provisionWorkspaceAccount` in `src/lib/solid/account.ts`): auto-generate a CSS
  account login (Vault generator), create a throwaway account, `POST account.pod`
  with **`settings.webId` = my WebID** so the new pod is WAC-owned by the reused
  identity (verified: a foreign account *can* set an external owner), best-effort
  bind the master DID, then seal the generated login in the wallet ("vault") as a
  `password`-kind, `workspace:true` record (filtered out of the account switcher).
- **Reuse my WebID, not a fresh one.** This is the chosen model — `1 WebID → N
  pods`. (Fresh-WebID *passports* still exist for the Identity app; don't conflate.)
- **Both worlds, one flow.** Works against a stock CSS (no DID — `didLinked:false`,
  the login is still sealed) and a DID-aware CSS (DID bound — `didLinked:true`).
  The create form live-probes `serverSupportsDid()` and shows which will happen.
- **A master wallet is optional.** With none, a workspace still provisions
  name-only; DID-link + credential-sealing simply no-op (no master DID to sign/seal).
- **1 DID → 1 account per server.** The fork rejects re-linking the same DID to a
  second account with `400 "already linked to another account"` — expected; the
  hybrid catches it (`didLinked:false`) and the workspace still creates. So the DID
  binds to your *first* account on a server (usually at onboarding), not every pod.

### The two CSS servers (`docker compose`)

`docker-compose.yml` runs **both** so the flow is exercised in each world:

- `css` **:3101** — stock upstream `solidproject/community-server` (no DID).
- `css-did` **:3102** — the DID-aware fork at `../../../solid/CommunitySolidServer`
  (adds the `did:key` account-login extension → `controls.did.*`). Build its image
  once before `docker compose up`:
  ```bash
  docker build -t mind-css-did:local ../solid/CommunitySolidServer
  ```
  Its default config chain auto-enables DID (`config/identity/handler/default.json`
  imports `enable/did.json` + `storage/did.json`); see the fork's `DID_LOGIN.md`.
  The fork's DID work currently lives **uncommitted on `main`** — commit before
  depending on it. Note: server-side DID is **optional** (PRD-DID's stance is
  "servers stay stock"); the shell never *requires* it — it's an upgrade that turns
  on DID binding where present. Cross-issuer caveat: create a workspace on the
  **same** server your identity is on, or the post-create pod I/O 401s (a `:3102`
  token presented to `:3101`).

## Ask before doing

- Any server-side persistence of user data (the pod is the only store).
- Widening the WASM FFI to pass keys/plaintext to JS.
- Replacing/folding in `dock` — the shell is a *new exploration* (PRD §11).
- Server-side crypto of any kind.

## Commits & releases

Use [Conventional Commits](https://www.conventionalcommits.org) on `main`
(`fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major). Releases,
tags, and `CHANGELOG.md` are automated by **release-please** — never tag manually
or hand-edit `CHANGELOG.md`. To cut a release, merge the open
"chore(main): release X.Y.Z" PR. See the README's Releases section.
