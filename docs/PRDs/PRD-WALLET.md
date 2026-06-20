# PRD — `shell`: Wallet — your MIND balance, transactions, and payments

> **Status:** v1.0 — **W0 + W1 SHIPPED & verified end-to-end** (2026-06-11) · **Owner:** @huhn511 · **Date:** 2026-06-10
> **One-liner:** An **in-process Wallet** app — a first-class waffle tile — that shows your
> **MIND balance** and **transaction history** and lets you **send MIND** to another DID,
> signed in-browser with your master key. It targets the **already-shipped** token ledger
> in `solid-server-rs` (`/.tokens`); no new server work, no new key, no widened trust surface.

This PRD **builds on** and defers to:
- [`PRD.md`](./PRD.md) §6/§8 — pod data model and threat model.
- `AGENTS.md` — the HARD rules: zero-knowledge custody (keys never cross the WASM FFI),
  single-flight OIDC, pod-as-source-of-truth, never-log-secrets.
- `solid-server-rs/TOKEN-ECONOMY-PRD.md` — **authoritative** for the ledger: the MIND unit,
  the user-signed hash-chain, the `/.tokens` HTTP surface, and the operator switches.
- `solid-server-rs/FEDSET-PRD.md` — **cross-server** settlement (Phase 3), a *contingent
  design record, not built*. This Wallet is single-server only and says so (§6).

Where they overlap, they win; this doc is authoritative for the **Wallet app** — its
surface, the in-browser signing flow, the Home widget, and the security posture of holding
financial state in the shell.

---

## 0. The decision (in-process app, reuse the master DID, target the live ledger)

Three facts from a 2026-06-10 code-reading of `solid-server-rs` and `shell` set the design:

1. **The backend is real and shipped.** `solidrs-ledger` is live (`crates/solidrs-ledger/`,
   `crates/solidrs-core/src/traits.rs`). MIND is a single global closed-loop unit on an
   **append-only, user-signed, hash-chained** ledger; the home server is the authoritative
   orderer (no consensus). The owner-facing API exists today:

   | Endpoint | Method | Does | Status |
   |---|---|---|---|
   | `/.tokens` | GET | `{ owner, unit, balance, seq, head_hash, did, history[], transfers_enabled }` | **LIVE** |
   | `/.tokens/transfer` | POST | `{ transfer: SignedTransfer, proof: <b64 sig> }` — self-authenticating, no session | **LIVE** (gated `--ledger-transfers on`) |
   | `/.tokens/did` | POST | `{ did }` → 204; register the signing `did:key` | **LIVE** |
   | `/.admin/tokens/mint` | POST | operator top-up (test/dev; `SOLIDRS_ADMIN_TOKEN` bearer) | **LIVE** |

   *(Implementation note, verified against the running server: the chain head —
   `seq` + `head_hash`, `"genesis"` when empty — and the registered `did` come back
   at the TOP LEVEL of `GET /.tokens`; no need to derive them from `history`. The
   transfer body wraps the signature as `proof`, and `/.tokens/transfer` needs **no
   auth header** — the DID signature IS the authorization.)*

2. **`/.tokens` is a server-origin reserved route, not a pod resource.** The shell's
   capability bridge brokers only **pod** I/O within the pod root, so an iframe sibling
   can't reach `/.tokens`. ⇒ Wallet is an **in-process app like Vault**
   (`src/apps/wallet/index.tsx`), using the authed session `fetch` to hit `{serverRoot}/.tokens`.

3. **The signing key already exists and stays sealed.** The shell signs in via the master
   **`did:key`**. `sign(payload)` and `getDid()` in `src/lib/identity/wallet.ts` are a
   generic Ed25519-over-canonical-JSON primitive (already used to sign binding documents);
   the private key **never crosses the WASM FFI**. ⇒ Reuse it to sign transfers. **No new
   key, no FFI change, no new bridge verb.**

**Decision (2026-06-10):** the Wallet is an **in-process, first-party** app that *views* the
server ledger and *signs* transfers with the master DID. It invents no balances and adds no
trust surface. v1 is **Read + Send**.

**In scope (v1):**
- A **Wallet app** in the waffle: balance, transaction history, and a **Send** flow.
- A **Balance** Home widget (read-only tile, opens the app).
- In-browser **`SignedTransfer`** signing against the live `/.tokens/transfer`.

**Out of scope:** cross-server / inter-operator settlement (FEDSET Phase 3 — *unbuilt*);
per-model LLM pricing; a pod-hosted mirror of the full signed log; fiat on/off-ramp (operator
`mint` only, off the app's surface).

---

## 1. Vision & scope

MIND is the unit you earn (operator mint) and spend (today: LLM metering; soon: paying other
people). It already lives on a tamper-evident, user-signed ledger on your home server — but
there is no human surface for it. The Wallet is that surface: open the waffle, see your
**balance**, scroll your **transactions**, and **send** MIND to another DID — without ever
leaving your identity or handing any app a credential.

The custody thesis is `AGENTS.md`'s: the Wallet is **in-process and trusted**, exactly like
Vault. It reads `/.tokens` with the shell's own authenticated session and signs transfers by
asking the sealed crypto core to `sign()` a canonical payload — the **private key never
enters JavaScript and never crosses the FFI**. The server ledger remains the single source of
truth; the Wallet is a viewer and a signer, never an authority.

---

## 2. The app surface (UX)

A focused in-process app in the app body, dark-Mind aesthetic, mirroring Vault's chrome:

- **Balance header** — the big number: `balance` MIND, the active WebID/DID, a copy-DID
  affordance, and a subtle "synced ·just now·" freshness line.
- **Transactions** — the `history[]` chain, newest-first, each row typed by `kind`:

  | kind | glyph | reads as |
  |---|---|---|
  | `mint` | ↓ green | "Top-up · +N MIND" |
  | `transfer-in` | ↓ green | "From {counterparty} · +N" |
  | `transfer-out` | ↑ | "To {counterparty} · −N" |
  | `meter` | ⚡ | "LLM usage · −N" |
  | `debit` | − | "Debit · −N" |

  with counterparty (truncated DID), amount, memo, and timestamp.
- **Send panel** — recipient **WebID**, amount, optional memo → **review** (shows the exact
  signed fields, fee = 0, feeless) → **Sign & send** → result toast → list refreshes.
- **States** — *locked* (wallet sealed ⇒ "Unlock to sign", deep-link `/connect`);
  *transfers off* (`transfers_enabled:false` ⇒ Send hidden, viewer-only); *empty*
  ("No transactions yet"); *no DID* (read-only, Send unavailable).

---

## 3. Data model — server ledger is authoritative; the pod holds only a cache

**The ledger lives on the server**, not the pod. `GET /.tokens` returns the authoritative
balance and the user-signed hash-chain. Each `LedgerEntry` (server-owned shape, see
`crates/solidrs-core/src/traits.rs`):

```
{ seq, prev_hash, ts, kind, counterparty, amount, memo, sig, hash }
```

A **transfer** the Wallet signs (`SignedTransfer`, canonical **alphabetical** JSON, no
whitespace — exactly this key order, integer minor-units):

```
{ amount, from, memo, nonce, prev_hash, purpose:"token-transfer", seq, to }
```
→ base64 Ed25519 `sig` over the canonical string; the server re-verifies via
`verify_did_signature` (`crates/solidrs-auth-did/src/did.rs`) and enforces
`seq`/`prev_hash` monotonicity.

**Pod snapshot (the only thing written to the pod).** The Home widget runs in an iframe and
can reach **only** pod I/O through the bridge — never `/.tokens`. So the in-process app
writes a small, **non-authoritative** cache to the pod on each load:

```
{podRoot}apps/wallet/snapshot.json
  { "balance": <int>, "recent": [ {kind, amount, counterparty, ts} … ], "syncedAt": "<iso>" }
```

No signatures, no keys, no secrets — just the user's own balance and a few recent rows, for
the widget to render. It is a **derived cache, never a source of truth** (consistent with
`PRD.md` §6's pod-as-store invariant: the *authoritative* store here is the server ledger;
the pod copy is a convenience mirror the server can always overwrite the meaning of).

---

## 4. Capabilities & the signing flow (Wallet owns this)

The Wallet uses two existing seams, **unchanged**: the shell's authed session `fetch` (for
`/.tokens`, like `src/lib/solid/account-login.ts` reaches `/.account/`) and the sealed
`sign()`/`getDid()` from `src/lib/identity/wallet.ts`. The **Send** flow:

1. **`GET /.tokens`** → `balance`, the chain head (top-level `seq` + `head_hash`;
   `"genesis"` for an empty chain), and the registered `did`.
2. **Register once if needed:** if `did` is empty (or ≠ `getDid()`),
   `POST /.tokens/did` with the master DID. (Registering a key you don't own only locks your
   own tokens — conservative by design.) Lazy, on first Send — read paths stay side-effect-free.
3. **Build** the `SignedTransfer` with the exact field order above (`seq` = head `seq` + 1,
   `prev_hash` = `head_hash`). *Correctness-critical:* JS `JSON.stringify` preserves
   **insertion** order, not alphabetical — construct the object keys already in alphabetical
   order so the canonical bytes match the server's serde output. **Verified byte-exact:**
   the live server accepts this construction first try (14/14 contract checks + in-browser).
4. **Sign:** `proof = await sign(canonical)` — the master key signs inside WASM; nothing leaks.
5. **Submit:** `POST /.tokens/transfer` with `{ transfer, proof }` — a **plain fetch**;
   the body is self-authenticating, so no session/credential is attached.
6. **Reconcile:** on success, re-`GET /.tokens`, rewrite the snapshot, toast. On `409`
   (`{ error:"stale_or_replayed_transfer", expected_seq, expected_prev_hash }`), **rebuild
   against the reported head + re-sign once** (never blind-retry the same bytes); a second
   conflict surfaces to the user. An insufficient balance returns
   `402 { error:"insufficient_balance", balance }` → surface it ("declined"), never
   silently queue. A bad signature / transfers-off returns `403`.

Failure modes: `sign()` throws when the wallet is locked ⇒ prompt unlock at `/connect`;
`getDid() === null` ⇒ no wallet ⇒ Send unavailable, viewer-only.

---

## 5. Security — financial state in the shell (**[H], non-optional**)

Aligned to `AGENTS.md` HARD rules; **no new trust surface**:

- **Key custody unchanged.** Only `sign()` is called; the Ed25519 private key never enters
  JS and never crosses the WASM FFI. Same audited path as DID login and binding docs.
- **No bridge/FFI widening, no new protocol verb.** `/.tokens` is reached by the in-process
  app's own authenticated session fetch — *not* brokered through the iframe bridge. The
  widget reads only the pod snapshot via the existing brokered `read`.
- **Snapshot is a non-authoritative cache** holding only the user's own balance/recent rows
  — no sigs, no keys, nothing from the Vault namespace. The server ledger is the source of
  truth and tamper-detection lives there (hash-chain + `reconcile`).
- **Replay-safe by construction.** Transfers carry `nonce`/`seq`/`prev_hash`; the server
  enforces monotonicity; the Wallet always signs against a **freshly fetched** head.
- **Never log** transfer amounts, memos, or bodies (mirrors the ledger's body-free logging).
  OK to log: route, status, latency, `kind`.
- **Operator-gated Send.** When the server runs without `--ledger-transfers on`,
  `transfers_enabled:false` ⇒ the app degrades to a clean viewer. The legal/risk gate for
  user-to-user value lives on the operator switch, not in the client.

---

## 6. Single-server only — cross-operator is out of scope

The shipped ledger settles **within one home server**. Paying a DID whose tokens live on a
*different* operator is **FEDSET Phase 3**, which `FEDSET-PRD.md` records as a *contingent
design, not built* (and gated on a legal memo + a triple re-open trigger). The Wallet
therefore:

- Sends only between accounts on the **same** server origin the user is signed into.
- Makes no claim of cross-server transfer, escrow, or net-position settlement.
- Leaves a single config seam — the server origin — so that *if* FEDSET ever ships, the Send
  flow gains cross-server routing without a surface rewrite. Until then, an out-of-federation
  recipient simply isn't resolvable and Send says so.

---

## 7. Milestones

In-process, against the live ledger. (Dev config: §9.)

1. **W0 — Read-only viewer + widget. ✅ SHIPPED (2026-06-11).** `src/apps/wallet/index.tsx`
   registered in `builtinApps()` + `src/apps/registry.tsx`; ledger client in
   `src/lib/tokens/api.ts`; `GET /.tokens` → balance + typed history; writes
   `apps/wallet/snapshot.json`; the **Balance** Home widget
   (`src/app/widget/wallet-balance/page.tsx`) reads the snapshot and `mind:open`s the app.
   *Gate met: balance + history render from the live endpoint; widget shows the snapshot
   (verified in-browser against `solid-server-rs` :3061).*
2. **W1 — Send. ✅ SHIPPED (2026-06-11).** Lazy DID registration (`POST /.tokens/did`),
   canonical `SignedTransfer` construction + `sign()`, `POST /.tokens/transfer` with
   `{transfer, proof}`, 409 rebuild-once / 402 declined handling, post-send refresh +
   snapshot rewrite. *Gate met: signed transfers accepted **first try**, balance moved on
   both legs, replay → 409 with the expected head, overdraft → 402 with balance
   (14/14 contract checks + two in-browser sends).*
3. **W2 — Polish. ✅ SHIPPED (2026-06-11, /frontend-design pass).** "Ledger-as-artifact"
   look: amber-bloom balance hero with count-up tabular numerals, in/out/seq chips,
   hash-chain timeline (`#seq` nodes, credit/meter/spend tones, staggered reveal), Send
   review framed as the canonical document being signed ("Ed25519 · signed in the sealed
   core"), feeless badge, copy-DID, locked/disabled/empty/unsupported states, snapshot
   freshness in app + widget. Remaining ideas (kind filters, spend-this-period card) → W3.

---

## 8. Success criteria

- Open the Wallet → balance and full transaction history render from the live `GET /.tokens`;
  the **Wallet never received a pod token** for this (it used the shell's own session).
- The **Balance** widget shows the last-synced balance from `apps/wallet/snapshot.json`, read
  through the bridge; clicking it opens the Wallet app. **The bridge was not widened.**
- A **Send** produces a canonical `SignedTransfer` that the server **accepts on first try**
  (canonical bytes match); balance decreases on the sender and the entry appears in history.
- The **private key never appears in JS** at any point (only `sign()` is called); a locked
  wallet cannot send and prompts to unlock.
- With `--ledger-transfers off`, the app is a clean **viewer** — Send is hidden, nothing
  errors.
- No amount, memo, or key is ever logged; nothing from the Vault namespace lands in the
  snapshot (AGENTS.md HARD rules).

---

## 9. Open questions / decisions

1. **Server origin resolution.** Derive `/.tokens`' origin from the signed-in issuer
   (`storedIssuer()` / `serverRoot()`) vs. the workspace pod root's origin. Lean **issuer** —
   the ledger is account-scoped, not pod-scoped. Confirm they coincide for the DID-login case.
2. **Recipient input UX.** *Resolved (W1):* the ledger is keyed by **WebID**, not DID —
   `SignedTransfer.to` must be an http(s) WebID URL (the server rejects anything else).
   v1 = paste a WebID + validate; a contacts/WebID picker is a later upgrade.
3. **Amount units.** Surface MIND as integer minor-units consistently; decide display
   formatting (thousands separators; whether a sub-unit exists). Match the server's unit.
4. **Snapshot freshness.** Write on every app load only (v1), or also debounce-refresh while
   open? v1 = on load + after each send; note staleness in the widget.
5. **DID auto-registration.** Register the signing DID lazily on first Send (v1) vs. eagerly
   on first open. Lean **lazy** — keep read-only paths side-effect-free.
6. **LLM-spend emphasis.** The ledger's main real traffic today is `meter` (LLM pay-per-use).
   Should the Wallet foreground a "spend this period" summary, or treat all kinds uniformly?
   v1 = uniform list; revisit a summary card in W2.

---

## 10. Provenance

- **`solid-server-rs/TOKEN-ECONOMY-PRD.md` + `crates/solidrs-ledger/` + `…/solidrs-core/src/traits.rs`**
  — the live `/.tokens` API, `SignedTransfer`/`LedgerEntry` shapes, the user-signed hash-chain,
  and the `--ledger` / `--ledger-transfers` switches this PRD targets (verified present, 2026-06-10).
- **`crates/solidrs-auth-did/src/did.rs`** — `verify_did_signature` / canonical-JSON signing,
  the server-side check the Wallet's signatures must satisfy.
- **`src/lib/identity/wallet.ts`** (`sign`, `getDid`) + **`crypto-core/`** — the sealed
  Ed25519 primitive reused for transfer signing; the key-never-leaves-WASM invariant.
- **`src/apps/vault/`** — the in-process, trusted, financially-sensitive app template the
  Wallet mirrors; **`src/lib/solid/account-login.ts`** — the server-origin (non-pod)
  authenticated-fetch pattern for reaching `/.tokens`.
- **`src/lib/shell/{context.tsx,types.ts}`** + **`src/app/widget/recent/page.tsx`** — app
  registration (`builtinApps`, `HostedApp`), `WidgetDecl`/`appZone`, and the read-only widget
  the Balance tile copies.
- **`solid-server-rs/FEDSET-PRD.md`** — why cross-server settlement is out of scope: a
  contingent, unbuilt design gated on legal clearance and a triple re-open trigger (§6).

---

### Dev config (to exercise W0–W1 locally)

- Run the Rust server (:3061) with **`--ledger on --ledger-transfers on`** (and, to see
  `meter` rows, `--ledger-llm-price-per-1k > 0`).
- Seed a test balance: `POST /.admin/tokens/mint` (operator) or `solidrs-cli tokens mint`.
- The shell **DID-signs in** against that origin so `GET /.tokens` resolves the WebID; hard
  reload drops the in-memory key ⇒ re-unlock at `/connect` before signing a transfer.
