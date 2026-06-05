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

export const PROTOCOL_VERSION = 1 as const;

/** Capability tokens the parent advertises in the welcome (coarse for v0). */
export type Capability = "pod:workspace-rw";

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

/** Raw escape-hatch fetch (scope-checked). `init` is a serializable subset. */
export interface FetchMsg {
  t: "mind:fetch";
  v: typeof PROTOCOL_VERSION;
  id: string;
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
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
  | ReadyMsg
  | AppErrorMsg;

// ── Parent → Child ──────────────────────────────────────────────────────────

/** Reply to `mind:hello`: identity handoff + granted capabilities. */
export interface WelcomeMsg {
  t: "mind:welcome";
  v: typeof PROTOCOL_VERSION;
  identity: BridgeIdentity;
  capabilities: Capability[];
}

export interface FetchResultMsg {
  t: "mind:fetch:result";
  v: typeof PROTOCOL_VERSION;
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
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

/** True if `data` is a versioned bridge message with a `mind:`-namespaced tag. */
export function isBridgeMessage(data: unknown): data is { t: string; v: number } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { t?: unknown }).t === "string" &&
    (data as { t: string }).t.startsWith("mind:") &&
    (data as { v?: unknown }).v === PROTOCOL_VERSION
  );
}
