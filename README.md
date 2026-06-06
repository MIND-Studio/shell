# shell — the Mind "everything app"

A **Dock-style shell** that wraps your Mind identity and hosts every app on one
surface — shipping with **Vault**, a zero-knowledge password manager whose crypto
core is written in **secure Rust** (compiled to WASM, with a native-sidecar path).

> Full design & research provenance: [`PRD.md`](./PRD.md). Operational rules for
> contributors (human or agent): [`AGENTS.md`](./AGENTS.md).

## Two layers

| Layer | What | Where |
|---|---|---|
| **Shell** | workspace rail · project switcher · app waffle · app menu/body · account switcher | `src/components/shell/`, `src/lib/shell/` |
| **Vault** | zero-knowledge password manager (Argon2id + XChaCha20-Poly1305 envelope) | `src/apps/vault/`, `src/lib/vault/`, `crypto-core/` |

The shell is **not an app** — it is the surface that hosts apps. The pod is the
source of truth; for Vault, the pod stores **only ciphertext** (the Rust core
never lets plaintext or keys cross the WASM boundary).

## Signing in

Three client-side paths, all redirect-free where possible (engine in
`src/lib/solid/`, `src/lib/identity/`):

- **On-page password login** — type your account email + password into
  `PasswordLoginCard`; the shell logs into CSS and mints a self-refreshing,
  DPoP-bound client-credentials session **with no jump to an external IdP**.
  Multi-pod accounts get a WebID picker. (CSS issuers only; external issuers use
  the redirect card. Prod prereq: the pod must allow cross-origin
  `/.account/` + `.oidc/token` — see [`docs/DEPLOY.md`](./docs/DEPLOY.md).)
- **Background resume** — a returning visitor is restored silently within a live
  tab; after a hard reload a **one-tap master-password unlock** re-enters without
  re-typing email/issuer (honors the wallet custody model — the master password
  is never stored). Token re-mint is automatic (30 s pre-expiry + on 401).
- **Redirect login** (`MindLoginCard`) — the classic "Continue with Mind" OIDC
  redirect, kept for external pods and native.

## Hosted apps

Other Mind apps render **inside** the shell's app body (not just link-out): a
pod-driven catalog (`{pod}/home/apps.ttl`) lists `embed:"iframe"` apps that load
in a sandboxed iframe and talk to the shell over a `postMessage` capability
bridge (`src/lib/shell/bridge.ts`, `IframeHost.tsx`). **The pod credential never
crosses the iframe** — apps post `mind:fetch/read/write`, the shell executes them
scoped to the workspace pod. `npm run seed:embed-demo` registers a toy bridge
app; `npm run seed:drive` registers the real `drive` as a first-party
frame. See [`PRD-APPS.md`](./PRD-APPS.md).

## Quick start

```bash
# 1. Auth for the shared design-system packages (GitHub Packages)
export NODE_AUTH_TOKEN=<a read:packages PAT>

# 2. Install JS deps
npm install

# 3. Build the Rust crypto core → WASM (needs Rust + wasm-pack)
npm run wasm

# 4. (Optional) start this prototype's own local pod server
docker compose up -d           # CSS v7 on :3101, seeded alice/bob

# 5. Run the shell
npm run dev                    # http://localhost:3100
npm run seed:demo              # populate a demo vault + workspace (idempotent)
```

By default (`.env.local`) dev points at the local CSS on `:3101`. Remove that line
to use the shared prod pod at `pods.mindpods.org` (SSO across the sibling apps).

## Crypto core

`crypto-core/` is a Rust crate (RustCrypto: `argon2`, `chacha20poly1305`,
`zeroize`, `secrecy`, `subtle`). `cargo test` runs the pure-Rust core natively;
`npm run wasm` emits the WASM glue into `src/lib/vault/pkg/`. The FFI is specified
in [`crypto-core/CONTRACT.md`](./crypto-core/CONTRACT.md).

> **Not a verified implementation.** The crypto core needs an independent security
> review before it touches real secrets. All crates are pinned and scanned with
> `cargo audit` in CI.

## Ports

Dev `:3100` · local CSS `:3101`. Sibling of the other prototypes —
run one at a time or override with `npm run dev -- --port NNNN`.
