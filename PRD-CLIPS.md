# PRD — `shell`: Clips — save the web into your pod

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-06
> **One-liner:** A hosted **Clips** app — like Issues or Drive, a first-class waffle tile — that
> captures links, images, and pages from the web and keeps them **in your pod**, organized and
> revisitable. Ships **on the web shell today** (no native dependency); the native browser
> (`PRD-BROWSER.md`) becomes its best *input* later.

This PRD **complements** and defers to:
- [`PRD-APPS.md`](./PRD-APPS.md) — authoritative for **hosted apps**: the sandboxed iframe host, the
  typed postMessage **capability bridge**, and the brokered, scoped pod-write pattern. Clips is a
  hosted app under that model and the **owner of the clip data model + capture capabilities**.
- [`PRD-BROWSER.md`](./PRD-BROWSER.md) — the native (Tauri) real browser, which is **one input
  source** that feeds clips into this app, not a separate store.
- [`PRD.md`](./PRD.md) §6/§8 — pod data model and threat model.

Where they overlap, they win; this doc is authoritative for the **Clips app** — its capture flows,
clip schema, UI, and SSRF hardening.

---

## 0. The decision (why a standalone app, fed by many sources)

The original idea was a "web clipper." Rather than bolt clipping onto a browser, we make it a
**standalone hosted app** — its durable value is the **store + UI** (capture, organize, tag,
revisit), not the act of browsing. That decoupling is the whole point:

- The app is useful **the day it ships**, on the plain web shell, with zero native dependency.
- It accepts clips from **any source** that can produce one. The native browser
  (`PRD-BROWSER.md`) is the richest source but arrives later; the app doesn't wait for it.

| Capture source | Available | How a clip is produced |
|---|---|---|
| Paste / share a URL | **web shell, v0** | `web.fetchMeta(url)` → metadata clip |
| Reader / screenshot of a URL | web shell | `web.render(url, mode)` → article/screenshot clip |
| **Native browser** (right-click link/image, save page) | later, native | real navigation events → clip (`PRD-BROWSER.md` §4) |

**Decision (2026-06-06):** Clips is its own hosted app and the **system of record for saved web
content**. The native browser feeds it; it does not live inside the browser. Whether clips are
*physically* stored in their own `apps/clips/` space or **inside Drive** is an open integration
question — see §6, deliberately left for later.

**In scope (v0):**
- A **Clips app** in the waffle: capture, list/grid, open, tag, delete.
- **Capture from a URL** on the web shell: metadata clip (v0), reader/screenshot clip (fast-follow).
- The **clip data model** (§3) and the **capture capabilities** (§4) it owns.
- **SSRF-safe** server fetch behind those capabilities (§5).

**Out of scope for v0:** full-text search across clip bodies, folders/collections hierarchy (flat
tags first), cross-pod sharing of clips, and authenticated capture (clipping sites you're logged into).

---

## 1. Vision & scope

Today, when you find something on the web worth keeping, it goes into someone else's silo — browser
bookmarks, a notes SaaS, a read-later app. Clips makes the keep target **your own pod**: a link, an
image, an article — captured under your WAC in your workspace, portable across every Mind app.

The privacy thesis is `PRD-APPS.md`'s: Clips is a **hosted app** and **never receives the pod
credential**. It asks the shell to fetch-and-save on its behalf; the shell performs a **scoped,
least-privilege** write. Foreign web content is **never** executed in our trust context — it is
fetched and parsed (metadata), or sanitized/screenshotted (reader), never run as markup in our origin
(AGENTS.md HARD rules #1/#5).

---

## 2. The app surface (UX)

A small, focused hosted app in the app body:
- **Capture bar** — paste/type a URL (or arrive via a share target) → "Save." A capture-kind toggle:
  *link* (metadata only, instant) vs. *reader* / *screenshot* (server-rendered, fast-follow tier).
- **Library** — a list/grid of clips: thumbnail, title, source domain + favicon, captured-at, tags.
- **Clip detail** — open a clip: its metadata, the saved reader body or screenshot if present, the
  source link (opens out, or — on native — in the browser), tags, delete.
- **Tags** — flat, user-defined; filter the library by tag. (Collections/folders are post-v0.)

The app stays **source-agnostic**: a clip captured by pasting a URL and a clip captured by the native
browser look and behave identically once stored.

---

## 3. Clip data model (Clips owns this)

A clip is a pod resource in the active workspace (`PRD.md` §6). **Storage location is the open Drive
question (§6)** — written either under `apps/clips/` (standalone) or inside Drive's space; the
*shape* below is stable either way. Minimal Turtle, reusing `schema:`/`as:` + the `mind:` vocab:

```
{clipsRoot}/clips/{id}.ttl
  a mind:Clip, schema:BookmarkAction ;
  schema:url         "<source url>" ;
  schema:name        "<title>" ;
  schema:description "<og:description>" ;
  mind:clipKind      "link" | "image" | "article" | "screenshot" ;
  mind:capturedAt    "<iso8601>" ;
  mind:capturedVia   "paste" | "share" | "render" | "browser" ;   # provenance, not trust
  mind:sourceFavicon "<favicon url or pod path>" ;
  schema:thumbnail   <../assets/{id}.png> ;        # re-hosted, optional
  schema:articleBody <../bodies/{id}.md> ;          # article tier only, sanitized
  mind:tag           "research", "ui" .
```

- Binary assets (thumbnail, screenshot, saved image, article images) are **separate pod resources**
  under `{clipsRoot}/assets/`, referenced by path — never inlined.
- **Never** store anything from the Vault namespace, any auth header, or page-supplied **executable**
  content that another Mind app might later render as trusted (AGENTS.md HARD rules).

---

## 4. Capture capabilities (Clips owns these; extends PRD-APPS bridge)

Clips never fetches the open web or writes the pod directly. The **shell** brokers both, scoped:

| Capability | Input | Returns | Guard |
|---|---|---|---|
| `web.fetchMeta` | `url` | `{title, description, ogImage, favicon, canonical, contentType}` | SSRF allowlist (§5); rate-limited; **no raw HTML** returned |
| `web.render` | `url`, `mode: reader\|screenshot` | sanitized HTML \| PNG bytes | SSRF + headless sandbox; **scripts stripped**; size/time caps |
| `clips.write` *(reuse `drive.write` shape)* | clip resource + assets | written pod paths | path **must** match `{clipsRoot}/**`; brokered token; **no Vault paths** |

The app sends a save *intent*; the **shell** validates and performs the write. Consent/UX follows
`PRD-APPS.md`'s tiering — Clips is **first-party trusted** in v0. The same `web.fetchMeta`/`web.render`
capabilities are reusable by other apps later, but Clips is their first consumer.

---

## 5. Security — SSRF (the server fetch is the sharp edge) — **[H], non-optional**

`web.fetchMeta`/`web.render` fetch a URL the user (or a foreign page, on native) supplied — a classic
SSRF vector. The broker MUST:
- **Scheme allowlist** `http`/`https` only; reject `file:`/`data:`/`gopher:`/etc.
- **Resolve DNS, then block** `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl.
  cloud metadata `169.254.169.254`), `::1`, link-local/ULA, `0.0.0.0` — **re-checked after each
  redirect** (rebinding / redirect-to-internal).
- **Cap** redirects, response size, and wall-clock; send no ambient credentials; ignore `Set-Cookie`.
- Prefer a **network-restricted** fetch/render context that can't reach internal or pod-admin
  endpoints even if a check is bypassed.

A reusable **SSRF-safe fetch helper** is the first deliverable; both capabilities depend on it. (This
is the same helper `PRD-BROWSER.md` §5.2 needs Rust-side on native — one concept, two implementations.)

Origin isolation: `web.render` content renders **inert** — sanitized (default-deny tags/attrs/protocols)
or as a screenshot image, in a sandboxed view **without** `allow-scripts` and under strict CSP. No
foreign JS ever executes in our context.

---

## 6. Drive integration — **open, for later discussion**

Clips and Drive overlap: Drive is "stuff I saved in my pod," and a clip *is* saved web content. We
deliberately **leave the boundary open** and record the options rather than deciding now:

- **Option A — Standalone (`apps/clips/`).** Clips owns its own pod space and waffle tile; Drive is
  untouched. Cleanest capture UX and schema ownership; risk of two overlapping "saved things" apps.
- **Option B — Clips writes *into* Drive.** `{clipsRoot}` = a folder inside Drive's space; a clip is a
  **kind of Drive item**. Clips becomes a focused *capture front-end* over Drive's store; Drive's
  schema (if it has one) becomes authoritative for the stored resource and §3 conforms to it.
- **Option C — Drive absorbs clipping.** No separate app; "save from web" is a Drive feature. Loses
  the dedicated capture surface but avoids app sprawl.

**Questions to resolve with the Drive prototype (later):**
1. Does Drive already define a stored-resource schema a clip must conform to? If yes, §3 defers to it.
2. Should a clip appear in **both** Drive's file view *and* the Clips library (one resource, two
   surfaces) — i.e. is `{clipsRoot}` literally a Drive subfolder?
3. Who owns assets (`assets/`, `bodies/`) — Clips, or Drive's existing blob handling?
4. If Drive ships first, does Clips launch as **Option B** from day one to avoid a later migration?

The §3 schema and §4 capabilities are written to **survive any of these** — only `{clipsRoot}` (the
storage root) changes. Build the app against `{clipsRoot}` as a single config point so the Drive
decision is a one-line change, not a refactor.

---

## 7. Milestones

Web-shell only — no native dependency. (Native browser capture lands via `PRD-BROWSER.md`.)

1. **C0 — SSRF-safe fetch helper + `web.fetchMeta` [H].** Hardened fetch + metadata parse behind the
   bridge, rate-limited. *Gate: SSRF suite (private-IP, redirect-to-internal, DNS-rebind, oversized)
   all blocked before any UI.*
2. **C1 — Clips app v0.** Waffle tile + app shell; capture bar (paste/share URL → metadata clip);
   library list/grid; clip detail; delete. Clips land under `{clipsRoot}` via the broker and read back.
3. **C2 — Tags.** Flat tags + filter.
4. **C3 — Reader / screenshot capture [M].** `web.render` (queued, rate-limited headless render);
   sanitized reader + screenshot; **article/screenshot** clips with re-hosted assets. Behind a flag.
5. **C4 — Native browser input.** *After `PRD-BROWSER.md` W2.* Native right-click/save-page produces
   clips into the same `{clipsRoot}` — Clips renders them with no per-source special-casing.

---

## 8. Success criteria

- Paste/share a URL on the web shell → a clip appears in the Clips library and **reads back from the
  pod** under `{clipsRoot}/**`, written via the broker — **Clips never held a pod token**.
- The SSRF suite blocks every private-range / redirect-to-internal / oversized fetch.
- A reader/screenshot clip renders **inert** (CSP shows no foreign script execution) and stores
  sanitized content only.
- Flipping the Drive decision (§6) changes only `{clipsRoot}` config — no schema or UI rewrite.
- A clip captured later by the **native browser** is indistinguishable, once stored, from a pasted one.
- Nothing from the Vault namespace, and no plaintext/secret, ever lands in a clip (AGENTS.md HARD
  rules #1/#5).

---

## 9. Open questions / decisions

1. **Drive integration (§6).** A/B/C — the headline decision, parked for the Drive discussion.
2. **App name.** "Clips" vs. "Web" vs. "Saved" vs. folding into Drive — settle with §6.
3. **Thumbnail re-hosting.** Re-host `og:image` into the pod (no hotlink leak, costs storage) vs. store
   the remote URL (cheap, leaks a request on render)? Lean **re-host**.
4. **Headless render host (C3).** Self-hosted Playwright (control, infra cost) vs. a render API (the
   browsed URL is disclosed to a third party)? Privacy thesis → **self-hosted**; flag the cost.
5. **Reader extraction + sanitizer.** Which readability lib + allowlist-based HTML sanitizer
   (default-deny). For C3.
6. **Capture-kind default.** Does "Save" default to instant *link* (and offer reader after), or prompt?

---

## 10. Provenance

- **`PRD-APPS.md`** — hosted-app sandboxing + the brokered capability bridge Clips extends
  (`web.fetchMeta`, `web.render`, reused `drive.write`/`clips.write`); the identity/consent model.
- **`PRD-BROWSER.md`** — the native browser as one capture *source* feeding Clips (§0, §7 C4); shares
  the SSRF-safe-fetch concept.
- **`PRD.md` §6/§8** — pod data model (clip storage under `{clipsRoot}`) + threat model (no foreign
  code in our trust context).
- **Web platform reality** — metadata fetch + sanitized render are the only safe ways a *web shell*
  can touch foreign content; real in-shell browsing needs the native process (`PRD-BROWSER.md`).
- **SSRF guidance** — scheme allowlist + post-DNS private-range rejection + per-redirect re-check +
  caps + egress isolation; the helper is the first deliverable (C0).
