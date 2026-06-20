"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { getPlatform } from "@/lib/platform";
import { readProfile, readPodRoot } from "@/lib/solid/profile";
import { readdir, readFileText } from "@/lib/solid/pod-fs";
import {
  listWorkspaceRefs,
  addWorkspaceRef,
  ensureHomeRef,
  ensureSlash,
} from "@/lib/solid/workspaces";
import { exists } from "@/lib/solid/pod-fs";
import { provisionWorkspaceAccount } from "@/lib/solid/account";
import {
  getView as getWalletView,
  getDid as getWalletDid,
  sign as walletSign,
  addPassport,
  newPassportId,
} from "@/lib/identity/wallet";
import {
  listAccounts,
  rememberAccount,
} from "./accounts";
import { readCatalog } from "./catalog";
import { trySilentResume } from "@/lib/solid/resume";
import type {
  ShellContextValue,
  Workspace,
  WorkspaceRef,
  WorkspaceRole,
  Project,
  HostedApp,
  WidgetDecl,
  AccountIdentity,
} from "./types";

/**
 * The ShellProvider establishes the identity + workspace + project + app context
 * for the whole shell, exposed via `useShell()`. Hosted apps (Vault) read this to
 * learn the current pod root / project / authed fetch and operate on their own
 * `/apps/{name}/` zone (PRD §3, §6).
 *
 * v0 discovery is deliberately simple but real:
 *   - workspaces: resolved from the per-identity Workspace index at
 *     `{homePod}apps/shell/workspaces.ttl` (PRD-IDENTITY.md §4 — "Mechanism A").
 *     With no index we bootstrap a single home-pod entry, so behaviour is
 *     identical to before; the rail goes plural the moment a second ref exists.
 *   - projects: `{podRoot}projects/*` (each with a project.ttl name), tolerant
 *     of a missing container.
 *   - apps: Vault (in-process) plus the shared sibling catalog as external tiles.
 */

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <ShellProvider>");
  return ctx;
}

const DCT_TITLE = "http://purl.org/dc/terms/title";

/** Where the hosted Drive app is served (its own origin, loaded in the frame). */
const DRIVE_ORIGIN = process.env.NEXT_PUBLIC_APP_DRIVE_URL ?? "http://localhost:3060";
/**
 * Embed Drive at its `/drive` route, not its marketing root `/`. Opening an app
 * in the shell should land on the app itself: a returning user (Drive session
 * cached) sees their files immediately; a signed-out user hits Drive's embedded
 * auto-connect (it redirects `/drive` → `/connect` → silent SSO → back to
 * `/drive`). Embedding the bare origin instead showed Drive's "Your files, in
 * your pod" landing page — a dead end inside the shell.
 */
const DRIVE_URL = `${DRIVE_ORIGIN.replace(/\/$/, "")}/drive`;

/**
 * The pod-suite siblings (notes/contacts/calendar/photos) are hosted exactly
 * like Drive: from their own origin, embedded at their app route rather than
 * the marketing root, self-authenticating inside the frame.
 */
function siblingUrl(envOrigin: string | undefined, devPort: number, route: string): string {
  const origin = envOrigin ?? `http://localhost:${devPort}`;
  return `${origin.replace(/\/$/, "")}${route}`;
}
const NOTES_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_NOTES_URL, 3120, "/notes");
const CONTACTS_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_CONTACTS_URL, 3130, "/contacts");
const CALENDAR_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_CALENDAR_URL, 3140, "/calendar");
const PHOTOS_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_PHOTOS_URL, 3150, "/photos");
// Projects serves its app surface at the origin root (no sub-route).
const PROJECTS_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_PROJECTS_URL, 3160, "");
// Slides (mind-slides-v0) is embedded at its `/studio` route. It brokers like the
// rest of the suite (its `src/lib/solid/broker.ts` does the v1 handshake), so
// embedded it uses the shell's SSO + pod — decks save to `{shellPod}mind-slides/
// decks/`, which the Decks widget reads back.
const SLIDES_URL = siblingUrl(process.env.NEXT_PUBLIC_APP_SLIDES_URL, 3105, "/studio");

/**
 * The built-in apps the shell always offers (PRD §3) — present in every
 * workspace and account, no per-pod install/seed needed.
 *
 * Vault + Identity run in-process (no `url`). Drive is built-in too, but it's
 * still HOSTED IN THE FRAME from its own origin (`embed:"iframe"`,
 * `trust:"first-party"`) — i.e. the real external Drive app, just always listed
 * without having to register `<#drive>` in the pod catalog. A pod that DOES seed
 * its own `<#drive>` is fine: the catalog merge below drops any entry whose key
 * is already a built-in, so Drive never doubles up.
 */
/**
 * The reference Home widget (PRD-DASHBOARD §7), served by the shell itself at
 * `/widget/recent`. It's a DELETABLE demo: the first real consumer of the
 * capability bridge, attached to a built-in app so default Home has one tile
 * before any sibling app ships its own widget URL. Real widgets are served from
 * each app's OWN origin and declared in the pod catalog (`mind:Widget`), not here.
 *
 * `trust:"first-party"` because the shell serves it (same origin) — it still only
 * receives identifiers + brokered, scope-checked reads, never a credential.
 */
const RECENT_WIDGET: WidgetDecl = {
  id: "recent",
  label: "Recent",
  icon: "🕘",
  size: "m",
  maxSize: "l",
  scope: "",
  // Drive stores files at `{pod}mind-drive/files/`, NOT the canonical `apps/drive/`
  // zone — so the ceiling is overridden to Drive's real namespace, else the widget
  // reads an empty container and shows nothing even after files are added in Drive.
  podPath: "mind-drive/files/",
  url: "/widget/recent",
  trust: "first-party",
};

// An INTERACTIVE reference widget: composes + lists notes in the owning app's
// zone. `write:true` opts it into brokered, scope-checked writes (the host denies
// writes from any widget that didn't). Deletable demo, like RECENT_WIDGET.
const QUICK_NOTE_WIDGET: WidgetDecl = {
  id: "quick-note",
  label: "Quick Note",
  icon: "📝",
  size: "m",
  maxSize: "l",
  scope: "",
  url: "/widget/quick-note",
  trust: "first-party",
  write: true,
};

// Read-only reference widgets for the rest of the pod suite. Each is ceilinged to
// its owning app's CANONICAL zone (`apps/{key}/`) — verified against each sibling's
// config — so no `podPath` override is needed (unlike Drive). All deletable demos.
const UP_NEXT_WIDGET: WidgetDecl = {
  id: "up-next",
  label: "Up Next",
  icon: "📅",
  size: "s",
  maxSize: "m",
  scope: "",
  url: "/widget/up-next",
  trust: "first-party",
};
const PEOPLE_WIDGET: WidgetDecl = {
  id: "people",
  label: "People",
  icon: "👥",
  size: "s",
  maxSize: "m",
  scope: "",
  url: "/widget/people",
  trust: "first-party",
};
const GALLERY_WIDGET: WidgetDecl = {
  id: "gallery",
  label: "Gallery",
  icon: "🖼️",
  size: "m",
  maxSize: "l",
  scope: "",
  url: "/widget/gallery",
  trust: "first-party",
};
// Slides stores decks at `{pod}mind-slides/decks/{id}/` (NOT the canonical
// `apps/slides/` zone), so the ceiling is overridden to its real namespace — same
// pattern as Drive. Each deck is a container with a `meta.json` (title inside).
const DECKS_WIDGET: WidgetDecl = {
  id: "decks",
  label: "Decks",
  icon: "🖥️",
  size: "s",
  maxSize: "m",
  scope: "",
  podPath: "mind-slides/decks/",
  url: "/widget/decks",
  trust: "first-party",
};
// The Wallet's read-only tile (PRD-WALLET §3): renders ONLY the non-authoritative
// snapshot the in-process Wallet app writes to `apps/wallet/snapshot.json` — the
// bridge brokers pod I/O only, so the live `/.tokens` ledger is never reachable
// (or needed) from a tile. No bridge widening.
const WALLET_BALANCE_WIDGET: WidgetDecl = {
  id: "balance",
  label: "Balance",
  icon: "💰",
  size: "s",
  maxSize: "m",
  scope: "",
  url: "/widget/wallet-balance",
  trust: "first-party",
};
// Vault is zero-knowledge: this tile reads ONLY the ciphertext file listing under
// `apps/vault/items/` to show a COUNT — it never reads an item body or any secret.
const VAULT_GLANCE_WIDGET: WidgetDecl = {
  id: "glance",
  label: "Vault",
  icon: "🔒",
  size: "m",
  maxSize: "m",
  scope: "",
  url: "/widget/vault-glance",
  trust: "first-party",
};

function builtinApps(): HostedApp[] {
  return [
    { key: "__home__", label: "Home", icon: "🏠", enabled: true },
    { key: "vault", label: "Vault", icon: "🔒", enabled: true, widgets: [VAULT_GLANCE_WIDGET] },
    { key: "identity", label: "Identity", icon: "🪪", enabled: true },
    // The MIND token wallet (PRD-WALLET): in-process + first-party because it
    // reads the server-origin `/.tokens` ledger with the shell's own session
    // and signs transfers via the sealed master DID — neither crosses the bridge.
    { key: "wallet", label: "Wallet", icon: "💰", enabled: true, widgets: [WALLET_BALANCE_WIDGET] },
    {
      key: "drive",
      label: "Drive",
      icon: "📁",
      enabled: true,
      url: DRIVE_URL,
      embed: "iframe",
      trust: "first-party",
      widgets: [RECENT_WIDGET],
    },
    {
      key: "projects",
      label: "Projects",
      icon: "📋",
      enabled: true,
      url: PROJECTS_URL,
      embed: "iframe",
      trust: "first-party",
    },
    {
      key: "notes",
      label: "Notes",
      icon: "📝",
      enabled: true,
      url: NOTES_URL,
      embed: "iframe",
      trust: "first-party",
      // The interactive tile on default Home: write + read in the notes zone. Drive
      // keeps the read-only Recent tile, so Home shows two DISTINCT widgets, each
      // ceilinged to its OWN app zone (per-app scope isolation).
      widgets: [QUICK_NOTE_WIDGET],
    },
    {
      key: "contacts",
      label: "Contacts",
      icon: "👥",
      enabled: true,
      url: CONTACTS_URL,
      embed: "iframe",
      trust: "first-party",
      widgets: [PEOPLE_WIDGET],
    },
    {
      key: "calendar",
      label: "Calendar",
      icon: "📅",
      enabled: true,
      url: CALENDAR_URL,
      embed: "iframe",
      trust: "first-party",
      widgets: [UP_NEXT_WIDGET],
    },
    {
      key: "photos",
      label: "Photos",
      icon: "🖼️",
      enabled: true,
      url: PHOTOS_URL,
      embed: "iframe",
      trust: "first-party",
      widgets: [GALLERY_WIDGET],
    },
    {
      key: "slides",
      label: "Slides",
      icon: "🖥️",
      enabled: true,
      url: SLIDES_URL,
      embed: "iframe",
      trust: "first-party",
      widgets: [DECKS_WIDGET],
    },
  ];
}

/**
 * The app to open on first load. Home is the workspace's default landing surface
 * (PRD-DASHBOARD §9) and a built-in (always present), so it opens by default in
 * every workspace; Drive et al. stay one click away. Falls back to Vault only if
 * the default key is overridden to something absent. Configurable per deploy via
 * `NEXT_PUBLIC_SHELL_DEFAULT_APP` (e.g. set it to `drive` to keep the old default).
 */
const DEFAULT_APP_KEY = process.env.NEXT_PUBLIC_SHELL_DEFAULT_APP ?? "__home__";
const FALLBACK_APP_KEY = "vault";

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [webId, setWebId] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountIdentity | null>(null);
  const [accounts, setAccounts] = useState<AccountIdentity[]>([]);
  const [workspacePod, setWorkspacePod] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [project, setProjectState] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [apps, setApps] = useState<HostedApp[]>(builtinApps());
  // Land on the default surface (Home) immediately, so the first paint isn't a
  // flash of the Vault fallback before the catalog load applies the default.
  const [activeAppKey, setActiveAppKey] = useState<string>(DEFAULT_APP_KEY);
  const [ready, setReady] = useState(false);
  const overridePod = useRef<string | null>(null);
  // The default app is applied exactly once, on the first catalog load — never
  // again, so a later workspace switch or the user's own app choice is honored.
  const defaultApplied = useRef(false);
  // The identity's home pod (where the Workspace index lives). Captured on
  // refresh so switchWorkspace can re-resolve the rail without re-deriving it.
  const homePod = useRef<string | null>(null);

  // Authenticated fetch exposed to hosted apps via the context. Sourced from the
  // platform (web = session().fetch; native = the DPoP-signing pod_fetch shim),
  // resolved per call so the token never needs to live in the webview on native.
  const authedFetch = useRef<typeof fetch>(((input: RequestInfo | URL, init?: RequestInit) =>
    getPlatform().then((p) => p.pod.fetch(input, init))) as typeof fetch).current;

  // Best-effort Workspace display name from a pod's workspace.ttl, falling back
  // to a cached ref name, then the pod's last path segment.
  //
  // We GET workspace.ttl only when the pod root actually lists it. A blind GET on
  // a bare/joined pod (no workspace.ttl) 404s, and the browser logs every failed
  // load to the console even though we catch it — so we gate on a container
  // listing (which 200s) to keep the console clean. workspace.ttl stays
  // authoritative when present; otherwise the cached ref name, then the slug.
  const readWorkspaceName = useCallback(
    async (podRoot: string, fallback?: string): Promise<string> => {
      const slug =
        podRoot.replace(/\/$/, "").split("/").filter(Boolean).pop() ?? "Workspace";
      try {
        const entries = await readdir(podRoot);
        if (entries.some((e) => e.name === "workspace.ttl")) {
          const ttl = await readFileText(`${podRoot}workspace.ttl`);
          const m = ttl.match(/dct:title\s+"([^"]+)"/) ?? ttl.match(/title>?\s*"([^"]+)"/);
          if (m) return m[1];
        }
      } catch {
        /* can't list the pod (no access / offline) — fall back below */
      }
      return fallback ?? slug;
    },
    []
  );

  // Resolve the rail: read the per-identity Workspace index off the home pod,
  // then build a list that is ALWAYS deduped by (normalized) pod root and ALWAYS
  // contains both the personal/home pod and the active pod. Two invariants this
  // guarantees (PRD-IDENTITY.md §4.2):
  //   - the personal workspace never disappears when another is added (the index
  //     may not yet persist a home entry — `ensureHomeRef` fixes the stored side,
  //     this seeds it on the read side regardless), and
  //   - the same pod can never render twice, no matter the trailing-slash form or
  //     whether it came from the index AND the active-pod fallback.
  const resolveWorkspaces = useCallback(
    async (home: string, activePod: string) => {
      const homeN = ensureSlash(home);
      const activeN = ensureSlash(activePod);
      const refs: WorkspaceRef[] = await listWorkspaceRefs(home);

      // Dedupe by normalized pod root. Home is seeded first (always present,
      // always owner); index entries fill in names/roles; the active pod is
      // guaranteed last. Home never gets downgraded or duplicated by an index row.
      const byPod = new Map<string, WorkspaceRef>();
      byPod.set(homeN, { podRoot: homeN, role: "owner" });
      for (const r of refs) {
        const k = ensureSlash(r.podRoot);
        if (k === homeN) {
          byPod.set(k, { podRoot: k, role: "owner", name: r.name ?? byPod.get(k)?.name });
        } else {
          byPod.set(k, { podRoot: k, role: r.role, name: r.name });
        }
      }
      if (!byPod.has(activeN)) byPod.set(activeN, { podRoot: activeN, role: "owner" });

      const resolved: Workspace[] = await Promise.all(
        [...byPod.values()].map(async (r) => ({
          podRoot: r.podRoot,
          name: await readWorkspaceName(r.podRoot, r.name),
          role: r.role,
        }))
      );
      setWorkspaces(resolved);
    },
    [readWorkspaceName]
  );

  // Load the projects + apps for the currently active workspace pod.
  const loadActiveWorkspace = useCallback(async (podRoot: string) => {
    setWorkspacePod(podRoot);

    // Projects under {podRoot}projects/. Gate on the pod-root listing so a pod
    // without a projects/ container doesn't 404 (and log) on every switch.
    try {
      const rootEntries = await readdir(podRoot);
      const hasProjects = rootEntries.some(
        (x) => x.kind === "container" && x.name === "projects"
      );
      const found: Project[] = [];
      if (hasProjects) {
        const entries = await readdir(`${podRoot}projects/`);
        for (const e of entries.filter((x) => x.kind === "container")) {
          const id = e.name;
          let pname = id;
          try {
            const ptl = await readFileText(`${e.url}project.ttl`);
            const pm = ptl.match(/dct:title\s+"([^"]+)"/);
            if (pm) pname = pm[1];
          } catch {}
          found.push({ id, url: e.url, name: pname });
        }
      }
      setProjects(found);
    } catch {
      setProjects([]);
    }

    // Apps: built-ins always (incl. Drive); PLUS pod-owned `embed:"iframe"` apps
    // from the catalog (PRD-APPS §4) so the shell can HOST them in the app body,
    // not just link out. Pure-link apps stay out of `apps` — the waffle still
    // lists them. Non-fatal: a read failure keeps just the built-ins.
    const builtins = builtinApps();
    let merged = builtins;
    try {
      const catalog = await readCatalog(podRoot, authedFetch);
      const hostable = catalog.filter(
        (a) => a.embed === "iframe" && a.url && !builtins.some((b) => b.key === a.key)
      );
      merged = [...builtins, ...hostable];
    } catch {
      /* catalog unreadable — built-ins (incl. Drive) still stand */
    }
    setApps(merged);
    // First load only: open the preferred default app (Drive). It's a built-in
    // now, so it's always present; the guard only matters if the default key is
    // overridden to something absent — then we stay on the Vault fallback.
    if (!defaultApplied.current) {
      defaultApplied.current = true;
      const target = merged.some((a) => a.key === DEFAULT_APP_KEY)
        ? DEFAULT_APP_KEY
        : FALLBACK_APP_KEY;
      if (merged.some((a) => a.key === target)) setActiveAppKey(target);
    }
  }, [authedFetch]);

  const refresh = useCallback(async () => {
    const platform = await getPlatform();
    let info = await platform.auth.ensureSession();
    if (!info.isLoggedIn || !info.webId) {
      // Before bouncing to /connect, try a silent passport resume (web, unlocked
      // wallet): an internal navigation should never flash the login screen for a
      // user whose wallet is still unlocked in this SPA session. A locked wallet
      // returns false here and the guard below routes to /connect for one-tap unlock.
      if (await trySilentResume()) info = await platform.auth.ensureSession();
    }
    if (!info.isLoggedIn || !info.webId) {
      setWebId(null);
      setReady(true);
      return;
    }
    setWebId(info.webId);
    const ident = await readProfile(info.webId);
    setAccount(ident);
    setAccounts(rememberAccount(ident));
    const home = await readPodRoot(info.webId);
    homePod.current = home;
    if (home) {
      const activePod = overridePod.current ?? home;
      await resolveWorkspaces(home, activePod);
      await loadActiveWorkspace(activePod);
    }
    setReady(true);
  }, [resolveWorkspaces, loadActiveWorkspace]);

  useEffect(() => {
    refresh().catch(() => setReady(true));
  }, [refresh]);

  // Guard: once ready and signed-out, send to /connect.
  useEffect(() => {
    if (ready && !webId) router.replace("/connect");
  }, [ready, webId, router]);

  const setActiveApp = useCallback((key: string) => setActiveAppKey(key), []);

  const switchWorkspace = useCallback(
    (podRoot: string) => {
      const target = ensureSlash(podRoot);
      overridePod.current = target;
      setProjectState(null);
      void (async () => {
        if (homePod.current) await resolveWorkspaces(homePod.current, target);
        await loadActiveWorkspace(target);
      })();
    },
    [resolveWorkspaces, loadActiveWorkspace]
  );

  // Join an existing pod as a Workspace (B3): probe access, persist a ref in the
  // identity's index, then switch to it. Provisioning a brand-new pod is B4.
  const addWorkspace = useCallback(
    async (podRoot: string, opts?: { role?: WorkspaceRole; name?: string }) => {
      const home = homePod.current;
      if (!home) throw new Error("No home pod available to register against.");
      const normalized = podRoot.trim().endsWith("/")
        ? podRoot.trim()
        : podRoot.trim() + "/";
      // Validate it's a real http(s) URL before touching the index.
      let url: URL;
      try {
        url = new URL(normalized);
      } catch {
        throw new Error("That doesn't look like a valid pod URL.");
      }
      if (!/^https?:$/.test(url.protocol)) {
        throw new Error("Pod URL must start with http:// or https://.");
      }
      // Probe reachability + access (404 → missing; 401/403 → no access → throws).
      let reachable: boolean;
      try {
        reachable = await exists(normalized);
      } catch {
        throw new Error("Can't access that pod — check the URL and your permissions.");
      }
      if (!reachable) throw new Error("No pod found at that URL.");

      // Persist the personal pod first so adding a sibling never orphans it.
      await ensureHomeRef(home);
      await addWorkspaceRef(home, {
        podRoot: normalized,
        role: opts?.role ?? "member",
        name: opts?.name,
      });
      // switchWorkspace re-resolves the rail (now including the new ref) + activates it.
      switchWorkspace(normalized);
    },
    [switchWorkspace]
  );

  // Provision a brand-new pod reusing this WebID (B4 / PRD-DID §5.7 hybrid), then
  // register + switch to it. The user types ONLY a name: the shell auto-generates
  // the CSS account login (Vault generator), provisions a pod OWNED by this WebID,
  // binds the master DID when the server supports it, and seals the account login
  // in the wallet ("vault") so nothing is lost. Works on both worlds — a stock CSS
  // simply records didLinked:false. A master wallet is optional: with none, the
  // workspace still provisions (name-only), just without DID-link or sealed creds.
  const createWorkspace = useCallback(
    async ({ name, server, email: byoEmail }: { name: string; server?: string; email?: string }) => {
      const home = homePod.current;
      if (!home || !webId) {
        throw new Error("You need to be signed in to create a workspace.");
      }
      const title = name.trim();
      if (!title) throw new Error("Give the workspace a name.");

      // Auto-generate the account login from the audited Vault generator — the
      // user never picks or sees a password (AGENTS.md rule #4/#5).
      const cryptoCore = await (await getPlatform()).crypto.getCore();
      const password = await cryptoCore.generatePassword({
        length: 24,
        upper: true,
        lower: true,
        digits: true,
        symbols: true,
        avoidAmbiguous: true,
      });
      const slug =
        title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
      const rand =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10);
      // A REAL email the user brought (provider verifies) vs. the default
      // non-deliverable placeholder. The bring-your-own address is sealed pending
      // verification (PRD-PROVIDER-ACCOUNTS §6); the placeholder needs none.
      const provided = byoEmail?.trim();
      const email = provided || `${slug}-${rand}@workspace.mind.local`;
      const emailVerified = provided ? false : true;

      // DID-link + sealing need an unlocked master wallet; degrade gracefully.
      const wallet = getWalletView();
      const did = wallet.status === "unlocked" ? getWalletDid() : null;

      const { podRoot, didLinked } = await provisionWorkspaceAccount({
        name: title,
        webId,
        email,
        password,
        server,
        linkDid: did ? { did, sign: walletSign } : undefined,
      });

      // Seal the workspace's account login in the wallet registry ("vault") so the
      // generated password is recoverable — never written to a pod, never logged.
      if (did) {
        await addPassport({
          id: newPassportId(),
          did,
          server: (server ?? podRoot).replace(/\/$/, ""),
          webId, // reused master WebID (hybrid) — not a fresh passport WebID
          podRoots: [podRoot],
          label: title,
          createdAt: new Date().toISOString(),
          workspace: true,
          didLinked,
          creds: { kind: "password", email, password, emailVerified },
        }).catch(() => {
          /* sealing is best-effort; the pod is already usable via OIDC */
        });
      }

      // Best-effort: stamp the title so other shell instances read the same name.
      try {
        const fetchFn = (await getPlatform()).pod.fetch;
        const ttl = `@prefix mind: <https://mind.dev/ns/v1#> .
@prefix dct: <http://purl.org/dc/terms/> .
<#workspace> a mind:Workspace ;
    dct:title "${title.replace(/"/g, '\\"')}" ;
    mind:owner <${webId}> .
`;
        await fetchFn(`${podRoot}workspace.ttl`, {
          method: "PUT",
          headers: { "Content-Type": "text/turtle" },
          body: ttl,
        });
      } catch {
        /* name still resolves from the cached ref */
      }

      // Persist the personal pod first so creating a sibling never orphans it.
      await ensureHomeRef(home);
      await addWorkspaceRef(home, { podRoot, role: "owner", name: title });
      switchWorkspace(podRoot);
    },
    [webId, switchWorkspace]
  );

  const setProject = useCallback((p: Project | null) => setProjectState(p), []);

  // C4: re-resolve identity after a passport switch. Drop the workspace override
  // (the previous identity's active pod isn't ours anymore) and re-run refresh,
  // which reads the now-active WebID from the platform (the passport) and its pod.
  const reloadIdentity = useCallback(async () => {
    overridePod.current = null;
    setProjectState(null);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    const platform = await getPlatform();
    await platform.auth.logout();
    setWebId(null);
    router.replace("/connect");
  }, [router]);

  const value: ShellContextValue = {
    webId,
    accounts: accounts.length ? accounts : listAccounts(),
    account,
    workspacePod,
    workspaces,
    project,
    projects,
    apps,
    activeAppKey,
    fetch: authedFetch,
    ready,
    setActiveApp,
    switchWorkspace,
    addWorkspace,
    createWorkspace,
    setProject,
    refresh,
    reloadIdentity,
    signOut,
  };

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
