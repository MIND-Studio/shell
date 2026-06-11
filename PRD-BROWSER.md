# PRD — `shell`: Web — a real browser inside the native shell

> **Status:** Draft v0.1 · **Owner:** @huhn511 · **Date:** 2026-06-06
> **One-liner:** A **real web browser** built into the native (Tauri) shell — an address bar and a
> webview that loads *any* site — where clicking a link, image, or page lets you **save it into your
> pod via the Clips app**. Not a clipper itself, not an iframe: a genuine browser that acts as the
> richest *capture source* for Clips, isolated from your session by Tauri capabilities.

This PRD **depends on** and defers to:
- [`PRD-NATIVE.md`](./PRD-NATIVE.md) — authoritative for the **Tauri** shell, the second-webview
  model, capability isolation, and the native Rust path. The browser **only exists on the native
  track** and inherits every isolation rule there. This doc owns the *browser app*; PRD-NATIVE owns
  the native platform it runs on.
- [`PRD-CLIPS.md`](./PRD-CLIPS.md) — authoritative for the **clip data model, capture, and store**.
  The browser is **one capture source** that feeds clips into the Clips app; it does not own a store.
  Saving uses Clips' brokered capture path, not a bespoke channel.
- [`PRD-APPS.md`](./PRD-APPS.md) — authoritative for **hosted apps** + the brokered, scoped pod-write
  pattern Clips' capture sits on.
- [`PRD.md`](./PRD.md) §6/§8 — pod data model and threat model.

---

## 0. The decision (why this is native-only, and why that's correct)

The goal is a **real browser inside the shell** — type a URL, load any site, follow links, and save
things from real pages. A web shell **cannot** do this: a web page is not allowed to be a browser.
The two web paths are both dead ends, recorded here so we don't relitigate:

| Web-shell path | Why it fails |
|---|---|
| **iframe** the open web | The *target* site decides via `X-Frame-Options`/CSP `frame-ancestors`, and most major sites refuse. Browser-enforced; not overridable by us. |
| **proxy foreign HTML into our origin** | **Forbidden** — runs the site's JS on *our* origin with our Solid session and the **Vault** in the same shell. Self-inflicted XSS (AGENTS.md HARD rules #1/#5). |

A **native process** has no such limit. In Tauri, a second webview navigating the open web **is** a
browser — `X-Frame-Options` is irrelevant because it isn't framing, it's *being* the browser. Safety
no longer comes from the same-origin policy; it comes from **Tauri capabilities** that wall the
browsed page off from our session.

**Decision (2026-06-06):** The Web browser is a **native-only feature of the Tauri shell**
(`PRD-NATIVE.md`). On the web shell it is simply **absent** — no degraded clipper stand-in. We build
the real thing.

**In scope (v0):**
- An in-shell browser surface: address bar, back/forward/reload, loading/security state.
- An **isolated browsing webview** that loads any `https`/`http` site.
- **Save to Clips** from real browsing: the current page (URL + title, optional reader/screenshot),
  a link's target, or an image — fetched by **Rust** and handed to the Clips capture path
  (`PRD-CLIPS.md`), which writes it to the pod via the broker.
- Sits in the shell's app body like any hosted app, under the shell's chrome and identity.

**Out of scope for v0:** multi-tab/multi-window management, extensions/ad-blocking, a sync'd
bookmark protocol, downloading arbitrary files to local disk, password autofill into third-party
sites (that's Vault's lane; see PRD-NATIVE §3.2), and authenticated/logged-in browsing on the user's
behalf.

---

## 1. Vision & scope

The shell wraps your identity and hosts your apps. The Web app makes **the open web a place you
browse from inside that identity** — and, crucially, makes the **save target your own pod** instead
of a browser silo or a SaaS read-later. You browse a real page; you save the link, the image, or the
page; the artifact lands in Clips (in your pod), under your WAC, portable across every Mind app.

The privacy thesis is unchanged from `PRD-APPS.md`: the browsed page is **untrusted foreign content**
and is **never** given our origin, our IPC, or our Solid session. It renders in an **isolated
webview**; saving happens because **Rust** (not the page) observes the navigation and performs a
**scoped** pod write. The web you browse can't reach the vault you keep.

---

## 2. Architecture — two webviews, one isolation boundary

Per `PRD-NATIVE.md` §0/§3.6, the Tauri app already runs the Next.js shell in a **trusted webview**.
The browser adds a **second, untrusted webview** for foreign content. The whole design is the wall
between them.

```
┌──────────────────────────── Tauri app (native process) ─────────────────────────────┐
│                                                                                       │
│  TRUSTED webview  (our Next.js shell UI)          UNTRUSTED webview (the open web)     │
│  ┌───────────────────────────────────┐            ┌──────────────────────────────────┐│
│  │ shell chrome + Web app UI:         │            │  https://anything.example/...    ││
│  │  address bar, nav buttons,         │  controls  │                                  ││
│  │  security/loading state,           │  ───────▶  │  (renders normally; this IS a    ││
│  │  "Save to Clips" affordances       │            │   browser tab)                   ││
│  │                                    │  events    │                                  ││
│  │  has Tauri IPC (invoke)  ◀─────────┼────────────┤  NO invoke · NO FS · NO session  ││
│  └───────────────────────────────────┘            └──────────────────────────────────┘│
│              │                                              ▲                           │
│              ▼ #[tauri::command]                            │ navigate / fetch image    │
│   ┌─────────────────────────────────────────────────────────────────────────┐         │
│   │ Rust core: nav control, event taps, SSRF-safe image/page fetch,          │         │
│   │ → Clips capture (brokered pod write), crypto-core (native)               │         │
│   └─────────────────────────────────────────────────────────────────────────┘         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**The load-bearing rules (mirror `PRD-NATIVE.md` §3.6):**
- The **untrusted webview gets a capability allowlist granting nothing** — no `invoke`/IPC, no
  filesystem, no access to our Solid session or tokens. It is just a renderer pointed at a URL.
- The **trusted webview** holds all IPC. It drives the browsing webview (navigate, back, reload) and
  receives **events** (URL changed, title changed, link/image context-menu target) through Rust.
- **All privileged work is Rust-side:** fetching an image's bytes, rendering a page snapshot,
  writing to the pod. The page never performs these and never holds anything that could.
- Page-supplied data (a URL, an image `src`, a title) is **untrusted input** — validated before it
  touches a Tauri command or a pod path.

Getting the allowlist wrong (exposing `invoke` to the browsing webview) collapses this to the
forbidden "foreign JS in our origin" case — so the capability config is a **review-gated,
non-negotiable** control, audited per release.

---

## 3. The browser surface (UX)

A minimal, real browser inside the app body:
- **Address bar** — type a URL or a search query (a default search engine resolves queries to a URL).
- **Nav controls** — back, forward, reload, stop; a security indicator (scheme/cert state) and a
  loading state, both sourced from Rust navigation events (the trusted side never trusts the page's
  own claims about its URL).
- **The browsing webview** — fills the app body; renders the live site.
- **Save affordances:**
  - **Save this page** (toolbar) → saves URL + title now; optionally a **reader extraction** or a
    **screenshot** of the current page (Rust-rendered, §4).
  - **Right-click a link** → "Save link to Clips" (saves the link target).
  - **Right-click an image** → "Save image to Clips" (Rust fetches the bytes → Clips → pod).
- v0 is **single-view** (one page at a time). Tabs are an explicit non-goal for v0 (§0).

---

## 4. Save-to-Clips (the "real thing" — driven by real navigation)

Unlike a paste-a-URL clipper, saving here is anchored to **what you're actually browsing**, observed
by Rust from the live webview. The browser is the **capture source**; the **Clips app**
(`PRD-CLIPS.md`) owns the clip model and the store — the browser hands Rust-captured data to Clips'
capture path, it does not invent its own resource shape:

| You do | Rust captures | Becomes a Clips clip of kind |
|---|---|---|
| Save current page | live URL + title (from nav events, not page script) | **link** (+ optional reader/screenshot) |
| Right-click → save link | the anchor's resolved `href` | **link** |
| Right-click → save image | the image `src` → Rust **fetches bytes** | **image** |
| Save page as reader | Rust renders readable article (sanitized) | **article** |
| Save page as screenshot | Rust captures the webview | **screenshot** |

**Save target + schema** are owned by `PRD-CLIPS.md` (§3 clip model, §4 capture capabilities, §6 the
open Drive-integration question). The browser supplies `mind:capturedVia "browser"` provenance and the
captured fields; Clips performs the **brokered, scoped pod write** under `{clipsRoot}/**` — the
browser (and the browsed page) never holds a pod token. Binary assets (image, screenshot, article
images) follow Clips' asset handling, never inlined.

**Never** save anything from the Vault namespace, any auth header, or page-supplied executable
content that another Mind app might later render as trusted (AGENTS.md HARD rules).

---

## 5. Security

Two surfaces, both non-optional.

### 5.1 Isolation (the browsed page) — **[H], the core control**
Covered by §2: the untrusted webview has **zero** capabilities; all privilege is Rust-side; page data
is validated before use. This is exactly `PRD-NATIVE.md` §3.6 applied to a webview whose content is
the *open web* rather than our own UI — the strictest case, so it is review-gated per release. A
Tauri capability audit must show the browsing webview can reach no `invoke`, no FS, no session.

### 5.2 SSRF (Rust fetching image/page bytes) — **[H], non-optional**
When Rust fetches an image `src` or renders a page on the user's behalf, the URL is attacker-influenced
(it came from a foreign page). The fetch path MUST:
- **Scheme allowlist** `http`/`https` only; reject `file:`/`data:`/etc.
- **Resolve DNS, then block** `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl.
  cloud metadata `169.254.169.254`), `::1`, link-local/ULA, `0.0.0.0` — **re-checked after each
  redirect** (rebinding / redirect-to-internal).
- **Cap** redirects, response size, and time; send no ambient credentials; ignore `Set-Cookie`.
- Prefer running the fetch in a **network-restricted** context that can't reach internal/pod-admin
  endpoints even if a check is bypassed.

This is the same SSRF-safe fetch helper called out in PRD-NATIVE's hardening; build it once, in Rust.

---

## 6. Milestones (gated after PRD-NATIVE N1 — the Tauri desktop shell must exist)

The web shell can't host this, so the native track (`PRD-NATIVE.md` N0–N1) is the prerequisite.

1. **W0 — Second-webview spike [!].** Open an isolated browsing webview from the Tauri shell, navigate
   to a frame-blocking site (one that fails in the web shell), and prove the **trusted side can drive
   it and read nav events** while the browsing webview has **no** `invoke`/FS/session. *Gate: a
   capability audit confirms the wall before any save logic.*
2. **W1 — Browser surface.** Address bar + back/forward/reload + loading/security state, all from Rust
   nav events. Single-view browsing of any site.
3. **W2 — Save link / save image.** Context-menu taps; Rust **SSRF-safe fetch** of image bytes; hand
   captured data to the Clips capture path (`PRD-CLIPS.md`) → **link** and **image** clips. Read them
   back in the Clips app. *Depends on Clips C1 existing.*
4. **W3 — Save page (reader + screenshot).** Rust-side readability extraction (sanitized) and webview
   screenshot; **article**/**screenshot** clips with re-hosted assets.
5. **W4 — Polish.** Default search-engine resolution, security indicator, error/blocked-URL states,
   per-workspace save target follows the active workspace.

---

## 7. Success criteria

- In the native shell, browse a site that **fails to load in the web shell** (frame-blocked), follow
  links, and it behaves like a normal browser.
- Right-click an image on a real page → it lands in the Clips app via Clips' brokered capture path;
  **neither the browser nor the page ever held a pod token**, and **Rust** (not the page) fetched the
  bytes.
- A capability audit shows the browsing webview can reach **no** `invoke`, filesystem, or Solid
  session; CSP/capability config is checked in and review-gated.
- The SSRF suite blocks every private-range / redirect-to-internal / oversized fetch from a page's
  image/link URL.
- Nothing from the Vault namespace, and no plaintext/secret, ever crosses into a saved clip or a new
  Tauri command (mirrors AGENTS.md HARD rules #1/#5).

---

## 8. Open questions / decisions

1. **Webview mechanism.** Tauri child webview vs. a separate `WebviewWindow` for the browsing surface
   — which gives clean event taps (nav, context-menu) *and* the strict capability split? Settle in W0.
2. **Context-menu / DOM target events.** How does Rust learn *which* link/image was right-clicked
   without granting the page IPC — native webview context-menu hooks, or a **minimal, sandboxed**
   content script that posts only the clicked target (no session, carefully scoped)? Spike both in W0.
3. **Clip schema + storage.** Owned by `PRD-CLIPS.md` (incl. the open Drive-integration question,
   `PRD-CLIPS.md` §6) — the browser conforms to whatever Clips lands on. Resolve there, not here.
4. **Reader extraction + sanitizer.** Which readability lib + allowlist-based HTML sanitizer (Rust or
   JS-in-trusted-side), default-deny on tags/attrs/protocols. For W3.
5. **Search engine default.** Which default query→URL resolver, and is it user-configurable.
6. **Tabs.** v0 is single-view; when do multi-tab/session management come back in (post-v0)?
7. **Authenticated browsing.** Out of v0; logging into third-party sites to save from them reopens the
   credential/isolation question — parked.

---

## 9. Provenance

- **`PRD-NATIVE.md`** — authoritative for Tauri, the second-webview model, capability isolation, and
  the native Rust/crypto path; W0 is gated on its N1. The browser is a native-only feature.
- **`PRD-CLIPS.md`** — authoritative for the clip data model, capture path, and store; the browser is
  one capture source feeding it (§4). Browser W2 depends on Clips C1.
- **`PRD-APPS.md`** — the brokered, scoped pod-write pattern Clips' capture sits on; the
  hosted-app/identity model the browser surface sits inside.
- **`PRD.md` §6/§8** — pod data model + threat model (no foreign code in our trust context).
- **Web platform reality** — `X-Frame-Options`/CSP `frame-ancestors` are browser-enforced and not
  overridable by the embedder; this is *why* the browser must be a native process, not a web-shell
  iframe.
- **Tauri 2** — system webview, multi-webview, per-webview capability allowlists; in-house Tauri
  precedent `compass/` (root workspace), and `PRD-NATIVE.md`'s isolation rules.
- **SSRF guidance** — scheme allowlist + post-DNS private-range rejection + per-redirect re-check +
  caps + egress isolation, implemented Rust-side (§5.2).
