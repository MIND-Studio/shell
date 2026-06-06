# PRD — `shell`: Identity / Account / Workspace decoupling (+ DID-ready)

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-03
> **One-liner:** Fix the **`account == workspace == pod`** conflation so one Account can hold
> **many Workspaces**, and lay a clean seam for a future **DID identity layer** — *without*
> replacing WebID.

This PRD is scoped around a concrete code spike (**Phase B** below): make the workspace rail
enumerate *real, multiple* pods for the signed-in identity. The DID layer (**Phase C**) is
specified only as a forward-compatible seam here; its full design lives in
`architecture/docs/research/SOLID_DID.md` and is **out of scope for the Phase B build**.

It complements — does not replace — the existing `PRD.md` (the shell + Vault) and
`PRD-NATIVE.md` (the Tauri track). Where they overlap, `PRD.md` is authoritative for shell UI
and Vault; this document is authoritative for the identity/account/workspace model.

---

## 1. Problem statement

### 1.1 The conflation

The prototype (and the spec it follows) collapses four distinct things into one:

```
credential  ==  WebID  ==  Pod  ==  Workspace  ==  (CSS) Account
```

In the running shell, the chain is literally: the OIDC session yields a **WebID** →
`readProfile()`/`readPodRoot()` derive **one pod** from that WebID → `loadWorkspaceContext()`
builds a **one-element** `workspaces` array. There is no way to have a second workspace.

- `src/lib/shell/context.tsx:124` — `const podRoot = … await readPodRoot(info.webId)` (single pod)
- `src/lib/shell/context.tsx:86` — `setWorkspaces([{ podRoot, name, role: "owner" }])` (always length 1)
- `src/lib/solid/profile.ts:39` — `readPodRoot(webId)` returns *the* pod for a WebID

### 1.2 The spec already contradicts itself

The Mind protocol spec wants both at once:

- `architecture/src/architecture.md:50` — *"Account … carrying **exactly one WebID** and **one**
  personal Workspace."*
- `architecture/src/architecture.md:51` — *"Every Account has one personal Workspace by default
  and **may create or join more**."*

So "exactly one Workspace" in the Account definition is the bug; line 51 is the intended behavior.
(We are **not** editing the spec in this PRD — see the constraint in §9.)

### 1.3 "Account" is not a Solid concept

This is the load-bearing insight. Solid standardizes only **Pod** + **WebID**. The **Account** is
a **CSS-server-local** entity (the `/.account/` JSON API, email/password login). The real Solid
graph is already a hierarchy the shell is flattening:

```
CSS Account            ← server-local, NOT in the Solid spec
  ├─ WebID(s)          ← Solid-facing identity (tokens, WAC)
  └─ Pod(s)            ← storage; ONE account can already own MANY
```

A single CSS account can already own multiple pods — so **multiple Workspaces per Account needs
no new protocol**, only decoupling. That is Phase B.

What is genuinely *missing* is a **portable identity** that survives changing servers/accounts.
Today identity == a URL on one host's pod. That is the gap **DID** fills (Phase C) — additive,
not a replacement.

---

## 2. The corrected model (target)

Five layers. Product noun → protocol noun → wireframe surface:

| Layer | What it is | Protocol noun | Wireframe surface |
|---|---|---|---|
| **Identity** | A portable, key-controlled "who you are" (Phase C: a DID) | *(new)* DID | account switcher (top of the human's identity) |
| **Account** | A home/login on a particular server | CSS account | account switcher entries (`@huhn511`, `@sh`) |
| **Workspace** | A data store with the MIND folder layout | **Pod** | **left rail** (one icon per Workspace) — **many** |
| **Project** | An optional scope inside a Workspace | `/projects/{id}/` | project switcher (`Product`) |
| **App** | A sandboxed app zone | `/apps/{key}/` | waffle / app menu / app body |

```
Identity (DID — Phase C)
  └─ Account (CSS account, possibly several, possibly cross-server)
       └─ Workspace == Pod   ← MANY per account   (Phase B)
            └─ Project (/projects/{id}/)
                 └─ App (/apps/{key}/)
```

### 2.1 Hard non-goal: **WebID is NOT replaced**

WebID stays exactly as today — the Solid-facing agent identifier in Solid-OIDC tokens and in
WAC/ACP rules. A DID (Phase C) **authenticates control** over an Account; it does **not** appear
in tokens or access-control rules in this work. This mirrors the principle in
`SOLID_DID.md §1` and its Non-Goals (§4). Any design that puts a DID where a WebID goes is
rejected.

---

## 3. Scope

**Phase B (this PRD's build): decouple Workspace from Account.**
The signed-in identity can own/join **multiple Workspaces**; the rail enumerates them for real;
switching is real; creating a Workspace is real (or, if pod-provisioning is deferred, the
*registry* of Workspaces is real and additive). No DID, no crypto, no WebID changes.

**Phase C (specified as a seam only; not built here): DID identity layer.**
Per `SOLID_DID.md`. The Phase B data structures must not foreclose it (§7).

**Explicitly out of scope (both phases):**
- Replacing WebID (§2.1).
- Concurrent live sessions (the `@inrupt` browser SDK holds exactly one active session;
  multi-account remains "remembered identities you re-auth as" — `src/lib/shell/accounts.ts`).
- Editing the `architecture/` spec docs or the existing `PRD.md` (§9).
- WAC/ACP changes; Solid-OIDC token shape changes.

---

## 4. Phase B — the decoupling, in detail

### 4.1 The auth-plane subtlety (decide the enumeration mechanism)

The shell authenticates via **Solid-OIDC** and holds a **WebID session** (`session().fetch`).
It does **not** hold a CSS **account** session — that needs a separate email/password login that
returns a `CSS-Account-Token` (see `scripts/seed-demo.ts:42-67`). So "list every pod this account
owns" via `controls.account.pods` is **not** available from the shell's session alone.

Three candidate mechanisms to enumerate a Workspace list:

| # | Mechanism | Pros | Cons |
|---|---|---|---|
| **A** | **Pod-hosted Workspace index** the WebID owns/reads (e.g. a Turtle/JSON resource at a known path) listing `{podRoot, role, name}` | OIDC-native (no account creds in the shell); works **across servers**; generalizes to *joined* (not just owned) workspaces; **DID-ready** (index travels with identity, not the server account) | shell must maintain it; bootstrap for first run |
| B | **CSS account API** (`controls.account.pods`) | authoritative owned-pod list | needs email/password account session in the shell (separate auth plane); single-server only; does **not** cover *joined* workspaces |
| C | **`workspace.ttl` membership crawl** | reflects real WAC membership | no index of *where* to look; expensive; chicken-and-egg |

**Recommendation: Mechanism A** for the Phase B spike — a pod-hosted Workspace index. It is the
only option that is OIDC-native, spans servers, covers *joined* workspaces, and survives the move
to DID (the index belongs to the *identity*, not to one server's account). This is also the lean
already recorded in `PRD.md §11` open-Q7 ("a registry of joined-workspace pods … per-account
index"). B can be added later as an *importer* that seeds A from the account's real pod list.

### 4.2 Where the index lives

Default (v0): **`{homePod}apps/shell/workspaces.ttl`**, where `homePod` is the pod derived from
the WebID today (`readPodRoot`). Rationale: the shell already owns its `/apps/shell/` zone
(`shellZone()` in `types.ts`), and this keeps the spike entirely within the OIDC session.

- Bootstrap: if the index is missing, synthesize a one-entry list `[{ podRoot: homePod, role:
  "owner", name }]` (exactly today's behavior) and write it on first successful create.
- A WebID's "home pod" stays the *default* Workspace; the index is what makes the rail plural.

> Forward note (Phase C): when identity becomes a DID, the index moves to an identity-scoped
> location (or is mirrored per-account) so it is not tied to one server's pod. The *shape* below
> does not change.

### 4.3 Index shape

```turtle
@prefix mind: <https://mind.dev/ns/v1#> .
@prefix dct:  <http://purl.org/dc/terms/> .

<#registry> a mind:WorkspaceRegistry ;
  mind:workspace <#ws-home>, <#ws-family> .

<#ws-home> a mind:WorkspaceRef ;
  mind:podRoot   <https://pod.mindpods.org/alice/> ;
  mind:role      "owner" ;
  dct:title      "Alice's Workspace" .

<#ws-family> a mind:WorkspaceRef ;
  mind:podRoot   <https://pod.mindpods.org/family/> ;
  mind:role      "member" ;
  dct:title      "Family" .
```

(Reuse `mind:` per `PRD.md §2.1` vocabulary rules; `dct:title` matches `workspace.ttl` parsing in
`context.tsx:81`.)

### 4.4 Data model (TypeScript)

```ts
// src/lib/shell/types.ts — extend, do not break existing Workspace
export interface WorkspaceRef {
  podRoot: string;            // trailing-slashed pod URL
  role: WorkspaceRole;        // owner | member | guest (existing union)
  name?: string;              // optional cache; live name still read from workspace.ttl
}
```

`Workspace` (the *resolved* form already in `types.ts`) is unchanged. `WorkspaceRef` is the
*stored* form in the index. `context.tsx` resolves refs → `Workspace[]`.

### 4.5 Code changes (the spike)

1. **`src/lib/solid/workspaces.ts`** *(new)* — read/write the Workspace index:
   - `listWorkspaceRefs(homePod): Promise<WorkspaceRef[]>` (tolerant of a missing index → `[]`).
   - `addWorkspaceRef(homePod, ref)` / `removeWorkspaceRef(homePod, podRoot)`.
   - Uses `@inrupt/solid-client` against `shellZone(homePod) + "workspaces.ttl"`; no new auth.
2. **`src/lib/shell/context.tsx`**:
   - `refresh()`: after `readPodRoot`, call `listWorkspaceRefs(homePod)`; if empty, synthesize the
     home entry (§4.2 bootstrap).
   - Resolve each ref into a `Workspace` (reuse the `workspace.ttl` name read from
     `loadWorkspaceContext`, factored into a per-pod resolver).
   - `setWorkspaces([...resolved])` — **length ≥ 1, no longer hard-coded to 1**.
   - `switchWorkspace(podRoot)` already exists (sets `overridePod`); ensure it picks from the
     resolved list and reloads projects/apps for the chosen pod.
3. **Create Workspace** (`+` in the rail — wireframe "Create Workspace"):
   - v0 minimal: append a `WorkspaceRef` for a pod the user names/pastes (covers *join*), and write
     a `workspace.ttl` if absent. Pod *provisioning* (minting a brand-new pod) is **deferred** to
     a follow-up because it requires the account-session plane (§4.1 B) — call this out in the UI.
4. **Rail UI** — render `workspaces` (now plural) with active-ring on `workspacePod`; `+` →
   create/join; ⚙ → Workspace settings. (Matches the wireframe rail H/B/S/M.)
5. **Display-name fix (carried from earlier exploration, pre-req for a sane rail/switcher):**
   `readProfile` fallback currently yields `"card#me"`; change the fallback to the pod segment /
   strip the fragment, and have `seed-demo.ts` write `foaf:name`/`vcard:fn`. (Small, unblocks
   readable Account + Workspace labels.)

### 4.6 WebID minting on Workspace creation (**don't auto-mint**)

This is the crux of decoupling and the place CSS's defaults fight us.

**CSS default behavior:** creating a pod *also mints a WebID* inside it
(`{pod}profile/card#me`) and links it to the account. That bundling — "create pod ⇒ create
WebID" — **is** the `pod == WebID` conflation. We explicitly opt out of it.

| Phase | Model | On "Create Workspace" |
|---|---|---|
| **B** | `1 Account → 1 WebID → N Pods` | **Reuse the existing WebID.** Provisioning passes the signed-in WebID to CSS pod creation so **no new WebID is minted**; the new pod is pure storage, owned/controlled (WAC) by that WebID. |
| **C** | `1 DID → N (WebID, Pod) pairs` | Per-persona WebIDs come *back*, deliberately — each new persona may mint its own WebID, unified under the DID umbrella (`@huhn511` work / `@sh` personal). |

So CSS's auto-mint isn't *wrong* — it's the right shape for **Phase C personas** and the wrong
shape for **Phase B** (where multiple Workspaces are one persona's many stores). Phase B
**suppresses** it; Phase C reintroduces it under a DID.

Consequences for Phase B:
- **Owned** Workspaces = pods where my one WebID is the controller (created with my WebID).
- **Joined** Workspaces = pods owned by *another* WebID; I'm a member (`role: "member"`). No WebID
  of mine is involved beyond access grants.
- **WebID-without-pod** (a standalone WebID document, no storage behind it) is *possible* in Solid
  but **not needed** in Phase B. It only becomes relevant in Phase C, where a DID-anchored WebID
  may live independently of any one server's pod. Deferred.

> **B4 implementation note (mechanism CONFIRMED live, 2026-06-03):** `POST {account}/pod/` with
> `{"name":"<ws>","settings":{"webId":"<existingWebId>"}}` creates the pod **without minting a new
> WebID** — the response echoes the *existing* `webId` and the new pod is reachable immediately.
> Verified against the local CSS v7 (`account` API `version 0.5`) reusing Alice's WebID to create a
> second pod `/family/`. The account-session handshake B4 reuses is `scripts/seed-demo.ts:42-67`
> (GET `.account/` → password login → `controls.account.pod`). WAC owner of the new pod = that
> WebID, so the shell's OIDC session can write it straight away.

### 4.7 Acceptance criteria (Phase B)

- A signed-in identity with ≥2 entries in its Workspace index shows **≥2 rail icons**; the active
  one is ringed; clicking switches the pod and reloads projects/apps/Vault zone.
- With **no** index, behavior is identical to today (one Workspace, no regressions) and the index
  is created on first add.
- "Create/Join Workspace" adds an entry that **persists** across reload (it's in the pod, not just
  localStorage).
- The account switcher (bottom-left) and rail show **readable names**, not `card#me`.
- **WebID, Solid-OIDC tokens, WAC, and the single-flight redirect are untouched** (AGENTS.md hard
  rule #3 holds — no second `handleIncomingRedirect`).
- `pnpm typecheck`/`npm run build` green; Vault still unlocks and reads its `/apps/vault/` zone in
  the active Workspace.

---

## 5. Phase C — DID identity layer (seam only; **not built here**)

Full design: `architecture/docs/research/SOLID_DID.md`. Summary of how it attaches to Phase B:

- **Placement (the fork):** DID = **portable identity above the Account**. Implement first as the
  research doc's **account login factor** (`SOLID_DID.md` US-1/US-2), then allow **one DID → many
  Accounts** (the "Sebastian owns @huhn511 + @sh" reading). These compose; the binding store in
  `SOLID_DID.md §FR-1` already supports multiple bindings.
- **Keys never on the server**; a Tauri/Stronghold wallet signs `did:key` challenges
  (`SOLID_DID.md §10`, `M3`). mind-shell already ships a Rust crypto core + native track
  (`crypto-core/`, `PRD-NATIVE.md`) — the wallet is half-built.
- **WebID untouched** (§2.1). DID does not enter tokens or WAC in this work.
- **Seam Phase B must preserve:** the Workspace index (§4.2) is identity-scoped in shape, so it can
  move from `{homePod}apps/shell/` to a DID-scoped/mirrored location without changing
  `WorkspaceRef` or the rail. The account switcher's data source is an *identity → accounts* list,
  which today is `accounts.ts` (remembered WebIDs) and later becomes "accounts this DID controls."

**Open fork to confirm before Phase C** (not blocking Phase B): does the
`SOLID_DID.md §7 US-4` constraint *"a DID cannot be linked to multiple accounts on the same CSS
instance"* hold for our `@huhn511 + @sh` case if both live on the same host?

---

## 6. Milestones

| Milestone | Content | Phase |
|---|---|---|
| **B0** | Display-name fix (`readProfile` fallback + seed writes `foaf:name`) | B (pre-req) |
| **B1** | `workspaces.ts` index read/write + `context.tsx` resolves a plural `Workspace[]` (bootstrap-safe) | B |
| **B2** | Rail renders multiple Workspaces; switch reloads context; Vault follows | B |
| **B3** | Create/Join Workspace appends a persistent index entry | B |
| **B4** ✅ *(done 2026-06-03)* | Pod *provisioning* for a brand-new Workspace via the account-session plane (§4.1 B) — `src/lib/solid/account.ts` `provisionPod()` + `createWorkspace()` context action + the rail's Join/Create tabs. Verified live: created `/photos/` reusing Alice's WebID (no new mint — its `profile/card` `foaf:primaryTopic` points at `…/alice/…#me`), `mind:owner` = Alice, persisted across reload. | B |
| **C1+** | DID per `SOLID_DID.md` (separate PRD/track) | C |

---

## 7. Forward-compatibility checklist (so Phase B doesn't block Phase C)

- [ ] Workspace enumeration is via an **index resource**, not derived solely from the WebID's home
      pod (Mechanism A).
- [ ] `WorkspaceRef` carries `podRoot` + `role` (server-agnostic; no host assumptions baked in).
- [ ] The account switcher reads from an **identity → accounts** abstraction, not a single WebID.
- [ ] No code path assumes `workspace == homePod` or `account == pod`.
- [x] **Workspace creation never assumes pod == WebID** — provisioning reuses the WebID (§4.6, B4
      verified); the WAC owner of a pod is stored/derivable, so Phase C can later attach a
      *different* WebID per persona without reshaping the index.
- [ ] WebID remains the only thing in tokens/WAC.

---

## 8. Open questions

1. **Index location** — confirm `{homePod}apps/shell/workspaces.ttl` for v0 (vs profile-linked).
2. **Owned vs joined** — Phase B v0 stores both as refs; do we mark provenance (owned/joined) now?
3. **Create = provision or join?** — **resolved (B4 done):** the rail's `+` now ships *both* —
   *join* (paste a pod URL, B3) and *provision* (mint a new pod via the CSS account-session plane,
   reusing the existing WebID, B4). Account credentials are entered in the Create tab, used once,
   and never stored. The provision path is the only place the shell touches the account session.
4. **Multiple WebIDs per Account** — **resolved (§4.6):** Phase B is `1 Account → 1 WebID → N
   Pods` (creating a Workspace reuses the existing WebID, does *not* mint one). Per-persona WebIDs
   are deferred to Phase C under the DID umbrella. Confirm this is the intended split.
5. **DID placement fork** — confirm "login-factor first → one-DID-many-accounts" (§5) before C.

---

## 9. Constraints honored

- **Don't replace WebID** (user directive; §2.1).
- **Don't edit `architecture/` docs or `PRD.md`** in this work (user directive: "don't update
  docs"). This new file is the spec; the conflation in `architecture.md:50` is *noted*, not patched.
- **Single-flight OIDC** is non-negotiable (AGENTS.md hard rule #3) — Phase B adds no new
  `handleIncomingRedirect` call site.
- **Pod is the source of truth** — the Workspace index lives in the pod, not a central DB; the
  localStorage `accounts.ts` registry stays a non-secret per-device cache only.
- **Don't unify siblings**; this stays inside `shell`.

---

## 10. References

- `architecture/docs/research/SOLID_DID.md` — DID-linked account auth (Phase C source of truth).
- `architecture/src/architecture.md:44-58` — Account → Workspace → Project hierarchy (and the
  `:50` vs `:51` contradiction this PRD resolves in product behavior).
- `PRD.md §2.1`, `§11 (open-Q7)` — shell primitives + the multi-workspace open question.
- `PRD-NATIVE.md`, `crypto-core/` — the Rust/Tauri track the Phase C wallet builds on.
- Wireframe (`Downloads/.../wireframe.png`) — rail = Workspaces; bottom-left = Identity/Account.
- Code seams: `src/lib/shell/context.tsx`, `src/lib/solid/profile.ts`, `src/lib/shell/types.ts`,
  `src/lib/shell/accounts.ts`, `scripts/seed-demo.ts`.
