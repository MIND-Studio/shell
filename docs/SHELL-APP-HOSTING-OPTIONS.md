# Design space — hosting apps *inside* the Mind shell

> **Status:** Research draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-04
> **One-liner:** The full menu of ways `shell` could host other Mind apps (drive,
> codespaces, …) on one surface — and let a user **install a new app without rebuilding the
> shell**. This doc maps the options so we can build a couple of spikes or decide later; the
> recommended path is written up as a buildable PRD in [`../PRD-APPS.md`](../PRD-APPS.md).

This is a **validated synthesis** of five parallel research sweeps run on 2026-06-04:
(1) the current `shell` architecture, (2) how embeddable `drive` /
`codespaces` are today, (3) the existing `apps.ttl` / `@mind-studio/core` launcher,
(4) 2025/2026 micro-frontend architecture for Next 16 / Turbopack, and (5) runtime
plugin/app-install + capability/sandbox patterns (VS Code, Backstage, Puter, Solid App
Interop). Sources and confidence flags are in §8.

---

## 1. The problem in one paragraph

Today every Mind app is an **independent sibling Next.js surface**; the shell's launcher
(`MindAppLauncher`, reading the pod's `apps.ttl`) just opens each one in a **new browser tab**
(`target="_blank"`). We want drive and codespaces to feel like they live *inside* the shell —
one chrome, one identity, one window — **and** we want "install a new app" to mean *add an
entry to your pod*, not *rebuild and redeploy the shell*. Those two wants pull in different
directions (integration vs. decoupling), and the chosen stack (Next 16 / React 19 / **Turbopack**
/ Tailwind v4) rules out the option most teams reach for first (Module Federation). This doc is
the map out of that tension.

## 2. Requirements (what "good" means here)

| # | Requirement | Why it matters |
|---|---|---|
| **R1** | **Runtime install, no shell rebuild.** Adding an app = registering a URL/manifest (ideally in the pod). | The headline ask. Distinguishes a *platform* from a *bundle of links*. |
| **R2** | **Privacy-first pod access.** A hosted app must not get ambient access to the whole pod; access is scoped and, for untrusted apps, sandboxed. | This is the entire Mind thesis. An "app store" that hands every app your pod credential is a non-starter. |
| **R3** | **Works on Next 16 / Turbopack.** | Hard constraint — see §4, option E. |
| **R4** | **Shared identity / SSO.** A user signs in once; apps don't each re-run the OIDC dance. | Already half-solved: all prototypes default to `pods.mindpods.org` as issuer → silent re-auth. |
| **R5** | **Unified UX.** One shell chrome (rail, switcher, app menu); apps render in the app body, not a foreign full-page layout. | The point of a "shell" vs. a bookmark folder. |
| **R6** | **Incremental.** We can ship value with first-party apps before solving untrusted third-party sandboxing. | Don't block the demo on the hard security problem. |

> **Tension to name explicitly:** R1 (decouple, install-at-runtime) and R5 (deep integration)
> are in opposition. The more an app is woven into the shell's React tree (R5), the more a new
> app needs a shell rebuild (violating R1). Every option below sits somewhere on that spectrum.
> The **iframe + capability bridge** option (B) is the one that gets *both* — at the cost of a
> message-protocol boundary.

## 3. Where we are today (the baseline, already built)

- **In-process app registry** — `src/apps/registry.tsx`: `APP_REGISTRY: Record<string, ComponentType>`,
  currently `{ vault }`, each `React.lazy()`-imported and rendered in the app body via
  `getAppComponent(activeAppKey)` (`src/app/shell/page.tsx`). Vault proves the shell *can* host a
  demanding app in-process, reading identity/pod via `useShell()`.
- **Pod-driven launcher** — `MindAppLauncher` from `@mind-studio/core/launcher` reads
  `{pod}/home/apps.ttl` (RDF vocab `mind:App` with `label`/`url`/`icon`/`blurb`/`order`) and
  renders a waffle grid. **Every tile is a `target="_blank"` link** — no embedding today.
  `dock` already has an "+ Add app" dialog that `writeApps()` back to the pod. **This is
  the runtime-install seam we extend.**
- **Shell context** — `useShell()` exposes `webId`, `account`, `workspacePod`, `project`,
  `activeAppKey`, `setActiveApp()`, and an **authenticated `fetch`**. This is the natural thing a
  host would broker to a hosted app.
- **Auth** — single-flight OIDC (`handleIncomingRedirect` memoized once per load). All apps point
  at the same issuer → SSO already works across siblings.

**So the shell is ~60% of the way to option B already.** The missing pieces are a manifest schema
richer than `apps.ttl`, an iframe host component, and a postMessage broker.

## 4. The options

Six approaches, ordered by how we'd actually consider them. Full comparison table at the end of
this section.

### Option A — Link out / new tab *(the baseline; already shipped)*
Keep `MindAppLauncher` opening apps in new tabs.
- **R1 ✅ trivially** (add a pod entry). **R4 ✅** (SSO at the pod). **R2 ✅** (each app authes itself,
  WAC scopes it). **R3 ✅** (zero integration). **R5 ❌** — it's a bookmark folder, not a shell.
- **Verdict:** the honest fallback. Given the pod-SSO design it's genuinely low-tax, and many
  platform teams never leave it. But it doesn't deliver "apps inside the shell," so it's the
  *control*, not the answer.

### Option B — **iframe host + postMessage capability bridge** *(recommended)*
Each app is a normal hosted web page; the shell renders it in a **sandboxed `<iframe>`** in the app
body and brokers everything (identity, pod I/O, navigation) over a typed `postMessage` channel. The
app holds **no pod credential** — it asks the shell, which performs scoped reads/writes on its
behalf.
- **R1 ✅** — a new app is just a manifest URL added to the pod; shell never rebuilds.
- **R2 ✅✅ — the strongest privacy story.** `sandbox="allow-scripts"` *without* `allow-same-origin`
  forces an opaque origin: no cookies, no storage, no access to the shell DOM. The shell mints
  **least-privilege, shape-tree-scoped grants** (Solid App Interop model) per app. This is exactly
  what VS Code and Backstage *don't* do (they run plugins full-trust) and is our differentiator.
- **R3 ✅** — bundler-agnostic; Turbopack is irrelevant to an iframe.
- **R4 ✅** — identity handed over the bridge; app never re-runs OIDC.
- **R5 ✅ (mostly)** — app fills the app body under the shell chrome. Deep-linking and routing need
  protocol support (a known iframe weak spot — §6).
- **R6 ✅** — Phase it: first-party trusted apps first (skip the iframe origin wall, just broker),
  untrusted sandbox + consent later.
- **Cost:** design + maintain a shell↔app message protocol; refactor each app to (a) detect "I'm
  embedded," (b) suppress its own chrome/layout, (c) get identity + a brokered `fetch` from the
  parent instead of running its own OIDC. **drive and codespaces both need this refactor today**
  (both currently full-window-redirect for OIDC and own the whole `<html>`).
- **Precedent:** Puter (per-app sandbox + `Perms` capability API), Luigi (SAP shell with iframe
  isolation option), the broad 2025/26 "iframes are back for hard isolation" consensus.

### Option C — In-process React module registry *(co-located or published components)*
Extend `APP_REGISTRY` so drive/codespaces ship a default-exported React component that mounts
inside the shell, reading `useShell()` — same mechanism as Vault, just more apps.
- **R5 ✅✅** — deepest integration, one React tree, instant nav, shared everything.
- **R2 ⚠️** — apps run **full-trust in the shell's origin**; no sandbox. Fine for first-party,
  unacceptable for untrusted third-party.
- **R3 ✅** — plain dynamic `import()`, Turbopack-native.
- **R1 ❌ — the dealbreaker.** Adding an app means adding it to `APP_REGISTRY` and **rebuilding the
  shell**. You *can* soften this with published npm packages (`@mind-studio/app-drive`) loaded via
  the registry, but it's still build-time. There is no pure-runtime add without a module loader
  (→ option D).
- **Verdict:** the right model for a small set of **blessed first-party apps** (Vault, maybe drive).
  Pairs well with B: in-process for trusted core, iframe for everything else. Not a runtime-install
  answer on its own.

### Option D — Import maps + ESM runtime loading *(single-spa / Piral / Luigi)*
Apps published as ESM bundles / "pilets"; the shell loads them at runtime via an **import map** (or
SystemJS) that lives *outside* the build — CI rewrites a URL and the app is live.
- **R1 ✅✅ — the canonical runtime-add model.** This is *the* purpose-built "install without
  rebuild" mechanism.
- **R5 ✅** — apps mount in-page under shell orchestration (single-spa routing, Piral pilet shell).
- **R2 ⚠️** — in-page → same-origin, shared storage; isolation is by-convention, not enforced
  (unless Luigi-style you fall back to iframes anyway — at which point see B).
- **R3 ⚠️/✅** — the orchestrator (single-spa/Piral) is bundler-agnostic and runs *alongside* Next,
  but you **forgo Next's App-Router SSR/RSC** for the federated apps; they become client-rendered
  micro-apps. That's a real architectural fork from how the prototypes are built today.
- **R4 ✅** (same-origin).
- **Verdict:** technically the purest fit for R1, but it asks us to abandon the Next-app-per-product
  model the whole prototype fleet is built on, and its isolation is weaker than B's. Worth a spike
  *only* if B's iframe routing/perf turns out unacceptable.

### Option E — Module Federation ❌ *(rejected on this stack)*
Webpack/Rspack Module Federation (incl. `@module-federation/nextjs-mf`).
- **Rejected.** No Turbopack support; `nextjs-mf` is **maintenance/EOL, Pages-Router-only, App
  Router unsupported**, Next 16 support "uncertain." The MF maintainers themselves: *"if you are
  exploring microfrontends, do not use Next.js."* MF 2.0 the spec is healthy, but not on *our* stack.
- **Verdict:** do not build on this. Listed only so the decision is on the record.

### Option F — Multi-Zones (`@vercel/microfrontends`)
Vercel's blessed Next-native micro-FE: independent Next apps stitched by `microfrontends.json`,
full SSR/RSC, transparent routing.
- **R3 ✅✅, R5 ✅, R4 ✅** (same domain → shared session).
- **R1 ❌** — adding a zone is a **config/build-time** change, not runtime install. And it assumes a
  Vercel-style same-domain deploy topology we don't have (we're self-hosted Caddy on Hetzner).
- **Verdict:** the best answer to a *different* question ("how do I split one big Next app into
  independently-deployed zones"). Not a runtime-install/plugin model. Park it.

### Comparison table

| | A. Link-out | **B. iframe + bridge** | C. In-process | D. Import maps | E. Module Fed | F. Multi-Zones |
|---|---|---|---|---|---|---|
| **R1 Runtime install, no rebuild** | ✅ | ✅ | ❌ (rebuild) | ✅✅ | ✅ (unsupported stack) | ❌ (config-time) |
| **R2 Privacy / sandboxed pod access** | ✅ (self-auth) | ✅✅ (sandbox + scoped grants) | ⚠️ full-trust | ⚠️ by-convention | ⚠️ | ⚠️ |
| **R3 Next 16 / Turbopack** | ✅ | ✅ | ✅ | ⚠️ (loses Next SSR) | ❌ | ✅ |
| **R4 Shared identity / SSO** | ✅ (pod SSO) | ✅ (brokered) | ✅✅ | ✅ | n/a | ✅ |
| **R5 Unified shell UX** | ❌ | ✅ (routing caveat) | ✅✅ | ✅ | n/a | ✅ |
| **Effort** | none | **medium–high** | low–medium | high | n/a | medium |
| **App refactor needed** | none | yes (embed mode + brokered auth) | yes (export component) | yes (publish as pilet) | — | yes (zones) |

## 5. The two cross-cutting layers (needed by B, C, and D alike)

Whatever integration boundary we pick, two things are shared and worth designing once:

### 5.1 The app **manifest / registry** (extends `apps.ttl`)
Today `apps.ttl` carries `label/url/icon/blurb/order`. A hostable app needs more — borrow the **VS
Code `contributes` + `activationEvents`** idea (declare capabilities as *data* the shell reads
before running any app code) and **Web App Manifest** semantics:

```turtle
<#drive> a mind:App ;
  mind:label "Drive" ; mind:icon "📁" ; mind:url "https://drive.mindpods.org" ;
  mind:embed "iframe" ;                     # iframe | inprocess | link
  mind:manifest "https://drive.mindpods.org/.well-known/mind-app.json" ;
  mind:handlesType <http://www.w3.org/ns/ldp#Container> ;   # → file_handler-style "opens folders"
  mind:accessNeed [ mind:shapeTree <…files> ; mind:mode "Read", "Write" ] ;  # Solid App Interop
  mind:trust "first-party" .                # first-party | community | untrusted
```

A pod-side registry the user controls = R1 satisfied *and* a natural place to record *what each app
is allowed to touch* (R2). The `dock` "Add app" dialog is the seed UI; this just enriches
the schema. **Solid's Type Index** (`solid:TypeRegistration`) gives the complementary half — *where*
the user's data of a type lives — which Solid deliberately leaves app-agnostic, so the shell owns
the "which app opens which type" mapping.

### 5.2 The **capability / pod-access** model (the privacy keystone)
For untrusted apps the shell must broker pod access, not hand over a credential. Three layers, from
the research:
1. **Browser-enforced isolation** — cross-origin `<iframe sandbox="allow-scripts">` (no
   `allow-same-origin`): the app runs JS but has *no* ambient cookies/storage/DOM access.
   `Permissions-Policy` further restricts camera/geo/etc.
2. **Brokered, scoped pod I/O** — the app calls `bridge.fetch(url, init)`; the shell checks the
   request against the app's granted **Access Needs** (Solid App Interop: shape-tree-scoped
   Read/Create/Update/Delete) and performs it under the user's credential, returning only the
   result. Default-deny, à la Puter's per-app `AppData`.
3. **Explicit, typed consent** — first time an app asks for a scope, the shell shows a consent
   screen generated *from the manifest's declared needs* (VS Code activation-events discipline:
   declare as data, prompt before granting).

This is the part neither VS Code nor Backstage do (both trust the publisher). Doing it is what makes
a Mind "app store" defensibly privacy-first rather than a pod-credential giveaway.

## 6. Known hard parts (don't discover these late)

- **OIDC inside an iframe** — drive and codespaces both do `window.location.href = issuer`
  (full-window redirect). That breaks in an iframe. The fix is *don't auth in the iframe at all*:
  the shell owns the session and brokers it. So embedding **requires** an app-side "embedded mode"
  that skips its own login and accepts identity from the parent. This is a real refactor on both
  apps, not a config flag.
- **Routing / deep-linking** — iframes don't share the address bar. "Open this file in drive" or a
  shareable URL to a codespaces repo needs the bridge to sync app-route ↔ shell-URL (postMessage +
  `history.pushState` on the shell). Solvable, but it's protocol surface.
- **Framing headers (the app must *permit* being framed)** — a deployed app can refuse to load in an
  iframe via `X-Frame-Options: DENY` or omit CSP `frame-ancestors`. Each hostable app must send
  `Content-Security-Policy: frame-ancestors https://shell.mindpods.org` (+ localhost in dev) and *not*
  `X-Frame-Options: DENY`. This both enables the embed and locks it to the shell (anti-clickjacking).
  Set per-app via `headers()` in `next.config.ts`. Part of the per-app embedding checklist — see
  [`../PRD-APPS.md`](../PRD-APPS.md) §6 step 4.
- **CSS collisions** — every app uses Tailwind v4 with global utility classes (`.bg-primary`, …).
  In-process (C) they *will* collide; iframe (B) gives free isolation. A point for B.
- **Third-party cookies** — only relevant if apps are cross-origin *and* rely on their own cookies.
  Our same-origin-ish pod-SSO + "broker, don't let the app auth itself" design sidesteps most of it.
- **No app today is embeddable.** Both drive and codespaces own the full `<html>`, masthead, footer,
  and do their own OIDC. Budget the per-app embedding refactor explicitly.

## 7. Recommendation & suggested spikes

**Primary recommendation: Option B (iframe host + capability bridge + pod manifest registry),
phased**, with **Option C in-process for the 1–2 blessed first-party apps** (Vault is already there;
maybe drive). This is the only combination that hits R1 *and* R2 *and* R3 — and it builds directly
on what the shell already has. Written up as a buildable PRD in [`../PRD-APPS.md`](../PRD-APPS.md).

To keep the door open per your "build multiple prototypes / decide later" intent, three small,
independent spikes — do them in this order, stop when satisfied:

1. **Spike 1 — Manifest + iframe host (trusted, no sandbox yet).** Add `mind:embed "iframe"` to
   `apps.ttl`, build `<IframeHost>` in the app body, embed *one* cooperating app (a throwaway
   "hello from the pod" page) with identity handed over a minimal postMessage handshake. Proves R1 +
   R5 end-to-end. ~1–2 days.
2. **Spike 2 — Brokered pod `fetch` + sandbox.** Flip the iframe to
   `sandbox="allow-scripts"` (opaque origin), expose `bridge.fetch()`, and prove the app can read
   one pod resource *only* through the broker, with a hard-coded scope. Proves R2. ~2–3 days.
3. **Spike 3 (optional, only if B's routing/perf disappoints) — Import-map micro-app.** Stand up a
   single-spa/Piral shell loading one ESM app via a runtime import map. Compares D's runtime-add and
   in-page feel against B's. ~3–4 days. Decision gate, not a commitment.

Real embedding of drive/codespaces is a **separate, larger track** (the per-app "embedded mode"
refactor in §6) and should follow a green Spike 1+2.

## 8. Sources & confidence

Verified via live web search (2025–2026) and direct code reading on 2026-06-04.

- **High confidence (code-read):** shell registry/launcher/context/auth seams; drive & codespaces
  non-embeddability (full-window OIDC, own `<html>`); `apps.ttl` schema + `dock` add-app UI.
  Files cited inline throughout and in [`../PRD-APPS.md`](../PRD-APPS.md).
- **High confidence (search-verified):** Module Federation unsupported on Turbopack; `nextjs-mf`
  EOL/Pages-only; MF maintainers steering off Next.js. (`github.com/module-federation/core/issues/3153`,
  npm `@module-federation/nextjs-mf`.)
- **High confidence:** iframe `sandbox="allow-scripts"`-without-`allow-same-origin` opaque-origin
  isolation (MDN); Solid Application Interoperability access-need/grant model
  (`solid.github.io/data-interoperability-panel/specification/`); Solid Type Index is type-centric,
  no app-handler notion (`solid.github.io/type-indexes/`); Puter per-app sandbox + `Perms`
  (`docs.puter.com/security/`); VS Code `contributes`/`activationEvents` + Workspace-Trust-is-not-a-
  sandbox (`code.visualstudio.com/api`); Backstage dynamic frontend plugins now upstream via BEP-0002
  (`backstage.io/docs/frontend-system/building-apps/module-federation/`).
- **Medium confidence:** single-spa/Piral/Luigi SSR is DIY (not turnkey); Multi-Zones is config-time
  not runtime. Directionally certain, exact ergonomics unverified for our self-hosted topology.
- **Stale-knowledge corrections logged:** "Backstage plugins are build-time only" is now **false**
  (runtime/dynamic plugins shipped upstream ~v1.48). MF 2.0 *is* stable — but still not on Turbopack.
