import { readdir, readFileText, writeFileText } from "@/lib/solid/pod-fs";
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
  /** The shell's authed fetch (platform pod.fetch via useShell().fetch). */
  fetch: typeof fetch;
  /** Fired on `mind:ready`. */
  onReady?: () => void;
  /** Fired on `mind:error`. */
  onAppError?: (message: string) => void;
}

export interface Bridge {
  dispose(): void;
}

function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
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

export function createBridge(opts: BridgeOptions): Bridge {
  const { target, app, identity, fetch: fetchFn, onReady, onAppError } = opts;
  const expectedOrigin = appOriginOf(app);
  // Opaque-origin (sandbox="allow-scripts") frames report origin "null" and can
  // only receive a "*" post; first-party (allow-same-origin) frames keep their
  // real origin, so we pin the post to it.
  const sendOrigin = app.trust === "first-party" && expectedOrigin ? expectedOrigin : "*";

  function post(msg: ParentMessage) {
    target.postMessage(msg, sendOrigin);
  }

  // The identity handed to the app. webId can change under a mounted frame when a
  // background-resume / passport switch swaps the active session without the host
  // re-mounting the bridge; we keep a mutable copy and re-broadcast on change so
  // the app never holds a stale webId. (Pod-root/project changes DO re-mount the
  // host with a fresh bridge, so only webId is reconciled here.) Still no
  // credential ever crosses — identifiers only (AGENTS.md rule #1).
  let currentIdentity: BridgeIdentity = identity;

  function welcome() {
    post({
      t: "mind:welcome",
      v: PROTOCOL_VERSION,
      identity: currentIdentity,
      capabilities: ["pod:workspace-rw"],
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

  async function handleFetch(id: string, url: string, init?: RequestInit) {
    const started = performance.now();
    if (!isWithinPod(url, identity.workspacePod)) {
      logLine("fetch", url, "denied", started);
      post({ t: "mind:denied", v: PROTOCOL_VERSION, id, reason: "out of workspace scope" });
      return;
    }
    try {
      const res = await fetchFn(url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await res.text();
      logLine("fetch", url, res.status, started);
      post({ t: "mind:fetch:result", v: PROTOCOL_VERSION, id, status: res.status, headers, body });
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
    dispose() {
      window.removeEventListener("message", onMessage);
      unsubscribe();
    },
  };
}
