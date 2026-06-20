# PRD — `shell`: DID identity layer (wallet-centric "passports")

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-03
> **One-liner:** Add a **portable, key-controlled master identity** (a `did:key` in the app's
> wallet) that owns many per-server **passports** (WebID + account + keys), turning every Solid
> server into a *dumb, unmodified storage backend* — **without** replacing WebID and **without**
> forking any server.

This is **Phase C** of the identity work begun in `PRD-IDENTITY.md`. Phase B decoupled
*Workspace from Account* (`1 Account → 1 WebID → N Pods`). Phase C adds the layer *above* the
account: a portable identity that survives changing servers/accounts, which is the gap WebID alone
cannot fill (an identity that is "a URL on one host's pod" dies when that host does).

It complements — does not replace — `PRD.md` (shell + Vault), `PRD-NATIVE.md` (Tauri track), and
`PRD-IDENTITY.md` (Phase B). Where they overlap, `PRD-IDENTITY.md` is authoritative for the
workspace/account model and this document is authoritative for the DID/identity/passport model.

---

## 1. Relationship to `SOLID_DID.md` (the pivot)

`architecture/docs/research/SOLID_DID.md` — the doc `PRD-IDENTITY.md §5` cited as the Phase-C
source of truth — specifies a **server-side** design: fork Community Solid Server to store
DID→account bindings, expose `/.account/did/*` controls, verify signed challenges, and issue a CSS
session on **DID login** (US-2). That makes the DID a *login factor to the server*.

**This PRD takes the opposite, wallet-centric approach, and supersedes `SOLID_DID.md` as the active
Phase-C direction for mind-shell.** Rationale:

| | `SOLID_DID.md` (server plugin) | This PRD (wallet-centric) |
|---|---|---|
| Server changes | Forks CSS; must land in every server | **None** — servers stay stock |
| Works against pod providers we don't control (Inrupt PodSpaces, …) | No (can't ship a plugin there) | **Yes** |
| Fits this prototype's ethos | Diverges (we never fork the server; B4 used only the standard account API) | **Matches** |
| DID role | Credential the *server* checks (login factor) | **Control/binding layer above** the servers |
| Auth to each server | DID challenge → CSS session | **Standard Solid-OIDC**, unchanged |

The one thing we give up: the DID is **not** a login factor *to the server*. You still log into each
server with its own Solid-OIDC. The DID instead **proves control** over the set of passports and is
the **recovery + correlation-control** root. That separation is cleaner and is the only version that
is universally compatible. `SOLID_DID.md` remains the reference design for the server-plugin
alternative, to be revisited only if DID-as-server-login is ever wanted (and per `SOLID_DID.md §16`,
our wallet already holds the keys, so adopting it later is an adapter swap, not a redesign).

> We do **not** edit `SOLID_DID.md` (it lives in `architecture/`, which is off-limits per the
> standing constraint — see §10). This file is the spec.

---

## 2. The model

### 2.1 What it adds above Phase B

```
Identity (master DID — THIS PHASE)         ← portable, key-controlled, in the wallet
  └─ Passport (per server)                 ← MANY per identity
       ├─ account (that server's CSS account: email + creds/tokens)
       ├─ WebID   (that server's assigned WebID — freshly minted, NOT reused)
       └─ Pod(s) == Workspace(s)           ← Phase B's plural workspaces live here
            └─ Project → App
```

Phase B's chain was `1 Account → 1 WebID → N Pods`. Phase C wraps *N of those chains* (one per
server) under one master DID. The Phase B `workspaces.ttl` index is unchanged; it now describes the
pods *within a single passport*. The **passport registry** is the new structure that sits above it.

### 2.2 What a passport is (concretely)

A per-server bundle the wallet owns:

```ts
interface Passport {
  id: string;              // local stable id (random)
  did: string;            // the master did:key (same across all passports — see §2.4)
  server: string;         // origin, e.g. "https://pod.example.org"
  webId: string;          // the WebID THIS server minted for this passport
  podRoots: string[];     // pods/workspaces under this passport (feeds Phase B's rail)
  label?: string;         // human label ("Work", "Personal")
  email?: string;         // the account email used at signup (recovery channel; see §5.8)
  createdAt: string;
  // NEVER stored in cleartext anywhere a server can read it (see §5.6):
  // account credentials / client-credentials tokens for headless re-auth.
  creds?: PassportCreds;  // encrypted-at-rest only
}
```

Unlike Phase B's B4 provisioning (which **reused** the existing WebID via `settings.webId`), each
passport gets a **fresh WebID** — which is simply the **CSS default** behavior B4 deliberately
suppressed. So minting a passport is the same account-session handshake we already wrote, *minus*
the `settings.webId` field (§5.7).

### 2.3 Servers are dumb storage

Every server is unmodified. The wallet:
1. provisions an account + pod + WebID via the server's **standard** account API,
2. logs in via the server's **standard** Solid-OIDC (single-flight, untouched — AGENTS.md rule #3),
3. writes a **signed binding document** into the pod asserting the master DID controls that WebID.

No server validates DIDs. Verification of a binding needs zero server support: a relying party
resolves the `did:key` and checks the signature (§5.5).

### 2.4 The master DID and the unlinkability tradeoff (decision recorded)

**Decision (2026-06-03): one single master `did:key` is named in every binding.** Each binding
document asserts `<webID> controlledBy <did:key:MASTER>` and is signed by the master key.

- **Pro:** simple to reason about, one key to back up, one DID to resolve, trivial verification.
- **Con (stated honestly):** a relying party that collects **≥2 published bindings** learns they
  belong to the same person — they all name the same master DID. Pairwise unlinkability therefore
  holds **only as long as no single verifier sees more than one binding.**
- **Mitigations that make this acceptable for v0:**
  - **Bindings are NOT published by default** (§5.5). They are written into *your own* pods and
    revealed to a chosen relationship only when you decide to prove control. Default state leaks
    nothing.
  - Servers don't talk to each other; cross-server correlation requires an out-of-band party that
    has *been shown* both bindings.
- **Future hardening (deferred, not built):** per-passport **child DIDs** (HD-derived, e.g.
  SLIP-0010 ed25519) sign their own bindings, with a separate master-signed "this child is mine"
  certificate revealed only for opt-in linkage. The data model (§5.10) leaves room for this — a
  passport already carries its own `did` field that today equals the master DID and could later
  diverge — so adopting it is additive, not a reshape.

### 2.5 Hard non-goal: WebID is NOT replaced

Carried from `PRD-IDENTITY.md §2.1`. WebID stays the Solid-facing identifier in Solid-OIDC tokens
and in WAC/ACP. The master DID **never** enters tokens or access-control rules. A binding document
is an *assertion stored as pod content*, not a credential the server checks. Any design that puts a
DID where a WebID goes is rejected.

---

## 3. Scope

**In scope (this build, staged C0–C4):**
- A master identity in the wallet: generate / unlock / recover a master `did:key`, custodied
  natively (§5.4), with key operations in the audited Rust `crypto-core`.
- A passport registry (encrypted) the master identity owns (§5.6).
- Provisioning a passport on a **stock CSS** server (fresh WebID), reusing the B4 handshake (§5.7).
- Writing + verifying **signed binding documents** (unpublished by default) (§5.5).
- Wiring the account switcher to read **identity → passports** instead of the Phase-B remembered
  WebIDs in `accounts.ts` (§7).

**Out of scope (this build):**
- Replacing WebID; changing Solid-OIDC tokens or WAC/ACP (§2.5).
- Forking any server / the `SOLID_DID.md` server plugin (§1).
- Per-passport child DIDs and opt-in linkage certificates (§2.4 future hardening).
- Non-CSS provider adapters beyond a **manual-capture fallback** (§5.7) — CSS-first.
- Verifiable Credentials / OpenID4VP.
- Concurrent live Solid sessions (the `@inrupt` browser SDK still holds one active session; the
  wallet switches between passports, it does not run them simultaneously).
- Editing `architecture/` docs, `PRD.md`, `SOLID_DID.md` (§10).

---

## 4. Why we're ~70% pre-built

The expensive part (the crypto substrate) already exists:

- `crypto-core/` compiles to **both** `wasm32` and native, and already has a native module
  (`native.rs`) and memory hardening (`memlock.rs`) **gated for the Tauri sidecar**.
- The **session-handle FFI pattern** (`lib.rs`: unlocked keys live in WASM/native memory behind an
  opaque `u32`; only ciphertext/short-lived values cross the FFI) is exactly what a wallet wants —
  the **master seed never leaves Rust; only signatures and public DID material come out.**
- The **Argon2id → XChaCha20-Poly1305 envelope** (`kdf.rs` / `envelope.rs`) is a ready-made
  **encrypted keystore** for both the seed and the passport registry — so we encrypt the wallet's
  secrets with the **same audited stack as the Vault**, not a second one (this is why we chose
  *not* to add Stronghold — §5.4).

Phase C is therefore mostly: **add Ed25519 + `did:key` + detached signing to the Rust core** (no
new JS crypto — honors AGENTS.md rule #4), then TS orchestration on top.

---

## 5. Design in detail

### 5.1 Wallet-centric, decided — see §1

### 5.2 Passport — see §2.2

### 5.3 Master DID & binding model — see §2.4

### 5.4 Key custody: **native-first, NOT Stronghold**

**Decision (2026-06-03): native-first custody; do not build on Tauri Stronghold.** The master seed
must not live in long-lived browser storage (basic key hygiene; `SOLID_DID.md §10–11` concurs). It
is custodied natively, but **using our own crypto-core envelope + the OS keychain**, *not* the
Stronghold plugin — adding Stronghold would mean a **second secret-store crypto stack to audit**,
defeating the point of having one reviewed core.

| Layer | Mechanism |
|---|---|
| Seed at rest | Encrypted with the **existing `crypto-core` envelope** (Argon2id → XChaCha20-Poly1305), unlocked by a master password. One stack, one audit. |
| Unlock convenience | The wrapping password/key may be stored in the **OS keychain** (Tauri keychain access / OS secure storage) so unlock can be native/biometric. The keychain stores the *wrapping* secret, never the raw seed. |
| In memory | Seed + derived keys live in **Rust** behind the session-handle pattern; `memlock.rs` mlocks the pages; `zeroize`/`secrecy` on drop. **Only signatures + public DID material cross the FFI.** |
| Web app (degraded) | The web build does **not** hold the long-lived seed. It uses existing passports fully (**Solid-OIDC login needs no seed**), and reaches the **native sidecar** (local IPC / deep-link) — *or* a per-session password-unlock with an explicit, documented XSS-risk caveat — only to **mint a new passport** or **(re)write a binding document**. |

Platform answer in one line: **both web and native, but the seed is custodied natively; web is
full-featured for *using* passports and degraded (sidecar or flagged password-unlock) for *creating*
them.**

### 5.5 The binding document

A small signed RDF resource written into each passport's pod (default
`{podRoot}apps/shell/identity.ttl` — inside the shell's own zone, like Phase B's index):

```turtle
@prefix mind: <https://mind.dev/ns/v1#> .
@prefix sec:  <https://w3id.org/security#> .

<#binding> a mind:IdentityBinding ;
  mind:webId       <https://pod.example.org/work-a1b2/profile/card#me> ;
  mind:controller  "did:key:z6Mk…" ;          # the master DID (§2.4)
  mind:created     "2026-06-03T10:00:00Z"^^xsd:dateTime ;
  sec:proofValue   "z…detached-eddsa-signature…" ;   # over a canonical payload
  mind:proofPurpose "identity-binding" .
```

- **Payload signed:** a canonical JSON/JCS of `{ webId, controller, created, server, nonce }` —
  `nonce` is single-use to prevent a stale binding being replayed onto a different resource.
- **Signature:** detached EdDSA by the master key; for `did:key` the DID *is* the public key, so
  verification = decode the `did:key` multibase → Ed25519 verify. **Zero server support.**
- **Published?** **No, by default.** The binding lives in *your* pod, readable only by you (WAC),
  and is *shown* to a relationship when you choose to prove control. This is what preserves the
  default-unlinkable state under the single-master-DID model (§2.4).
- **Verifier utility** (`verifyBinding`) is pure and runs anywhere: resolve `did:key` → check sig →
  confirm `webId` matches the resource's owner.

### 5.6 The passport registry (most sensitive object — never cleartext in a pod)

The registry is the **map of all your identities**; whichever server hosted it in cleartext could
correlate everything, defeating the whole privacy story. So:

- **Primary store:** local, in the wallet, **encrypted with the crypto-core envelope** (the same
  shape as a Vault file). On native it sits beside the keystore; the OS keychain gates unlock.
- **Optional backup:** an **encrypted blob** PUT to the master/home pod
  (`{homePod}apps/shell/passports.enc`) — the server sees ciphertext only, never the passport list.
- **Never** a plaintext Turtle list of passports in any pod. (Contrast Phase B's `workspaces.ttl`,
  which *is* plaintext but only ever lists pods *within one passport* — non-correlating.)

### 5.7 Provisioning a passport (CSS-first)

Reuses the B4 account-session handshake (`src/lib/solid/account.ts`, `scripts/seed-demo.ts:42-67`):
GET `.account/` → password login → re-read for `controls.account.pod`. **The only change from B4:**
omit `settings.webId` on `POST {pod}` so CSS **mints a fresh WebID** (its default) instead of
reusing one. Capture the returned `webId` + `pod` into a new `Passport`, then write the binding
(§5.5).

```ts
interface ProviderAdapter {
  id: string;                                   // "css"
  provision(opts: { server: string; email: string; password: string; label?: string })
    : Promise<{ webId: string; podRoot: string; creds?: PassportCreds }>;
}
```

- **CSS adapter:** concrete, ~done (B4 handshake minus the WebID-suppression).
- **Other providers (Inrupt PodSpaces, …):** signup isn't standardized and may have CAPTCHA / email
  verification. Fallback = **guided manual signup**: the user signs up in a browser, then pastes the
  resulting WebID/pod; the wallet captures it into a passport and writes the binding. (No automation
  claimed where none is possible — adapters ship incrementally.)

### 5.8 Recovery (email is the channel, never the identity)

- **Seed backup** is the real recovery: a seed phrase the user records, and/or an
  **encrypted-seed** blob whose decryption is email-gated (the email receives a link/code to fetch
  *ciphertext*, which still needs the master password). The email **never** is an identifier servers
  correlate on — it's an out-of-band channel only.
- **Per-passport email note:** CSS requires an email per account at signup. Across servers a shared
  recovery email is fine (servers don't talk). Two passports on the **same** server with the same
  `account.email` are correlatable *by that server* — so for same-host unlinkability use distinct
  emails (or `+subaddressing`). Recorded as a user-facing warning, not enforced in v0.

### 5.9 `crypto-core` additions (the only new crypto — all in Rust)

New module `identity.rs` (native + wasm), honoring the zero-knowledge invariant:

| Export (FFI) | In | Out | Notes |
|---|---|---|---|
| `identityFromSeed(seed)` → handle | seed (unlock-time only) | `u32` handle | seed zeroized after; stays in Rust |
| `masterDid(handle)` | handle | `did:key:z…` string | public material only |
| `signDetached(handle, payload)` | handle, bytes | base64 signature | master key never crosses FFI |
| `verifyBinding(did, payload, sig)` | all public | bool | pure; no handle needed |
| (reuse) `createVault`/`unlock`/`encryptItem` | — | — | keystore + registry envelope (§5.4, §5.6) |

Crates: `ed25519-dalek` (RustCrypto family, consistent with the existing core), `bs58`/multibase for
`did:key` encoding. **No HD/SLIP-0010 in v0** (single master DID — §2.4); the seed *is* the master
keypair. HD derivation is the deferred hardening path.

### 5.10 Data model (TypeScript)

```ts
// src/lib/identity/types.ts (new)
interface MasterIdentity {
  did: string;                 // did:key — the one master DID (§2.4)
  createdAt: string;
  // seed + private key are NEVER here; they live in the Rust core behind a handle.
}
interface Passport { /* §2.2 */ }
interface PassportCreds {       // encrypted-at-rest only (§5.6); for headless re-auth
  kind: "client-credentials" | "none";
  id?: string; secret?: string; // present only inside the encrypted registry blob
}
```

The Phase-B `Workspace`/`WorkspaceRef` shapes are **unchanged**; a passport's `podRoots` feed the
existing rail.

---

## 6. Milestones

| Milestone | Content |
|---|---|
| **C0** | `crypto-core/identity.rs`: Ed25519 + `did:key` encode + `signDetached` + `verifyBinding`, native + wasm FFI, `cargo test` (sign/verify, tamper, wrong-key, canonical payload). No JS crypto. |
| **C1** | Master identity lifecycle in the wallet: generate / unlock / recover; seed custodied **native-first, crypto-core envelope, no Stronghold** (§5.4); registry encrypted (§5.6). Web = degraded path. |
| **C2** | Passport provisioning on stock CSS (B4 handshake **minus** `settings.webId` → fresh WebID); `ProviderAdapter` interface + CSS adapter + manual-capture fallback; passport lands in the encrypted registry; its pods feed the Phase-B rail. |
| **C3** | Binding documents: write `identity.ttl` signed by the master DID into each passport's pod (unpublished by default); `verifyBinding` utility + a "prove control" reveal flow. |
| **C4** | Account switcher reads **identity → passports** (replaces `accounts.ts` remembered-WebID list as the source); switching passport swaps the active OIDC session + reloads the Phase-B workspace context. |
| **C5+** | *(deferred)* per-passport child DIDs + opt-in linkage certs (§2.4); non-CSS adapters; `did:web`. |

**Gate:** per AGENTS.md rule #6, the **independent crypto review** must cover `identity.rs` and the
seed-custody/keystore path **before** the wallet holds a real user's master seed.

---

## 7. How it sits on Phase B (forward-compat)

- The **account switcher**'s data source moves from `accounts.ts` (remembered WebIDs, a per-device
  non-secret cache) to the **identity → passports** registry. `accounts.ts` stays as a fallback /
  cache; it never holds secrets.
- The **rail** is unchanged: it still renders `workspaces` for the *active passport's* pods via the
  Phase-B `workspaces.ttl` index + dedup logic.
- The Phase-B forward-compat checklist box *"Workspace creation never assumes pod == WebID"* (B4)
  is what makes C2 clean: provisioning already passes a WebID decision explicitly, so flipping it to
  "mint fresh" is a one-field change.
- **Single-flight OIDC** is preserved — switching passports tears down/rebuilds the one `@inrupt`
  session through the existing `auth.ts` path; **no second `handleIncomingRedirect`**.

---

## 8. Security requirements

- **Master seed / private key never cross the FFI** — only signatures + public DID material do
  (extends `lib.rs` session-handle invariant). `memlock` + `zeroize` on the seed.
- **No bespoke crypto in JS** — Ed25519/`did:key`/envelope all in the Rust core (rule #4).
- **Never log** the seed, master password, private keys, signatures, or account
  credentials/tokens. OK to log: WebID, DID (public), server origin, route, status, latency, event
  type (rule #5).
- **Passport registry never stored in a pod in cleartext** (§5.6); creds encrypted-at-rest only.
- **Binding payloads carry a single-use nonce**; `verifyBinding` rejects on signature/owner
  mismatch.
- **Pod is the source of truth** — bindings live in the pod; the registry's authoritative copy is
  the encrypted local keystore with an optional encrypted pod backup (no central DB).
- **Independent crypto review** before real secrets (rule #6); `cargo audit`/`cargo deny` standing.
- Recovery must not let the **email be the identity** (§5.8); warn on lockout if the seed is the
  only factor.

---

## 9. Open questions

1. **Web degraded path:** sidecar-only, or also a flagged password-unlock in the browser? (Affects
   how much the web build can do offline from native.) — leaning sidecar-first.
2. **Proof format for bindings:** detached EdDSA over JCS (simple, chosen here) vs a VC Data
   Integrity proof (interop with the wider SSI world later). — JCS for v0.
3. **Registry backup:** ship the encrypted pod backup (`passports.enc`) in v0, or local-only first?
4. **Same-server multi-passport email:** enforce distinct emails, or only warn? (§5.8) — warn in v0.
5. **When (if ever) to revisit `SOLID_DID.md`'s server plugin** for DID-as-server-login, given the
   wallet would already hold the keys (§1). — out of scope; note the seam exists.

---

## 10. Constraints honored

- **Don't replace WebID** (§2.5) — DID never enters tokens/WAC; bindings are pod content, not
  credentials the server checks.
- **Don't fork servers** — wallet-centric; servers stay stock (§1).
- **Don't edit `architecture/` docs, `PRD.md`, or `SOLID_DID.md`** — this new file is the spec;
  `SOLID_DID.md`'s contradiction with our direction is *noted* (§1), not patched.
- **Single-flight OIDC** non-negotiable (AGENTS.md rule #3) — Phase C adds no new
  `handleIncomingRedirect` call site (§7).
- **One crypto stack** — reuse the audited `crypto-core` envelope for the keystore/registry; **no
  Stronghold** (§5.4).
- **Pod is the source of truth**; the passport registry is encrypted, never a central DB (§5.6).
- **Don't unify siblings**; this stays inside `shell`.

---

## 11. References

- `PRD-IDENTITY.md` — Phase B (account/workspace decoupling); §4.6 foreshadows per-passport WebIDs.
- `architecture/docs/research/SOLID_DID.md` — the **server-plugin alternative** this PRD supersedes
  for mind-shell (§1); kept as reference for DID-as-server-login.
- `crypto-core/` (`lib.rs`, `kdf.rs`, `envelope.rs`, `native.rs`, `memlock.rs`) + `CONTRACT.md` —
  the substrate C0/C1 extend.
- `PRD-NATIVE.md` — the Tauri track the native custody builds on.
- `src/lib/solid/account.ts`, `scripts/seed-demo.ts:42-67` — the B4 account-session handshake C2
  reuses (minus WebID suppression).
- `src/lib/shell/accounts.ts`, `src/lib/shell/context.tsx` — the account-switcher source C4 rewires.
- W3C DID Core; `did:key` method spec; `ed25519-dalek`; JCS (RFC 8785).
