# PRD — `shell`: Hosting apps *inside* the shell (the "Mind app platform")

> **Status:** P0–P2 built (shell side) · **Owner:** @huhn511 · **Date:** 2026-06-07 (orig. 2026-06-04)
> **One-liner:** Make the shell **host** Mind apps (drive, codespaces, …) on one surface instead
> of linking out to them — and make **"install an app" mean "add an entry to your pod,"** not
> "rebuild the shell." Apps run **sandboxed**, accessing the pod only through a shell-brokered,
> least-privilege capability bridge.

This PRD is a **validated synthesis** of five parallel research sweeps run on 2026-06-04 (current
shell architecture; drive/codespaces embeddability; the `apps.ttl` launcher; 2025/26 micro-frontend
options on Next 16/Turbopack; runtime plugin + sandbox patterns). The full option comparison — and
why the alternatives lost — lives in [`docs/SHELL-APP-HOSTING-OPTIONS.md`](docs/SHELL-APP-HOSTING-OPTIONS.md).
It **complements** `PRD.md` (shell + Vault, authoritative for shell chrome) and `PRD-IDENTITY.md`
(account/workspace model). Where they overlap, this doc is authoritative for **app hosting**.

---

## 1. Vision & scope

The shell today hosts exactly one app *in-process* (Vault) and **links out** to every other Mind app
via `MindAppLauncher` (a waffle of `target="_blank"` tiles reading the pod's `apps.ttl`). That's a
launcher, not a platform. This PRD turns the shell into a **platform**: apps render inside the app
body under the shell's own chrome and identity, and the catalog of apps is **owned by the user in
their pod** — so a new app appears by editing pod data, with no shell rebuild and no redeploy.

The privacy thesis is the whole point: a hosted app must **not** receive the user's pod credential.
It runs in a **sandboxed iframe** and asks the shell for data; the shell performs **scoped,
least-privilege** reads/writes on its behalf. This is what makes a Mind "app store" defensible where
VS Code's and Backstage's plugin models (full-trust code) would not be.

**In scope (v0 → v1):**
- An **app manifest** schema (extends the `mind:App` vocab in `apps.ttl`) describing how to host an
  app and what pod access it needs.
- An **iframe host** in the shell app body + a typed **postMessage capability bridge**
  (identity handoff, brokered pod `fetch`, navigation, lifecycle).
- A **"first-party trusted"** tier shipped first (drive embedded), then the **sandbox + consent**
  tier for community/untrusted apps.
- The **per-app "embedded mode"** refactor pattern (skip own OIDC, accept identity from parent,
  suppress own chrome) — specified here, applied to drive first.

**Out of scope (v0):**
- Replacing the in-process model for Vault — Vault stays in-process (`APP_REGISTRY`); it's the
  blessed first-party crypto app and benefits from full integration.
- A public, internet-wide app marketplace / discovery service (we ship a *pod-owned* catalog + the
  existing `dock` "Add app" UI; a hosted directory is later).
- Deep cross-app routing/deep-linking beyond a minimal "open at path" (Phase 3).
- Replacing Multi-Zones/Module-Federation evaluation — **rejected**, see options doc §4 E/F.

## 2. What we build on (existing seams — all code-verified 2026-06-04)

| Seam | Where | What it gives us |
|---|---|---|
| In-process app registry | `src/apps/registry.tsx` — `APP_REGISTRY: Record<string, ComponentType>`, rendered by `getAppComponent()` in `src/app/shell/page.tsx` | The app-body mount point. We add an `iframe`/`embed` branch alongside the in-process lookup. |
| Shell context | `src/lib/shell/context.tsx` — `useShell()` → `webId`, `account`, `workspacePod`, `project`, authed `fetch`, `activeAppKey`, `setActiveApp()` | Exactly the values the bridge hands an app. `fetch` is the thing we *broker* rather than expose. |
| Pod-driven launcher | `@mind-studio/core/launcher` `MindAppLauncher` + `@mind-studio/core/apps` (`readApps`/`writeApps`/`ensureSeeded`) reading `{pod}/home/apps.ttl` | The runtime catalog. Today every entry is a `target="_blank"` link; we add `mind:embed` so the shell knows to host instead. |
| Add-app UI | `dock/src/app/dock/page.tsx` `AddAppDialog` → `writeApps()` | The runtime-install UX already exists. We enrich the schema it writes. |
| Single-flight OIDC | `src/lib/solid/auth.ts` (`handleIncomingRedirect` memoized once) + shared issuer `pods.mindpods.org` | The shell owns the session; apps never need to auth themselves once brokered. |
| Pod I/O | `src/lib/solid/pod-fs.ts` (`readdir`/`readFileText`/`writeFileText`/…) over the platform's authed fetch | The implementation behind `bridge.fetch()` — already scoped, already `no-store`. |

> **Reality check from research:** *no app is embeddable today.* Both `drive` and
> `codespaces` own the full `<html>`+masthead+footer and run their own full-window OIDC
> redirect (`window.location.href = issuer`) — which breaks in an iframe. So §6 (the per-app
> embedded-mode refactor) is real, budgeted work, not a flag.

## 3. The model

```
┌──────────────────────────── shell (shell origin) ────────────────────────────┐
│  Shell chrome: WorkspaceRail · ProjectSwitcher · AppSwitcher · AppMenu                 │
│  ShellProvider ─ owns the OIDC session + authed fetch ─────────────────────────────┐  │
│                                                                                     │  │
│   App body:  getAppComponent(activeApp)                                             │  │
│     ├─ embed:"inprocess" → <VaultApp/> (React, full trust, useShell())              │  │
│     └─ embed:"iframe"    → <IframeHost manifest> ──────────────┐                     │  │
│                                                                ▼                     │  │
│                              ┌───────── sandboxed <iframe> (app origin) ──────────┐  │  │
│                              │  the hosted app (drive, codespaces, 3rd-party…)    │  │  │
│   postMessage CapabilityBridge ◄──► │  • no pod credential, opaque origin         │  │  │
│   - hello/identity handoff   │  • asks parent for everything via bridge.*         │  │  │
│   - bridge.fetch(url,init) ──┼──► shell checks against granted AccessNeeds ──► pod │  │  │
│   - navigate / route-sync    │  • renders ONLY its body, no chrome                │  │  │
│   - lifecycle (ready/error)  └───────────────────────────────────────────────────┘  │  │
│                                                                                     │  │
└─────────────────────────────────────────────────────────────────────────────────────┘
Catalog lives in the POD:  {pod}/home/apps.ttl  (user-owned ⇒ install = pod edit, no rebuild)
```

Three new pieces: **(1) the manifest**, **(2) `IframeHost` + the bridge**, **(3) the access-grant
broker**. Everything else is wiring into existing seams.

## 4. The app manifest (extends `mind:App`)

The catalog stays in `{pod}/home/apps.ttl`. We add hosting + capability predicates. Apps may *also*
publish a static `/.well-known/mind-app.json` the shell can read to pre-fill/verify the entry (Web
App Manifest-style), but the **pod entry is authoritative** for what *this user* installed and granted.

```turtle
@prefix mind: <http://mind.example/voc#> .

<#drive> a mind:App ;
  mind:label  "Drive" ; mind:icon "📁" ; mind:order 1 ;
  mind:url    "https://drive.mindpods.org" ;
  mind:embed  "iframe" ;                 # "iframe" | "inprocess" | "link" (default "link" = today)
  mind:trust  "first-party" ;            # "first-party" | "community" | "untrusted"
  mind:handlesType <http://www.w3.org/ns/ldp#Container> ;   # optional: "open folders with Drive"
  mind:accessNeed [                       # Solid App Interop-shaped; one per data class
     mind:shapeTree <https://shapes.mindpods.org/files> ;
     mind:scope "Read", "Write"
  ] .
```

- `mind:embed` is the **only field the host strictly needs** to start hosting. Everything else is
  for trust/consent/discovery and can land incrementally.
- Defaulting `mind:embed` absent → `"link"` means **today's behavior is preserved** for every app
  that hasn't opted in. Zero regression.
- `mind:accessNeed` mirrors Solid **Application Interoperability** access needs (shape-tree +
  modes). For Phase 1 it's advisory (logged); for Phase 2 it's enforced by the broker (§5.3).

## 5. The capability bridge (postMessage protocol)

A small, versioned message protocol between `IframeHost` (parent) and the app (child). Origin is
checked on **every** message against the manifest `mind:url` — never `*`.

### 5.1 Handshake & identity handoff
1. Child loads, posts `{ t: "mind:hello", v: 1 }` to `parent`.
2. Parent replies `{ t: "mind:welcome", v: 1, identity: { webId, workspacePod, project }, capabilities: [...granted scopes] }`.
3. Child renders in **embedded mode** (no own OIDC, no chrome). No pod credential crosses the boundary.

### 5.2 Brokered pod I/O
- Child → `{ t: "mind:fetch", id, url, init }`.
- Parent validates `url` is within the workspace pod **and** within a granted `accessNeed` scope,
  performs it with the shell's authed fetch, returns `{ t: "mind:fetch:result", id, status, body }`.
- A denied request returns `{ t: "mind:fetch:denied", id, reason }` — the app shows its own "needs
  permission" UI and may request a scope (§5.3).
- Convenience verbs (`readdir`/`read`/`write`) map onto `pod-fs.ts`; raw `fetch` is the escape hatch.

### 5.3 Consent / scope requests
- Child → `{ t: "mind:requestAccess", needs: [{shapeTree, scope}] }`.
- Parent shows a **shell-owned consent sheet** generated from the request, records the grant into the
  pod (the app's Application Registration / Access Grants), and updates `capabilities`.
- Default-deny. First-party apps may be pre-granted from their manifest at install time; community/
  untrusted apps must prompt.

### 5.4 Navigation & lifecycle
- `mind:ready` / `mind:error` — host shows spinner / error card (reusing the existing app-body
  fallback).
- `mind:navigate { appPath }` ↔ host updates the shell URL (`?app=drive&p=/photos`) so deep links
  and back-button work (Phase 3).
- `mind:setTitle`, `mind:requestClose` — cosmetic/lifecycle niceties.

### 5.5 Isolation posture by trust tier
| Trust | iframe `sandbox` | Pod access | Consent |
|---|---|---|---|
| `first-party` | `allow-scripts allow-same-origin` (cooperative, perf) | pre-granted from manifest | none |
| `community` | `allow-scripts` (opaque origin) | brokered, scoped | prompt on first use |
| `untrusted` | `allow-scripts` + tight `Permissions-Policy` | brokered, scoped, rate-limited | prompt every scope |

## 6. Making an app embeddable ("embedded mode" — the per-app refactor)

Every hosted app needs a small, well-defined change. Pattern (applied to **drive first**):
1. **Detect embedding** — `window.self !== window.top` *and* a `mind:hello`/`mind:welcome` handshake
   succeeds. Gate on the handshake, not just the frame check.
2. **Skip own OIDC** — in embedded mode, do **not** redirect to the issuer. Take `webId` +
   `workspacePod` from `mind:welcome`; replace the app's `session.fetch` with a `bridge.fetch`
   shim. (Drive: `src/lib/solid/session.ts` singleton; Codespaces: the HttpOnly-cookie path — bigger
   lift, hence drive first.)
3. **Suppress chrome** — render only the app body; hide masthead/footer/login surfaces
   (`src/app/layout.tsx` conditionalized on embedded mode).
4. **Allow being framed (deploy header)** — a hostable app must *permit* the shell to embed it, and
   ideally permit **only** the shell. Two headers govern this:
   - **`X-Frame-Options`** — must **not** be `DENY`/`SAMEORIGIN` (either blocks cross-origin
     framing). Next.js sets none by default, so today's apps would frame — but don't rely on a
     default; set the policy explicitly.
   - **`Content-Security-Policy: frame-ancestors https://shell.mindpods.org`** (+ `http://localhost:3100`
     for dev) — the modern, granular control. This *whitelists the shell as the only allowed embedder*,
     which is both the enabler (the app loads in the shell) **and** a security control (no other site
     can frame the app to clickjack a signed-in user). `frame-ancestors` supersedes `X-Frame-Options`
     where both are present.

   Where to set it in a Next app: `headers()` in `next.config.ts` (applies to all routes), or
   middleware for per-route logic. Each hosted app owns this in its own deploy — it is part of the
   per-app embedding checklist, not something the shell can do for it. (Caddy at the edge could also
   inject it, but app-level is clearer and travels with the image.)
5. **Namespace storage** — already `mind-drive:*`-prefixed; confirm no collision when same-origin.
6. **CSS** — opaque-origin iframe gives free isolation; for `allow-same-origin` first-party, verify
   Tailwind v4 utilities don't clash (they will if same-origin in-process — a reason to keep first-
   party apps in *their own iframe* rather than going fully in-process unless it's Vault-class).

This refactor is the **bulk of the per-app cost** and is why hosting drive ≠ hosting codespaces in
effort (codespaces has server-side cookie sessions + an OCI registry route + more surface).

## 7. Phasing

| Phase | Deliverable | Proves | Gate |
|---|---|---|---|
| **P0 ✅** | `IframeHost` in app body + `mind:embed` in `apps.ttl` + handshake handing identity to a **cooperating throwaway page** | R1 (install = pod edit) + R5 (renders under chrome) end-to-end | A pod-registered toy app shows inside the shell, knows the WebID. |
| **P1 ✅** | `bridge.fetch` brokered pod I/O + `sandbox="allow-scripts"` opaque origin, hard-coded scope | R2 (sandboxed, brokered access) | Toy app reads one pod resource *only* via the broker; direct fetch fails. |
| **P2 ✅ (shell side)** | **Drive embedded mode** (§6) behind the bridge; first-party pre-grant; drive deploy sets `frame-ancestors` to the shell | Real app, real workflow, in the shell | Drive browses files inside the shell with no second login; drive refuses to frame in any *other* site. |
| **P3** | Consent sheet + `mind:requestAccess` + Access-Grant persistence; route-sync/deep-linking | Untrusted tier + shareable deep links | A community app prompts for scope; `?app=&p=` deep-links work. |
| **P4** | Codespaces embedded mode; manifest discovery (`/.well-known/mind-app.json`); dock "Add app" writes the richer schema | Second hard app + smoother install | Add an arbitrary app URL in dock → it hosts in the shell. |

**Status (2026-06-07):** P0–P1 built and live; P2 built **shell-side** — the shell embeds Drive as a
first-party iframe app under the bridge (`src/components/shell/IframeHost.tsx`, `src/lib/shell/bridge.ts`,
`bridge-protocol.ts`; Drive is a built-in `embed:"iframe"` app in `src/lib/shell/context.tsx`). The
remaining P2 item is Drive's own deploy-side `frame-ancestors` CSP (lives in the Drive repo, not here).
P3–P4 (consent sheet, deep-link route-sync, Codespaces, manifest discovery) are not started.

P0+P1 are the **Spike 1+2** from the options doc — do them as throwaway spikes first; promote to
real code only once green.

## 8. Success criteria

- **R1:** Adding `<#foo> mind:embed "iframe"; mind:url "…"` to `apps.ttl` (via dock or by hand)
  makes the app appear *inside* the shell with **no shell rebuild/redeploy**. ✅/❌ binary demo.
- **R2:** A hosted `community` app, given the network tab, can reach **only** the pod resources its
  granted `accessNeed` covers; everything else returns `mind:fetch:denied`. Verified by attempting
  an out-of-scope read.
- **R4:** A user signed into the shell opens drive embedded with **zero additional login**.
- **R5:** Drive renders in the app body under the shell chrome (no drive masthead/footer).
- **No regression:** apps without `mind:embed` still open in a new tab exactly as today.

## 9. Risks & open decisions

- **OD-1 — iframe vs. in-process for first-party.** Do blessed apps (drive) run in their *own
  iframe* (isolation, uniform bridge) or fully in-process like Vault (deepest integration, CSS-clash
  risk, rebuild-to-add)? *Leaning: iframe for everything except Vault-class crypto apps, for one
  uniform model.* **Needs a call.**
- **OD-2 — broker granularity.** Raw `bridge.fetch(url)` vs. only high-level verbs
  (`readdir`/`read`/`write`)? Raw is flexible but harder to scope-check. *Leaning: high-level verbs
  enforced + raw fetch only for first-party.*
- **OD-3 — grant storage.** Full Solid Application Interoperability (Agent Registry + Access Grants)
  is the principled model but heavy. *Leaning: a simplified `{pod}/home/grants.ttl` in v0, shaped to
  migrate onto App Interop later.* **Needs a call.**
- **OD-4 — routing.** How much deep-linking do we owe in v0? *Leaning: `?app=&p=` only; full
  per-app route mirroring is P3+.*
- **R-1 — codespaces is heavy.** Server-side cookie sessions, OCI registry route, agents/workflows.
  Embedded mode is a real project; keep it P4, not P2.
- **R-2 — third-party cookies / storage partitioning.** Mitigated by "broker, don't let the app
  auth itself," but confirm under Safari Storage-Access / CHIPS if apps ever rely on own cookies.
- **R-3 — protocol churn.** A bad bridge protocol is expensive to change once apps depend on it.
  Version it (`v: 1`) from day one; keep the surface minimal.

## 10. Explicitly rejected (see options doc §4)

- **Module Federation / `nextjs-mf`** — no Turbopack support, EOL/Pages-only, MF maintainers steer
  off Next.js. ❌
- **Multi-Zones** — config/build-time, not runtime install; assumes Vercel-style topology. ❌ for
  *this* goal.
- **Import maps / single-spa / Piral** — purest runtime-add, but forgoes Next SSR and forks the
  whole "Next-app-per-product" model; weaker isolation than the iframe. **Parked** as Spike 3 — a
  decision gate only if the iframe's routing/perf disappoints.

## 11. Sources & confidence

Full source list and confidence flags in [`docs/SHELL-APP-HOSTING-OPTIONS.md`](docs/SHELL-APP-HOSTING-OPTIONS.md) §8.
Code seams (§2) are high-confidence, read directly on 2026-06-04. The stack constraints (Turbopack
rules out Module Federation) and the security model (iframe opaque-origin sandbox + Solid App
Interop scoped grants) are search-verified against 2025/26 sources.
