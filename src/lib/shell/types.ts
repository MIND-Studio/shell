/**
 * The shell ↔ app contract (PRD §3). Hosted apps (starting with Vault) consume
 * this via `useShell()` to learn the current identity, workspace pod root,
 * active project, and an authenticated fetch — then read/write their OWN
 * `/apps/{name}/` zone. Apps must NOT reach outside their zone.
 *
 * This file is pure types + pure helpers (no React, no client code) so both the
 * ShellProvider (src/lib/shell/context.tsx) and every hosted app can import it
 * without coupling.
 */

export type WorkspaceRole = "owner" | "member" | "guest";

export interface Workspace {
  /** Pod root URL, always trailing-slashed, e.g. https://pod.example/alice/ */
  podRoot: string;
  /** Display name (from workspace.ttl or the pod label). */
  name: string;
  /** The owner WebID, if known. */
  ownerWebId?: string;
  /** This account's role in the workspace. */
  role?: WorkspaceRole;
}

/**
 * The *stored* form of a Workspace, as it lives in the per-identity Workspace
 * index (PRD-IDENTITY.md §4.3-§4.4). `Workspace` above is the *resolved* form
 * the shell hands to the UI; `context.tsx` resolves refs → workspaces (reading
 * each pod's live `workspace.ttl` name). Keep this minimal + server-agnostic so
 * the Phase C DID layer can relocate the index without reshaping it.
 */
export interface WorkspaceRef {
  /** Pod root URL, always trailing-slashed. */
  podRoot: string;
  /** This account's role in the workspace. */
  role: WorkspaceRole;
  /** Optional cached label; the live name is still read from workspace.ttl. */
  name?: string;
}

export interface Project {
  /** Stable id = the `/projects/{id}/` segment. */
  id: string;
  /** Container URL `{podRoot}projects/{id}/`. */
  url: string;
  name: string;
}

/**
 * How the shell hosts an app in the app body (PRD-APPS §4):
 *   - "inprocess" → a built-in React component from the registry (Vault, Identity).
 *   - "iframe"    → hosted in a sandboxed iframe under the capability bridge.
 *   - "link"      → opened in its own tab by the waffle (today's default).
 * Absent ⇒ "link", so apps that never opted in keep today's behavior (no regression).
 */
export type AppEmbed = "iframe" | "inprocess" | "link";

/** Trust tier driving iframe sandbox + (later) consent posture (PRD-APPS §5.5). */
export type AppTrust = "first-party" | "community" | "untrusted";

/** Home-widget grid footprint (PRD-DASHBOARD §5): s=1×1, m=2×1, l=2×2. */
export type WidgetSize = "s" | "m" | "l";

/**
 * A widget an app offers to the Home surface (PRD-DASHBOARD §5/§8). It is served
 * from the app's OWN origin and hosted in a sandboxed tile under the capability
 * bridge — never shell-local code. Its pod scope ceiling is the owning app's
 * {@link appZone} narrowed by `scope`; the bridge denies anything outside it.
 */
export interface WidgetDecl {
  /** Stable id, unique within the owning app (the `#frag` of a Home ref). */
  id: string;
  label: string;
  /** Single emoji for the tile header. */
  icon: string;
  /** Default grid footprint. */
  size: WidgetSize;
  /** Largest footprint the host grants on self-resize (defaults to `size`). */
  maxSize?: WidgetSize;
  /**
   * Sub-path UNDER the owning app's `appZone()` the widget may read — the scope
   * ceiling. "" = the app zone root. The bridge enforces it via `isWithinPod`.
   */
  scope: string;
  /**
   * Absolute container path under the workspace pod ROOT that REPLACES the default
   * `appZone()` ceiling (still narrowed by `scope`, still confined to the pod and
   * scope-checked). For widgets surfacing an app whose on-pod data doesn't live in
   * the canonical `apps/{key}/` zone — e.g. Drive stores files at `mind-drive/files/`,
   * not `apps/drive/`. Absent ⇒ the canonical app zone. No leading slash.
   */
  podPath?: string;
  /** The widget's own page, loaded in the tile iframe (absolute or shell-relative). */
  url: string;
  /** Tile sandbox tier; absent ⇒ "community" (opaque-origin isolation). */
  trust?: AppTrust;
  /**
   * Opt-in WRITE capability (PRD "read-first" posture). Absent/false ⇒ the widget
   * is read-only and the host denies its `mind:write` with `mind:denied`. true ⇒
   * the host brokers scope-checked writes inside the widget's `appZone()` ceiling.
   */
  write?: boolean;
}

/**
 * One placed tile in a workspace's Home layout, persisted in `apps/shell/home.ttl`
 * (PRD-DASHBOARD §8b). `ref` is `"appKey#widgetId"`, resolved against the live
 * app list + each app's `widgets`.
 */
export interface HomeLayoutItem {
  ref: string;
  order: number;
  size: WidgetSize;
}

export interface HostedApp {
  /** Stable slug, also the `/apps/{key}/` zone segment. */
  key: string;
  label: string;
  /** Single emoji for the tile / rail. */
  icon: string;
  /** Hosted URL (sibling subdomain) for external/iframe apps; undefined for in-process. */
  url?: string;
  /** True when the app is enabled in the current workspace. */
  enabled: boolean;
  /** Hosting mode; absent ⇒ "link" (PRD-APPS §4). */
  embed?: AppEmbed;
  /** Trust tier; absent ⇒ "community" (PRD-APPS §5.5). */
  trust?: AppTrust;
  /** Home widgets this app offers (PRD-DASHBOARD §5); absent ⇒ none. */
  widgets?: WidgetDecl[];
}

export interface AccountIdentity {
  webId: string;
  displayName?: string;
  avatarUrl?: string;
  issuer?: string;
}

export interface ShellContextValue {
  /** Current signed-in WebID, or null while loading / signed out. */
  webId: string | null;
  /** All accounts (WebIDs) the user has signed into this device. */
  accounts: AccountIdentity[];
  /** The current account's identity. */
  account: AccountIdentity | null;

  /** Current workspace pod root (trailing slash), or null while loading. */
  workspacePod: string | null;
  /** Workspaces the current account owns or was granted into. */
  workspaces: Workspace[];

  /** Current project (null = whole-workspace / "no project"). */
  project: Project | null;
  /** Projects in the current workspace. */
  projects: Project[];

  /** Apps enabled in the current workspace (rail / waffle source). */
  apps: HostedApp[];
  /** Key of the app currently shown in the app body. */
  activeAppKey: string;

  /** Authenticated fetch for the current WebID session. */
  fetch: typeof fetch;

  /** True once identity + workspace context have loaded. */
  ready: boolean;

  // --- actions ---
  setActiveApp(key: string): void;
  switchWorkspace(podRoot: string): void;
  /**
   * Register a Workspace in the identity's index and switch to it. v0 = "join an
   * existing pod by URL" (PRD-IDENTITY.md §4.5 / B3). `role` defaults to "member".
   */
  addWorkspace(podRoot: string, opts?: { role?: WorkspaceRole; name?: string }): Promise<void>;
  /**
   * Provision a brand-new pod (Workspace) reusing the signed-in WebID, then
   * register + switch to it (PRD-IDENTITY.md §4.6 / B4, hybrid per PRD-DID §5.7).
   * The user types ONLY a name — the shell auto-generates the CSS account login,
   * seals it in the wallet, and binds the master DID when the server supports it.
   * `server` defaults to the current issuer; pass another to target a different
   * (e.g. DID-aware) CSS. Pass `email` to use a REAL, deliverable address (instead
   * of the non-deliverable placeholder) when the provider verifies email — it's
   * sealed as `emailVerified:false` (pending) until the user confirms in-provider
   * (PRD-PROVIDER-ACCOUNTS §6).
   */
  createWorkspace(opts: { name: string; server?: string; email?: string }): Promise<void>;
  setProject(project: Project | null): void;
  /** Re-read workspace/project/app context from the pod. */
  refresh(): Promise<void>;
  /**
   * Re-resolve the whole identity (WebID → home pod → rail), discarding any
   * active workspace override. Call after switching the active *passport* (C4):
   * the platform now reports the passport's WebID, so this reloads the shell as
   * that passport. No OIDC redirect is triggered (single-flight preserved).
   */
  reloadIdentity(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Resolve an app's data zone for the current scope (PRD §6).
 *   no project  → {podRoot}apps/{appKey}/
 *   in a project → {podRoot}projects/{projectId}/apps/{appKey}/
 * The workspace-wide view is the union of these, computed under the requester's
 * own credentials (no-access projects simply don't resolve).
 */
export function appZone(
  podRoot: string,
  appKey: string,
  project?: Project | null
): string {
  const base = podRoot.endsWith("/") ? podRoot : podRoot + "/";
  if (project) return `${base}projects/${project.id}/apps/${appKey}/`;
  return `${base}apps/${appKey}/`;
}

/** The shell's own state zone, `{podRoot}apps/shell/`. */
export function shellZone(podRoot: string): string {
  const base = podRoot.endsWith("/") ? podRoot : podRoot + "/";
  return `${base}apps/shell/`;
}
