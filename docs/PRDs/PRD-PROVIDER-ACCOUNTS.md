# PRD — `shell`: Provider Accounts — viewable, reusable logins in the Vault

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-07
> **One-liner:** Let the shell store the **account logins it generates for secondary pod providers**
> (workspaces, external pods) as **viewable Vault items** — so you can sign in to that provider's own
> app (e.g. `drive.mindpods.org`) as the same user — while the **main identity stays password-less**
> (key-card only, never stored). Some providers require a **verified email**, so the flow also lets
> you bring a real address.

This PRD **complements** and defers to:
- [`PRD-DID.md`](./PRD-DID.md) — authoritative for the wallet, passports, and `PassportCreds`. This
  doc extends the existing `password`-kind record into a first-class, *viewable* Vault concept.
- [`PRD.md`](./PRD.md) §6/§8 + [`AGENTS.md`](./AGENTS.md) — the Vault's zero-knowledge invariant and
  the pod data model. Provider-account passwords are ordinary Vault items: encrypted by the Rust
  core, the pod sees only ciphertext.
- [`PRD-APPS.md`](./PRD-APPS.md) — the brokered hosted-app model. This PRD is the **interim** answer
  to cross-app login (give the user a credential they can type) until the bridge lands; the two
  coexist.

Where they overlap, they win; this doc is authoritative for **which credentials are stored vs.
dropped, where they live, how they're shown, and the email-verification branch**.

---

## 1. Problem

When you create an identity in the shell, the shell auto-generates a strong account
email + password, uses them once to create your account/WebID/pod, and **throws the password away**
(`createPassportAccount` in `src/lib/solid/account.ts`; the durable secret kept is a
*client-credentials key card*, not a typeable password). That is correct for the **main identity** —
it's a root credential — but it leaves two gaps:

1. **No cross-app login.** Open `drive.mindpods.org` in its own tab and it asks for an email +
   password you never had, and it can't read the shell's wallet (different origin). You cannot log
   in as the same user. (See `docs/HOW-LOGIN-WORKS.md`.)
2. **No verified-email path.** `autoEmail()` mints a non-identifying, non-deliverable address.
   Providers that require email verification (Inrupt PodSpaces, hosted CSS with confirmation, future
   third parties) can't be provisioned headlessly at all.

The fix is **not** to stop dropping the main identity's password. It's to treat **secondary provider
accounts** the way a password manager should: store their login, let the user see it, let them bring
a real email when the provider demands one.

## 2. Goals / Non-goals

**Goals**
- A **trust gradient**: main identity = password-less (unchanged); secondary provider accounts =
  password stored + viewable, opt-in, per provider.
- Surface stored provider logins as **first-class Vault items** the user can reveal and copy.
- A **bring-your-own-email** branch for providers that verify, probed like DID support is today.
- Keep the **key card** (client-credentials) as the shell's silent sign-in path — *independent* of
  whether a viewable password is also stored.

**Non-goals**
- Changing main-identity behavior (it stays drop-the-password — §3 rule).
- The brokered same-origin handoff (that's `PRD-APPS.md`; this is the typed-credential interim).
- Auto-solving CAPTCHAs or fully automating verifying providers — we *assist*, the user completes.
- Storing any provider's password on a pod in the clear, or anywhere outside the Vault envelope.

## 3. The trust gradient (the core rule)

| Credential | Stored where | Viewable? | Rationale |
|---|---|---|---|
| **Main identity** account password | **Dropped.** Only client-credentials key card kept (wallet) | **No** | Root credential — leak ⇒ every pod that WebID owns is exposed. Keep `AGENTS.md` rule #5's drop-it behavior. |
| **Secondary provider** account (workspace / external pod) | **Vault item** (email + password) **+** key card (wallet) | **Yes** | Per-provider, revocable, blast-radius of one pod. This is what a password manager is for. |

**This does not weaken rule #5.** Rule #5 protects the *master* password, seed, and derived keys —
none of which are ever stored. A provider account password is application data the Vault is designed
to hold, encrypted, zero-knowledge, opt-in.

**Honest tradeoff (must be stated in UI):** storing a reusable password means a Vault compromise
yields *that provider password*, not just a revocable key card. Accepted because it's encrypted at
rest behind the master password, opt-in per provider, and never applied to the main identity.

## 4. Two secrets, two jobs — keep them separate

For every secondary account the shell holds up to two things, and **must not conflate them**:

- **Key card** (`client-credentials` `{id,secret}`) → the shell's headless, no-redirect sign-in.
  Lives in the wallet registry. *Required* for silent resume.
- **Account login** (`email` + `password`) → for **the user** to sign in to the provider's own
  app/UI and to pass email verification. Lives as a **Vault item**. *Optional convenience*, not
  needed for the shell's own auth.

Implication: storing the password is a **user-facing + provider-requirement** feature, not an auth
requirement. A provider can have a key card and no stored password (today's passport), a stored
password and no key card (manual/verifying provider), or both (the target for workspaces).

## 5. Data model

### 5.1 Vault item — `mind:ProviderAccount`

A new Vault item kind, stored like any other (`apps/vault/items/{id}.enc`, ciphertext only). The
*decrypted body* carries:

```jsonc
{
  "kind": "provider-account",
  "label": "Drive workspace",
  "server": "https://pod.mindpods.org",      // provider origin
  "webId": "https://pod.mindpods.org/me/profile/card#me",
  "email": "you+ws1@example.com",             // real or auto-generated
  "password": "…24-char generated…",          // the viewable secret
  "emailVerified": true,                       // §6
  "didLinked": false,                          // mirrors workspace provisioning
  "createdAt": "2026-06-07T…",
  "passportId": "…"                            // links to the wallet key card, if any
}
```

Non-secret metadata (`server`, `webId`, `label`, `didLinked`) MAY also be mirrored to the workspace
TTL for the rail; the **email + password live only inside the Vault envelope**.

### 5.2 Relationship to the existing `password`-kind passport record

Today `provisionWorkspaceAccount` seals `creds: { kind: "password", email, password }` into the
wallet registry and the account switcher **filters it out** (`workspace:true`). We **keep the wallet
record as the key-card/sign-in anchor** and additionally **project a viewable `provider-account`
Vault item** from it. One source of truth for the secret; two surfaces (silent auth vs. human view).
No new secret store, no duplication of plaintext outside the core.

## 6. Email verification branch

Probe the provider the way the create form already probes `serverSupportsDid()`:

- **No verification required** (stock CSS): keep today's flow — auto-generate email + password, seal,
  and now *also* surface the Vault item. `emailVerified: true` (nothing to verify).
- **Verification required**: the form lets the user **bring a real email** (recommend plus-aliasing,
  `you+ws1@domain` → one inbox covers many accounts). The shell still **generates the password**
  (audited Vault generator); the user completes verification in-provider; on success the item is
  sealed with `emailVerified: true`. Until verified, the account is marked pending and silent resume
  is disabled for it.

This also gives non-CSS providers (Inrupt PodSpaces) a real home: manual capture → store the login
the user set → it's viewable and reusable like any other.

## 7. UX surfaces

- **Vault** gains a **"Provider accounts"** section/filter — reveal + copy email/password, "open
  provider" link, per-item warning that this is a reusable login.
- **Create-workspace form** gains the email branch (auto vs. bring-your-own) driven by the probe,
  and a one-line note: *"This login will be saved to your Vault so you can sign in to {provider}
  directly."*
- **Account switcher** behavior unchanged (still hides `workspace:true` from identity switching); the
  credential is now *findable in Vault* instead of invisible.

## 8. Security invariants (restate, do not regress)

1. Plaintext provider passwords cross the WASM FFI only as the same short-lived display value Vault
   already uses to show item passwords — never logged, never to a pod, never to a worker (rule #1,
   #5).
2. **Main identity is never stored** as a viewable password (§3). The drop-it path in
   `createPassportAccount` is unchanged.
3. The Vault item is sealed by the **same audited core envelope** as every other item — no bespoke
   crypto (rule #4).
4. The reusable-password tradeoff (§3) is surfaced in the UI; storing is **opt-in per provider**.
5. Independent crypto review still gates real secrets (rule #6) — this adds no new crypto, only a new
   item kind.

## 9. Milestones

- **P0 — Surface what we already seal. ✅ Done (2026-06-07).** Project existing `password`-kind
  wallet records into a viewable, read-only **Provider accounts** panel in the Vault (reveal/copy
  email + password, open-provider link, reusable-login warning). No new provisioning; the secret is
  read live from the unlocked wallet registry, never copied into a second store.
  - Pure projection: `src/lib/identity/provider-accounts.ts` (`projectProviderAccounts`,
    `hasViewableLogin`) — gates on `kind === "password"`, so the **main identity (client-credentials)
    can never appear**.
  - UI: `src/apps/vault/ProviderAccounts.tsx`, mounted in `src/apps/vault/index.tsx`.
  - Test: `scripts/test-provider-accounts.ts` (`npm run test:provider-accounts`) — 22 assertions,
    incl. the safety property that the root password/key-card secret never appears in output.
  - Validated: `npm run typecheck` clean for these files (pre-existing wasm-stub error aside).
- **P1 — Create-with-stored-login. ✅ Done (2026-06-07).** Workspace provisioning seals the account
  login into the wallet registry (`createWorkspace` in `src/lib/shell/context.tsx`), P0 projects it
  into the viewable **Provider accounts** panel (reveal/copy/open-provider), and the create form
  carries the UI note. P1 closed the honesty gap: the login is sealable only into an **unlocked**
  master wallet (the sole zero-knowledge store), so the form no longer promises a Vault entry it
  won't write.
  - Pure gate: `willSealWorkspaceLogin(walletStatus)` (`src/lib/identity/provider-entry.ts`) — true
    only when the wallet is `unlocked`. Tested in `scripts/test-provider-entry.ts`.
  - UI: `CreateWorkspaceForm` (WorkspaceRail.tsx) branches the note on it — “saves its login to your
    Vault” when it will, else “Unlock/Set up a master identity to save its login” (no false promise).
  - reveal/copy/open-provider + the freshly-created login appearing live: P0 (`ProviderAccounts.tsx`
    subscribes to the wallet, so a new workspace shows immediately).
- **P2 — Email branch. ✅ Done (2026-06-07).** A real-email path for providers that verify, the
  `emailVerified` lifecycle, and a pending state that disables silent resume — no new crypto, no FFI
  change, `emailVerified` is non-secret metadata sealed alongside the existing creds.
  - Pure logic: `src/lib/identity/email.ts` (`isAutoEmail`, `isValidEmail`, `suggestPlusAlias`,
    `verificationState`, `isVerificationPending`). Tested: `scripts/test-email.ts`
    (`npm run test:email`) — 34 assertions.
  - Lifecycle: `PassportCreds.emailVerified` (types.ts); `markEmailVerified(id)` (wallet.ts, a
    whole-`creds` merge so email/password survive); projected as `verification` + `pending` on
    `ProviderAccount` (provider-accounts.ts, +6 assertions in `test-provider-accounts.ts`).
  - Pending disables silent resume: `isResumable` in `src/lib/solid/resume.ts` now excludes
    `emailVerified:false` accounts — we never auto-enter an unconfirmed login.
  - Probe: `serverRequiresEmailVerification` (`src/lib/solid/email-verification.ts`), mirroring
    `serverSupportsDid` — conservative/best-effort (stock CSS → false; it's a hint, the user's choice
    is authoritative).
  - Create flow: `createWorkspace` accepts `email` (context.tsx; placeholder ⇒ `emailVerified:true`,
    bring-your-own ⇒ pending); `CreateWorkspaceForm` gains the bring-your-own-email branch with
    plus-alias guidance, auto-armed when the probe says the server verifies (WorkspaceRail.tsx).
  - Vault viewer: a **Pending** badge + "Mark verified" action on each pending row
    (`src/apps/vault/ProviderAccounts.tsx`).
  - Validated: `npm run typecheck` clean for these files (pre-existing wasm-stub error aside).
- **P3 — Manual/non-CSS capture. ✅ Done (2026-06-07).** Capture a login you set up yourself at a
  provider the shell can't provision headlessly (Inrupt PodSpaces; a register-yourself CSS such as
  the live `https://pods.mindpods.org` — `password.register`/`forgot` only, no DID-login extension)
  and seal it as the **same** `password`-kind record every other provider account is. It carries
  **no** client-credentials key card, so it is never silently resumed (resume.ts already gates on
  client-credentials) — a viewable, reusable credential only (§4 "a stored password and no key card").
  - Pure logic: `src/lib/identity/manual-account.ts` (`normalizeServer`, `validateManualAccount`,
    `isManualAccountValid`, `buildManualPassport`) — no React/crypto/DOM/network; the provider stays
    the real validator. Tested: `scripts/test-manual-account.ts` (`npm run test:manual-account`) —
    38 assertions, incl. a round-trip through the P0 projection and the no-key-card property.
  - Data model: `Passport.manual` (types.ts) for provenance; projected as `ProviderAccount.manual`
    (provider-accounts.ts).
  - Registry: `addManualProviderAccount(draft)` (wallet.ts) supplies id/did/timestamp and seals via
    the same envelope — no new store, no new crypto.
  - UI: the Vault "Provider accounts" panel now shows whenever the wallet is unlocked (even empty),
    with an **Add a provider login** capture form (name / provider / email / password / optional
    WebID / "not confirmed yet" → pending) and an "Added by you" badge on captured rows
    (`src/apps/vault/ProviderAccounts.tsx`).
  - Validated: `npm run typecheck` clean for these files (pre-existing wasm-stub error aside).
- **P4 — Brokered-bridge fallback. ✅ Done (2026-06-07) — wired to the live capability bridge.** The
  capability bridge (`PRD-APPS.md`) IS built: the shell hosts first-party apps in a sandboxed iframe
  and hands them identity over postMessage with brokered, scope-checked pod I/O (`IframeHost.tsx`,
  `bridge.ts`, `bridge-protocol.ts`; Drive runs through it today). P4 connects that bridge to provider
  accounts: when a provider also ships an in-shell first-party iframe app, the brokered handoff is
  **preferred** (signed-in, no typed credential) and the stored login is the **fallback**; with no
  in-shell app the stored login is the path. **Both coexist** — the saved credential stays viewable
  either way.
  - Pure policy: `planProviderEntry`, `matchAccountForServer` (`src/lib/identity/provider-entry.ts`)
    — brokered-preferred, stored-login fallback, host-based account match. Tested:
    `scripts/test-provider-entry.ts` (`npm run test:provider-entry`) — 29 assertions.
  - Availability signal: `brokeredHandoffAvailable(server, apps)` (`src/lib/shell/brokered-bridge.ts`)
    reads the **live shell catalog** (`useShell().apps`: built-ins incl. Drive + pod-owned `apps.ttl`)
    and returns `true` when an enabled `embed:"iframe"`, `trust:"first-party"` app's host matches the
    provider host. Honest, not hard-coded — a generic CSS pod with no in-shell app stays stored-login.
  - UI: each Vault provider row shows the resolved entry hint and an adaptive open link
    (“Open provider ↗” / “Open in shell ↗” when brokered) — `src/apps/vault/ProviderAccounts.tsx`.

## 10. Open questions

- ~~**Plus-aliasing acceptance** varies by provider — do we detect/validate, or just advise?~~
  **Resolved (P2): advise.** `suggestPlusAlias` offers an editable `+alias`; we don't enforce or
  probe acceptance (the address stays user-editable, and verification is the real gate).
- **Rotation:** changing a provider password should update both the Vault item and (re-mint) the key
  card — define the single action that does both.
- **Main-identity escape hatch:** should an *advanced* user ever be allowed to opt the main identity
  into a stored password (export/print recovery)? Default **no**; flag if requested — it's the one
  place this PRD deliberately says no.
