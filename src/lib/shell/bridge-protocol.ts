/**
 * The shell ↔ hosted-app capability bridge protocol (PRD-APPS §5).
 *
 * A small, *versioned* postMessage contract between the shell's `IframeHost`
 * (parent) and a hosted app running in a sandboxed iframe (child). This file is
 * the single source of truth for the message shapes — imported by both the host
 * bridge (`bridge.ts`) and any cooperating app (`/embed-demo`) so the two never
 * drift.
 *
 * Privacy invariant (PRD-APPS §1, AGENTS.md rule #1): NO pod credential ever
 * crosses this boundary. The child receives only *identifiers* (webId, pod root,
 * project) and *brokered results*; every pod request is performed by the parent
 * with the shell's authed fetch and scope-checked first.
 *
 * Pure types + constants — no React, no DOM side effects — so it's safe to import
 * from a server component, a worker, or a plain page.
 */

export const PROTOCOL_VERSION = 2 as const;

/** Capability tokens the parent advertises in the welcome (coarse for v0). */
export type Capability = "pod:workspace-rw";

/** The shell's resolved color mode, handed to embedded apps so their chrome
 *  matches the shell instead of falling back to their own default. A UI hint,
 *  not an identifier or credential. */
export type BridgeTheme = "light" | "dark";

/** The identity handed to a hosted app — identifiers only, never credentials. */
export interface BridgeIdentity {
  webId: string;
  /** Active workspace pod root, trailing-slashed. The app's scope ceiling. */
  workspacePod: string;
  /** Active project, or null for the whole-workspace scope. */
  project: { id: string; name: string } | null;
}

/** A directory entry returned by the `readdir` verb (subset of PodEntry). */
export interface BridgeEntry {
  url: string;
  name: string;
  kind: "container" | "resource";
}

// ── Child → Parent ──────────────────────────────────────────────────────────

/** First message a child posts on load to begin the handshake. */
export interface HelloMsg {
  t: "mind:hello";
  v: typeof PROTOCOL_VERSION;
}

/**
 * Raw escape-hatch fetch (scope-checked). `init` is a serializable subset.
 * `body` is text by default; a binary request body (an upload Blob) is
 * base64-framed with `bodyEncoding: "base64"` so it survives postMessage.
 */
export interface FetchMsg {
  t: "mind:fetch";
  v: typeof PROTOCOL_VERSION;
  id: string;
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyEncoding?: "utf8" | "base64";
    cache?: RequestCache;
  };
}

/** High-level verb: list a container. `path` is relative to the workspace pod. */
export interface ReaddirMsg {
  t: "mind:readdir";
  v: typeof PROTOCOL_VERSION;
  id: string;
  path: string;
}

/** High-level verb: read a resource as text. */
export interface ReadMsg {
  t: "mind:read";
  v: typeof PROTOCOL_VERSION;
  id: string;
  path: string;
}

/** High-level verb: write text to a resource (whole-file PUT). */
export interface WriteMsg {
  t: "mind:write";
  v: typeof PROTOCOL_VERSION;
  id: string;
  path: string;
  body: string;
  contentType?: string;
}

/**
 * Self-sizing (v2): a widget child asks the host to fit its tile to content.
 * The host CLAMPS the value to the tile's grid bounds before applying it — a
 * hostile child can't grow its tile unbounded. A v1 child never sends this and
 * simply keeps its declared size (graceful degradation).
 */
export interface ResizeMsg {
  t: "mind:resize";
  v: typeof PROTOCOL_VERSION;
  /** Desired content height in CSS pixels (host-clamped). */
  height: number;
}

/**
 * Navigation hint (child → parent, fire-and-forget): a widget asks the host to
 * open its OWNING app — e.g. a Home tile item was clicked. `path` is an optional,
 * UNTRUSTED hint at which resource to open; the host may ignore it. No reply, no
 * pod access, no credential crosses — the host alone decides whether/where to
 * navigate, and it only ever opens the widget's own owning app (the child cannot
 * name a different one). A v1 child never sends this (graceful degradation).
 */
export interface OpenMsg {
  t: "mind:open";
  v: typeof PROTOCOL_VERSION;
  /** Optional resource hint (e.g. a pod URL or entry name). */
  path?: string;
}

/** Lifecycle: the app has rendered and is interactive. */
export interface ReadyMsg {
  t: "mind:ready";
  v: typeof PROTOCOL_VERSION;
}

/** Lifecycle: the app hit a fatal error it wants the host to surface. */
export interface AppErrorMsg {
  t: "mind:error";
  v: typeof PROTOCOL_VERSION;
  message: string;
}

export type ChildMessage =
  | HelloMsg
  | FetchMsg
  | ReaddirMsg
  | ReadMsg
  | WriteMsg
  | ResizeMsg
  | OpenMsg
  | ReadyMsg
  | AppErrorMsg;

// ── Parent → Child ──────────────────────────────────────────────────────────

/** Reply to `mind:hello`: identity handoff + granted capabilities. */
export interface WelcomeMsg {
  t: "mind:welcome";
  v: typeof PROTOCOL_VERSION;
  identity: BridgeIdentity;
  capabilities: Capability[];
  /** The shell's current color mode. Absent ⇒ the app keeps its own default. */
  theme?: BridgeTheme;
}

export interface FetchResultMsg {
  t: "mind:fetch:result";
  v: typeof PROTOCOL_VERSION;
  id: string;
  status: number;
  /** The response's final URL — restored on the child's Response so RDF parsers
   *  can resolve relative IRIs (a constructed Response otherwise has url ""). */
  url: string;
  headers: Record<string, string>;
  /** Text response, or base64 bytes when `encoding: "base64"` (binary files). */
  body: string;
  encoding?: "utf8" | "base64";
}

export interface ReaddirResultMsg {
  t: "mind:readdir:result";
  v: typeof PROTOCOL_VERSION;
  id: string;
  entries: BridgeEntry[];
}

export interface ReadResultMsg {
  t: "mind:read:result";
  v: typeof PROTOCOL_VERSION;
  id: string;
  body: string;
}

export interface WriteResultMsg {
  t: "mind:write:result";
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
}

/** A request denied by the scope check (out of the granted pod scope). */
export interface DeniedMsg {
  t: "mind:denied";
  v: typeof PROTOCOL_VERSION;
  id: string;
  reason: string;
}

/** A request that was allowed but failed at the pod (network/404/etc.). */
export interface FailMsg {
  t: "mind:fail";
  v: typeof PROTOCOL_VERSION;
  id: string;
  message: string;
}

export type ParentMessage =
  | WelcomeMsg
  | FetchResultMsg
  | ReaddirResultMsg
  | ReadResultMsg
  | WriteResultMsg
  | DeniedMsg
  | FailMsg;

// ── Guards ────────────────────────────────────────────────────────────────

/**
 * True if `data` is a versioned bridge message with a `mind:`-namespaced tag.
 *
 * The version check accepts ANY protocol the host still understands
 * (`1 ≤ v ≤ PROTOCOL_VERSION`), not just an exact match — so a child speaking an
 * older protocol degrades gracefully (e.g. a v1 child against this v2 host keeps
 * its declared size by never sending `mind:resize`) instead of having every one
 * of its messages silently dropped. The host only ever emits the current verbs;
 * a child that doesn't recognize a newer one ignores it.
 */
export function isBridgeMessage(data: unknown): data is { t: string; v: number } {
  if (typeof data !== "object" || data === null) return false;
  const t = (data as { t?: unknown }).t;
  const v = (data as { v?: unknown }).v;
  return (
    typeof t === "string" &&
    t.startsWith("mind:") &&
    typeof v === "number" &&
    v >= 1 &&
    v <= PROTOCOL_VERSION
  );
}
