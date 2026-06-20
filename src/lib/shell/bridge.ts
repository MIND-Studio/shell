import {
  readdir,
  readFileText,
  writeFileText,
  ensureContainerChain,
} from "@/lib/solid/pod-fs";
import {
  subscribePassportSession,
  getActivePassportSession,
} from "@/lib/solid/passport-session";
import {
  PROTOCOL_VERSION,
  isBridgeMessage,
  type ChildMessage,
  type ParentMessage,
  type BridgeIdentity,
  type BridgeTheme,
  type FetchMsg,
} from "./bridge-protocol";
import type { HostedApp } from "./types";

/**
 * The shell-side capability bridge + access broker (PRD-APPS §5). One instance
 * per hosted iframe, created by `IframeHost`. It:
 *
 *   1. validates the *source* (the iframe's own window) and *origin* on EVERY
 *      message — never trusts a `mind:`-shaped message from anywhere else;
 *   2. answers the handshake with identifiers only (handing off webId / pod root
 *      / project — NEVER the pod credential, AGENTS.md rule #1);
 *   3. brokers pod I/O — raw `mind:fetch` plus high-level `readdir`/`read`/`write`
 *      verbs — each SCOPE-CHECKED to the active workspace pod root before it runs
 *      with the shell's authed fetch (PRD-APPS §5.2, hard-coded scope = P1).
 *
 * The access policy for P1 is the whole of {@link isWithinPod}: a request is
 * allowed iff its URL resolves inside the workspace pod root. Everything else is
 * denied. Consent sheets + finer grants are P3.
 */

export interface BridgeOptions {
  /** The iframe's `contentWindow` — the only `event.source` we trust. */
  target: Window;
  /** The manifest entry being hosted (for `url` + `trust`). */
  app: HostedApp;
  /** Identifiers handed to the app on handshake — no credentials. */
  identity: BridgeIdentity;
  /** The shell's current color mode, so the embedded app's chrome matches. */
  theme: BridgeTheme;
  /** The shell's authed fetch (platform pod.fetch via useShell().fetch). */
  fetch: typeof fetch;
  /**
   * The TRUE workspace pod root — the floor for container-chain creation on write.
   * `identity.workspacePod` may be NARROWED to a widget's app zone (the scope
   * ceiling), so it can't be used to create the chain down to a fresh zone. This
   * is an ancestor of that ceiling, so every container `ensureContainerChain`
   * makes still lands inside the granted scope. Absent ⇒ `identity.workspacePod`.
   */
  podRoot?: string;
  /**
   * Whether the host honors `mind:write` from this frame. Plain hosted apps get
   * the full `pod:workspace-rw` contract (default `true`); Home widgets are
   * read-first and pass `false` unless they declared `write:true` (PRD posture).
   */
  allowWrite?: boolean;
  /** Fired on `mind:ready`. */
  onReady?: () => void;
  /** Fired on `mind:error`. */
  onAppError?: (message: string) => void;
  /**
   * Fired on `mind:resize` (v2 self-sizing) with a pre-sanitized, host-bounded
   * pixel height. The host (`WidgetTile`) still clamps to the tile's grid bounds;
   * this is the coarse safety clamp so a hostile child can't pass NaN/∞/huge.
   */
  onResize?: (height: number) => void;
  /**
   * Fired on `mind:open` (a widget item was clicked) with the child's optional,
   * UNTRUSTED resource hint. The host decides what to do — `WidgetTile` switches
   * the shell to the widget's OWN owning app (the child can't name another). No
   * pod access happens here; it's a pure navigation request.
   */
  onOpen?: (path?: string) => void;
}

export interface Bridge {
  /** Push a new color mode to the app (re-broadcasts welcome). Idempotent. */
  setTheme(theme: BridgeTheme): void;
  /** Push a project switch to the app (re-broadcasts welcome). Idempotent.
   *  Mirrors {@link setTheme}: the frame stays mounted and the negotiated
   *  protocol version is preserved, so the welcome actually reaches the app —
   *  unlike tearing down and recreating the bridge, whose proactive welcome
   *  goes out at the un-negotiated host version and a v1 app drops it. */
  setProject(project: BridgeIdentity["project"]): void;
  dispose(): void;
}

function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

// ── base64 framing for binary bodies (chunked, call-stack-safe) ──────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Whether a response body of this content-type is safe to ship as a UTF-8
 * string. RDF/JSON/text go as text (cheap, debuggable); everything else —
 * images, PDFs, octet-streams, and unknown/empty types — is base64-framed so
 * binary bytes survive the postMessage hop intact.
 */
function isTextualContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return (
    c.startsWith("text/") ||
    c.includes("json") ||
    c.includes("xml") ||
    c.includes("javascript") ||
    c.includes("turtle") ||
    c.includes("trig") ||
    c.includes("n-triples") ||
    c.includes("n-quads") ||
    c.includes("sparql")
  );
}

/** Rebuild a real `RequestInit` from the serialized, possibly-base64 bridge init. */
function toRealInit(init?: FetchMsg["init"]): RequestInit | undefined {
  if (!init) return undefined;
  const out: RequestInit = {};
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers;
  if (init.cache) out.cache = init.cache;
  if (init.body != null) {
    out.body =
      init.bodyEncoding === "base64"
        ? (base64ToBytes(init.body) as unknown as BodyInit)
        : init.body;
  }
  return out;
}

function appOriginOf(app: HostedApp): string | null {
  if (!app.url) return null;
  try {
    return new URL(app.url).origin;
  } catch {
    return null;
  }
}

/**
 * The P1 access policy: true iff `url` resolves *inside* the workspace pod root.
 * Cross-origin and parent-escape (`..`) requests fail — `new URL` normalizes the
 * path, so an escape lands outside `base` and the prefix check rejects it.
 */
export function isWithinPod(url: string, workspacePod: string): boolean {
  const base = ensureSlash(workspacePod);
  if (url.includes("..")) return false;
  let resolved: string;
  try {
    resolved = new URL(url).href;
  } catch {
    return false;
  }
  return resolved.startsWith(base);
}

/** Resolve a child-supplied `path` (relative or absolute) under the pod root. */
function resolveUnderPod(path: string, workspacePod: string): string | null {
  const base = ensureSlash(workspacePod);
  let resolved: string;
  try {
    resolved = /^https?:\/\//i.test(path) ? new URL(path).href : new URL(path, base).href;
  } catch {
    return null;
  }
  return isWithinPod(resolved, base) ? resolved : null;
}

/** Coarse ceiling for a child-requested height — the tile clamps finer (px). */
const MAX_RESIZE_PX = 4000;

export function createBridge(opts: BridgeOptions): Bridge {
  const { target, app, identity, fetch: fetchFn, onReady, onAppError, onResize, onOpen } = opts;
  // Read-first default for the WRITE gate is per-frame; container-creation floor
  // falls back to the (possibly narrowed) scope ceiling when no true root is given.
  const allowWrite = opts.allowWrite ?? true;
  const podRoot = opts.podRoot ?? identity.workspacePod;
  const expectedOrigin = appOriginOf(app);
  // Opaque-origin (sandbox="allow-scripts") frames report origin "null" and can
  // only receive a "*" post; first-party (allow-same-origin) frames keep their
  // real origin, so we pin the post to it.
  const sendOrigin = app.trust === "first-party" && expectedOrigin ? expectedOrigin : "*";

  // Negotiated protocol version: the version the CHILD speaks, learned from its
  // first message. The shell understands every protocol from 1..PROTOCOL_VERSION
  // (see `isBridgeMessage`), but a child pins its receiver to its OWN version and
  // drops any reply tagged otherwise (the sibling brokers gate on `v === 1`). So
  // every reply must echo the child's version, not the host's newest — else a v1
  // app (Drive/Notes/Photos/…) never gets its welcome, times out, and falls back
  // to its own sign-in on the wrong pod. Defaults to the host's newest until the
  // first inbound message; the child re-sends `mind:hello` until welcomed, so a
  // too-new proactive welcome before handshake is harmless.
  let clientVersion: number = PROTOCOL_VERSION;

  function post(msg: ParentMessage) {
    // Stamp the reply with the child's negotiated version (see `clientVersion`).
    target.postMessage({ ...msg, v: clientVersion }, sendOrigin);
  }

  // The identity handed to the app. webId can change under a mounted frame when a
  // background-resume / passport switch swaps the active session without the host
  // re-mounting the bridge; we keep a mutable copy and re-broadcast on change so
  // the app never holds a stale webId. (Pod-root/project changes DO re-mount the
  // host with a fresh bridge, so only webId is reconciled here.) Still no
  // credential ever crosses — identifiers only (AGENTS.md rule #1).
  let currentIdentity: BridgeIdentity = identity;
  // The shell's color mode. Like webId, it can change under a mounted frame (the
  // user toggles the theme without re-mounting the host), so we keep a mutable
  // copy and re-broadcast on change so the embedded app's chrome stays in sync.
  let currentTheme: BridgeTheme = opts.theme;

  function welcome() {
    post({
      t: "mind:welcome",
      v: PROTOCOL_VERSION,
      identity: currentIdentity,
      capabilities: ["pod:workspace-rw"],
      theme: currentTheme,
    });
  }

  const unsubscribe = subscribePassportSession(() => {
    const nextWebId = getActivePassportSession()?.webId ?? identity.webId;
    if (nextWebId === currentIdentity.webId) return;
    currentIdentity = { ...currentIdentity, webId: nextWebId };
    welcome();
  });

  function logLine(t: string, ref: string, status: number | string, started: number) {
    // Never log bodies/secrets — only event type, resource, status, latency.
    console.debug(
      `[bridge] ${t} ${ref} → ${status} (${Math.round(performance.now() - started)}ms) webId=${identity.webId}`
    );
  }

  async function handleFetch(id: string, url: string, init?: FetchMsg["init"]) {
    const started = performance.now();
    if (!isWithinPod(url, identity.workspacePod)) {
      logLine("fetch", url, "denied", started);
      post({ t: "mind:denied", v: PROTOCOL_VERSION, id, reason: "out of workspace scope" });
      return;
    }
    try {
      const res = await fetchFn(url, toRealInit(init));
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Text bodies (RDF/JSON) ship as-is; binary (images, PDFs, uploads round-
      // tripped on download) is base64-framed so the bytes survive postMessage.
      const buf = await res.arrayBuffer();
      const textual = isTextualContentType(res.headers.get("content-type") ?? "");
      const body = textual
        ? new TextDecoder().decode(buf)
        : bytesToBase64(new Uint8Array(buf));
      const encoding = textual ? "utf8" : "base64";
      logLine("fetch", url, res.status, started);
      post({
        t: "mind:fetch:result",
        v: PROTOCOL_VERSION,
        id,
        status: res.status,
        url: res.url || url,
        headers,
        body,
        encoding,
      });
    } catch (e) {
      logLine("fetch", url, "fail", started);
      post({ t: "mind:fail", v: PROTOCOL_VERSION, id, message: (e as Error).message });
    }
  }

  async function handleVerb(msg: Extract<ChildMessage, { id: string }>) {
    const started = performance.now();
    if (msg.t === "mind:fetch") {
      await handleFetch(msg.id, msg.url, msg.init);
      return;
    }
    const resolved = resolveUnderPod(msg.path, identity.workspacePod);
    if (!resolved) {
      logLine(msg.t, msg.path, "denied", started);
      post({ t: "mind:denied", v: PROTOCOL_VERSION, id: msg.id, reason: "out of workspace scope" });
      return;
    }
    try {
      if (msg.t === "mind:readdir") {
        const entries = (await readdir(resolved)).map((e) => ({
          url: e.url,
          name: e.name,
          kind: e.kind,
        }));
        logLine(msg.t, resolved, "ok", started);
        post({ t: "mind:readdir:result", v: PROTOCOL_VERSION, id: msg.id, entries });
      } else if (msg.t === "mind:read") {
        const body = await readFileText(resolved);
        logLine(msg.t, resolved, "ok", started);
        post({ t: "mind:read:result", v: PROTOCOL_VERSION, id: msg.id, body });
      } else if (msg.t === "mind:write") {
        // Read-first gate: a frame that wasn't granted write can't slip one past
        // the scope check. Denied like an out-of-scope request (no pod call runs).
        if (!allowWrite) {
          logLine(msg.t, resolved, "denied", started);
          post({
            t: "mind:denied",
            v: PROTOCOL_VERSION,
            id: msg.id,
            reason: "write not permitted for this widget",
          });
          return;
        }
        // The PUT replaces a whole resource but won't create its parents; build
        // the container chain from the true pod root down (all inside scope).
        const parent = resolved.slice(0, resolved.lastIndexOf("/") + 1);
        await ensureContainerChain(parent, podRoot);
        await writeFileText(resolved, msg.body, msg.contentType);
        logLine(msg.t, resolved, "ok", started);
        post({ t: "mind:write:result", v: PROTOCOL_VERSION, id: msg.id, ok: true });
      }
    } catch (e) {
      logLine(msg.t, resolved, "fail", started);
      post({ t: "mind:fail", v: PROTOCOL_VERSION, id: msg.id, message: (e as Error).message });
    }
  }

  function onMessage(event: MessageEvent) {
    // 1) Source binding — the ONLY identity check that survives an opaque origin.
    if (event.source !== target) return;
    // 2) Origin: opaque frames send "null"; same-origin frames must match exactly.
    if (event.origin !== "null" && expectedOrigin && event.origin !== expectedOrigin) return;
    // 3) Shape + version.
    if (!isBridgeMessage(event.data)) return;
    const msg = event.data as ChildMessage;

    // Negotiate down to the child's protocol version so our replies are tagged
    // with a version it accepts (it drops anything else). `isBridgeMessage` has
    // already bounded it to [1, PROTOCOL_VERSION].
    clientVersion = event.data.v;

    switch (msg.t) {
      case "mind:hello":
        welcome();
        break;
      case "mind:fetch":
      case "mind:readdir":
      case "mind:read":
      case "mind:write":
        void handleVerb(msg);
        break;
      case "mind:resize":
        // Host-side safety clamp (finite, non-negative, capped). The tile applies
        // the finer grid-bounds clamp; here we just refuse garbage.
        if (Number.isFinite(msg.height)) {
          onResize?.(Math.max(0, Math.min(msg.height, MAX_RESIZE_PX)));
        }
        break;
      case "mind:open":
        // Pure navigation hint — no pod access, no scope check needed. The host
        // (WidgetTile) ignores the path and just opens this widget's owning app.
        onOpen?.(msg.path);
        break;
      case "mind:ready":
        onReady?.();
        break;
      case "mind:error":
        onAppError?.(msg.message);
        break;
    }
  }

  window.addEventListener("message", onMessage);
  return {
    setTheme(theme: BridgeTheme) {
      if (theme === currentTheme) return;
      currentTheme = theme;
      welcome();
    },
    setProject(project: BridgeIdentity["project"]) {
      if ((currentIdentity.project?.id ?? null) === (project?.id ?? null)) return;
      currentIdentity = { ...currentIdentity, project };
      welcome();
    },
    dispose() {
      window.removeEventListener("message", onMessage);
      unsubscribe();
    },
  };
}
