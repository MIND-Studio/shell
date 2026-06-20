# PRD — `shell`: **Home** — the workspace dashboard of app widgets

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-10
> **One-liner:** A **Home** surface in the shell — a grid of **widgets**, each a small live view
> projected by a hosted app — so a workspace opens on *what's happening across all your apps* instead
> of a blank app body. Widgets reuse the existing app-hosting trust model: **first-party widgets
> render in-process; untrusted widgets render in a sandboxed iframe** under the same capability bridge.

This PRD **extends** [`PRD-APPS.md`](PRD-APPS.md) (app hosting, the bridge, the trust tiers — authoritative
for *how apps run*) and **complements** [`PRD.md`](PRD.md) (shell chrome — authoritative for the rail /
switchers / app body). Where they overlap, this doc is authoritative for **the Home surface and the
widget contract**. Nothing here widens the privacy invariants in `AGENTS.md`.

---

## 1. Vision & scope

Today the shell foregrounds **one app at a time** in the app body (`src/app/shell/page.tsx`). There is
no "landing" view: switch workspace and you land on whatever app was last active. The metaphor the shell
is built on (a Dock-style OS surface) implies a **home screen** — the place you see the state of
everything before diving into one app.

**Home** is that surface: the default view of a workspace, a responsive grid of **widgets**. A widget is
a *small, mostly read-only projection* of one app's data — "recent items in Vault," "files added in
Drive today," "open issues," "next calendar event." Clicking a widget deep-links into its owning app.

Why this is a good fit for the existing architecture (the question that prompted this PRD):

- The shell **already keeps multiple hosted iframes alive at once** (`page.tsx` `livingIframes`) — a
  grid of frames is the *same* mechanism, just laid out instead of `display:none`.
- The **trust split already exists** (`AppEmbed = "iframe" | "inprocess" | "link"`, `AppTrust`) — widgets
  inherit it verbatim. First-party → in-process (cheap, no clipping); untrusted → iframe (isolated).
- The **capability bridge already brokers scoped pod reads** — a widget needs *less* than a full app
  (mostly `read`/`readdir`), so it's a strict subset of the contract in `PRD-APPS.md §5`.

**In scope (v0 → v1):**
- A **Home view** rendered in the app body as the default surface of a workspace (a synthetic
  `__home__` app key; not a pod-catalog app).
- A **widget manifest** schema (extends the `mind:App` vocab) declaring the widgets an app exposes, their
  default grid size, and the pod scope they read.
- **In-process widget rendering** for first-party apps (the perf/UX-correct path) + **iframe widget
  rendering** for untrusted apps, reusing `IframeHost` + the bridge.
- A **`mind:resize` bridge verb** so an iframe widget can self-size to its content (the one protocol
  addition Home requires).
- **Layout persistence** in the pod (`apps/shell/home.ttl`): which widgets, order, size, per workspace.

**Out of scope (v0):**
- A free-form drag-anywhere canvas with overlap/z-index (we ship a **reflowing grid**, not a pixel
  canvas — see §9, open question).
- Cross-workspace / cross-account aggregation in one Home (Home is scoped to the active workspace +
  project, like every other shell surface).
- Widget-to-widget communication, inter-widget drag, or a widget marketplace (a widget is discovered via
  its app's manifest, nothing new to install).
- Writing from widgets beyond a minimal, explicitly-scoped action (v1 widgets are read + deep-link;
  see §6 trust).

---

## 2. Naming

| Term | Meaning | Why not the alternatives |
|---|---|---|
| **Home** | The surface — a workspace's default landing view. | `Dock` is taken (the shell itself, per `architecture/src/apps.md`, and the sibling `dock` launcher prototype). `Dashboard` is generic and overloaded. |
| **Widget** | One app-provided live tile on Home. | "Card" reads as static; "applet"/"gadget" are dated. |

> Override welcome — if you'd rather the surface be "Dashboard" or "Glance," it's a rename of one
> constant (`HOME_APP_KEY`) + the manifest predicate. The architecture is name-agnostic.

---

## 3. What we build on (existing seams — code-verified 2026-06-10)

| Seam | Where | What it gives Home |
|---|---|---|
| App body mount | `src/app/shell/page.tsx` — branches in-process vs `IframeHost` by `activeIsIframe` | We add a `__home__` branch rendered when no real app is foregrounded (the default). |
| Living-iframe keep-alive | `page.tsx` `livingIframes` / `openedRef` | Proof the shell can host **N** frames at once — Home lays them out instead of hiding them. |
| Capability bridge | `src/lib/shell/bridge.ts` + `bridge-protocol.ts` (`PROTOCOL_VERSION = 1`) | Widget data I/O = the existing `read`/`readdir`/`fetch` verbs. We bump to `v2` only to add `mind:resize`. |
| Iframe host | `src/components/shell/IframeHost.tsx` | Reused per iframe widget; sandbox-by-trust is unchanged. |
| Trust + embed model | `src/lib/shell/types.ts` — `AppEmbed`, `AppTrust`, `HostedApp` | Widgets inherit the owning app's `trust`; render path picks in-process vs iframe from it. |
| Pod catalog | `src/lib/shell/catalog.ts` reads `{pod}/home/apps.ttl` (vocab `http://mind.example/voc#`) | We add `mind:widget` blank-node entries under each `mind:App`. Read-only on the shell side (seeding stays in `@mind-studio/core`). |
| Shell state zone | `shellZone()` in `types.ts` → `{pod}apps/shell/`; AGENTS.md notes `layout.ttl`, `recents.ttl` live here | Home layout persists alongside, at `apps/shell/home.ttl`. |
| App data zone | `appZone(pod, key, project)` in `types.ts` | A widget reads its owning app's zone — the scope ceiling is unchanged from `PRD-APPS.md`. |

> **Reality check:** the in-process hosting path is currently used only by Vault/Identity, and the one
> live iframe app (Drive) self-authenticates and *bypasses* the bridge (`IframeHost.tsx` comments). So
> Home is also the feature that finally **exercises** the brokered bridge with a real cooperating child
> (a first-party widget that speaks `mind:hello` → `mind:read`). That's a feature, not a risk — but it
> means the bridge child-side gets its first real consumer here.

---

## 4. The widget model

A **widget** is declared *by the app that owns it* (in the pod catalog) and rendered *by the shell* on
Home. The owning app supplies the view; the shell supplies layout, identity, and brokered data.

```
App (mind:App, e.g. "vault")
 └── exposes 0..N widgets (mind:widget)
       widget = { id, label, icon, size, scope, render }
```

- **`id`** — stable, unique within the app (`recent-logins`).
- **`size`** — default grid span: `s` (1×1), `m` (2×1), `l` (2×2). User can resize within the app's
  declared `maxSize`.
- **`scope`** — the pod sub-path under the app's zone the widget reads (e.g. `items/`). Never widens
  beyond `appZone()`; the bridge enforces it exactly as for full apps.
- **`render`** — how the shell mounts it (§5): for first-party, an in-process component key; for
  untrusted, a `url` loaded in an iframe.

A widget is **read-first**: its job is to *project* state and *deep-link* in. v0 widgets declare no write
capability. (v1 may add a single, explicitly-consented quick-action — see §6.)

---

## 5. Rendering: in-process for trusted, iframe for untrusted

This is the crux, and it mirrors the app-hosting split exactly.

| Owning app `trust` | Widget render path | Why |
|---|---|---|
| `first-party` | **In-process** React component from a widget registry (`src/widgets/registry.tsx`, new) | Shares the shell DOM → **no overflow clipping** (widget menus/tooltips escape the tile), native theming, ~zero per-widget runtime cost. A widget is a small view; full origin isolation buys nothing here. |
| `community` / `untrusted` | **Iframe** via `IframeHost`, one per widget, under the bridge | Real isolation + credential withholding. Accepts the costs below because the alternative (untrusted code in the shell realm) violates `AGENTS.md` rule #1. |

**The iframe-widget costs we explicitly accept and mitigate** (the honest part):

1. **N runtimes.** Each iframe is a full page + JS realm. → *Mitigation:* lazy-mount widgets as they
   scroll into view; cap the untrusted-widget count per Home with a `log()`-style visible notice when
   exceeded (no silent truncation).
2. **Overflow clipping.** An iframe widget's dropdown can't escape its rectangle. → *Mitigation:*
   untrusted widgets are designed as self-contained (no overflow UI); any "more" action deep-links into
   the full app rather than opening an in-tile menu.
3. **Auto-sizing.** Iframes don't shrink to content. → *Mitigation:* the new `mind:resize` verb (§7).

> **Design stance:** Home is *mostly first-party widgets* (your own apps). The in-process path is the
> common case and the good one; the iframe path is the **untrusted escape hatch**, used rarely. This is
> the same "in-process is the perf path, iframe is the security path" split `PRD-APPS.md` already chose.

---

## 6. Trust & security invariants

Home introduces **no new trust surface** — it reuses `PRD-APPS.md §5.5` verbatim:

1. **No pod credential crosses the iframe boundary** (`AGENTS.md` #1). Iframe widgets get only the
   `BridgeIdentity` (WebID, pod root, project) + brokered, scope-checked results — never the authed
   fetch. Unchanged.
2. **Scope ceiling = the owning app's zone** (`appZone()`). A widget's `scope` can only *narrow* within
   that zone; the bridge's existing scope check rejects anything outside it (`mind:denied`). A Vault
   widget cannot read Drive's zone.
3. **In-process widgets are first-party only.** Rendering untrusted code in-process would defeat the
   whole model — the render path is *selected by trust tier*, not by the widget's own claim. A
   `community`/`untrusted` app's widget is **always** iframed, even if it requests in-process.
4. **Read-first.** v0 widgets declare no write/`mind:write` capability; Home never brokers a write on a
   widget's behalf. A v1 quick-action (e.g. "lock vault") requires an explicit per-widget capability in
   the manifest **and** the same consent posture as a full app's write grant — **ask before building**
   (this is exactly the kind of scope-widening `AGENTS.md` says to confirm).
5. **Never log** widget contents (they may project secrets, e.g. a Vault item title). OK to log: widget
   id, owning app key, render path, latency.

---

## 7. Bridge addition: `mind:resize` (and a `v2` bump)

The **only** protocol change Home requires. An iframe widget can't be auto-sized by the parent, so the
child reports its content height; the host applies it to the frame's grid cell.

```ts
// child → parent (bridge-protocol.ts)
export interface ResizeMsg {
  t: "mind:resize";
  v: typeof PROTOCOL_VERSION;   // → 2
  height: number;              // CSS px of the widget's content
}
```

- Bump `PROTOCOL_VERSION` to `2`. `isBridgeMessage` already version-guards, so a v1 child simply never
  sends `resize` and gets its declared `size` height (graceful degradation).
- The host clamps `height` to the widget's `maxSize` grid bounds (a hostile child can't grow unbounded).
- No other verb changes: widget data I/O is the existing `read`/`readdir`/`fetch`.

Everything else in `bridge-protocol.ts` is reused as-is.

---

## 8. Pod data model

Two additions, both within existing zones — **no new top-level pod structure, no central DB**
(`AGENTS.md` #2).

**(a) Widget declarations** — in the existing catalog `{pod}/home/apps.ttl`, as blank nodes hung off each
`mind:App` (vocab `http://mind.example/voc#`):

```turtle
@prefix mind: <http://mind.example/voc#> .

<#vault> a mind:App ;
  mind:label "Vault" ; mind:embed "inprocess" ; mind:trust "first-party" ;
  mind:widget [
    mind:id "recent-logins" ;
    mind:label "Recent logins" ;
    mind:icon "🔐" ;
    mind:size "m" ;            # s | m | l
    mind:scope "items/" ;      # under the app zone; never wider
    mind:render "vault:recent-logins"   # in-process key  (or mind:url for iframe)
  ] .
```

The shell's `catalog.ts` learns to parse `mind:widget` nodes (read-only, like `mind:embed`/`mind:trust`
today). Seeding/writing the catalog stays in `@mind-studio/core`.

**(b) Home layout** — per workspace, in the shell's own state zone, `{pod}apps/shell/home.ttl`:

```turtle
<#home> a mind:HomeLayout ;
  mind:item [ mind:ref "vault#recent-logins" ; mind:order 0 ; mind:size "m" ] ;
  mind:item [ mind:ref "drive#recent-files"  ; mind:order 1 ; mind:size "l" ] .
```

- Scoped like everything else: when a **project** is active, layout reads from
  `{pod}projects/{id}/apps/shell/home.ttl`, falling back to the workspace layout (mirrors `appZone()`).
- Absent ⇒ a sensible **default Home**: every enabled app's first declared widget at its default size.

---

## 9. UX

- **Where:** Home is the app body's default content. A "Home" affordance (the workspace icon / a house
  glyph at the top of the rail) returns to it; opening any app foregrounds that app over Home (Home
  stays mounted underneath, like the living iframes do today).
- **Layout:** a responsive **reflowing grid** (CSS grid, `s/m/l` spans), not a free pixel canvas.
  Reorder by drag; resize within `maxSize`; add/remove via a "+" picker listing every enabled app's
  declared widgets. Layout writes to `home.ttl` (debounced).
- **Empty / loading:** each widget owns its own skeleton; a failed widget shows a contained error card
  (never blanks Home) — same posture as `IframeHost`'s error panel.
- **Click-through:** clicking a widget calls `setActiveApp(owningKey)` and (v1) passes an "open at path"
  deep-link (the minimal navigation already noted as Phase 3 in `PRD-APPS.md`).
- **Theme:** in-process widgets inherit the shell theme natively; iframe widgets get `BridgeTheme` via
  the existing `welcome`/`setTheme` path — no new mechanism.

---

## 10. Phases

| Phase | Deliverable | Exit check |
|---|---|---|
| **P0 — Home shell** | `__home__` surface in `page.tsx`; static default grid of placeholder tiles; `home.ttl` read/write + reorder persistence. | Home renders as the workspace default; reorder survives reload. |
| **P1 — In-process widgets** | `src/widgets/registry.tsx`; parse `mind:widget` in `catalog.ts`; ship **2 first-party widgets** (Vault "recent logins", Identity "this account") reading via `useShell().fetch` scoped to `appZone`. | Two real widgets show live pod data, theme-native, no clipping. |
| **P2 — Iframe widgets + `resize`** | `IframeHost` reused per iframe widget; bump bridge to `v2` with `mind:resize`; one **first-party iframe widget that actually speaks the bridge** (the bridge's first real child consumer). | An iframe widget self-sizes and reads its zone via `mind:read`; out-of-scope read → `mind:denied`. |
| **P3 — Picker + project scope** | Add/remove widget picker; project-scoped `home.ttl` with workspace fallback; lazy-mount + over-count notice. | Per-project Home differs from workspace Home; off-screen widgets don't mount. |

v0 = P0–P1 (the common, in-process case). P2 proves the untrusted path. P3 is polish.

---

## 11. Open questions

1. **Grid vs. canvas.** Reflowing grid (proposed) is simpler and mobile-safe; a free canvas is more
   "dashboard-y" but adds overlap/z-index/persistence complexity. → *Recommend grid for v0.*
2. **Default Home composition.** "First widget of every enabled app" vs. a curated default per
   workspace template. → *Recommend the former for v0; templates later.*
3. **Widget refresh cadence.** Poll on focus? Subscribe via the pod's notification channel (if the CSS
   exposes one)? → *v0: read on mount + on workspace/project change + manual refresh; live subscription
   later.*
4. **A v1 widget quick-action** (one write, e.g. "lock") — **needs explicit sign-off** before building
   (write-from-widget is a trust-surface change per §6.4 / `AGENTS.md`).

---

## 12. Out of scope (recap) / non-goals

- No free-form pixel canvas, no widget overlap (v0).
- No cross-workspace/account aggregation — Home is single-workspace, project-aware.
- No new top-level pod data, no central DB, no server-side state — `home.ttl` lives in the shell's
  existing pod zone.
- No widening of the WASM FFI or the bridge beyond the single additive `mind:resize` verb.
- No write-from-widget in v0.
