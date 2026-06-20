"use client";

import { type DidSigner, linkDidToAccount } from "./did-account";
import { storedIssuer } from "./session";

/**
 * The CSS **account-session** plane (PRD-IDENTITY.md §4.1 mechanism B, used only
 * for provisioning — B4).
 *
 * The shell normally holds a *WebID* session via Solid-OIDC (`session().fetch`).
 * Creating a brand-new pod is the one operation that needs the *account* session
 * instead — an email/password login that returns a short-lived `CSS-Account-Token`
 * (the same handshake `scripts/seed-demo.ts` does in Node). We do it here, in the
 * browser, scoped to a single provision call.
 *
 * Crucially this provisions the pod **reusing the signed-in WebID** (PRD §4.6):
 * `POST controls.account.pod { name, settings: { webId } }` makes CSS skip its
 * default "mint a new WebID per pod" behavior, so the new pod is pure storage
 * owned (WAC) by the existing WebID — Phase B's `1 WebID → N Pods`.
 *
 * Security: the account password and the returned token live only inside
 * `provisionPod`'s scope — never persisted, never logged (AGENTS.md rule #5).
 * The only thing that leaves this module is the new pod's root URL + WebID.
 */

export interface ProvisionResult {
  /** The new pod's root, trailing-slashed. */
  podRoot: string;
  /** The WebID that owns it — the reused one (B4), or the freshly minted one (C2). */
  webId: string;
}

/** CSS account API base — the OIDC issuer is the server root for CSS. */
function serverRoot(server?: string): string {
  const base = server ?? storedIssuer();
  return base.endsWith("/") ? base : base + "/";
}

/** Pod path segment from a human workspace name (CSS uses `name` as the path). */
function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "workspace";
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * True iff the server exposes the CSS account-creation API (an unauthenticated
 * `.account/` index advertising `controls.account.create`). A DID-only server
 * (e.g. solid-server-rs) has no account plane at all — its one pod is created
 * at DID sign-in — so workspace provisioning can't work there. Never throws;
 * unreachable/odd servers resolve `false`.
 */
export async function serverSupportsAccountCreation(server?: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverRoot(server)}.account/`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const idx = (await res.json()) as { controls?: { account?: { create?: string } } };
    return Boolean(idx.controls?.account?.create);
  } catch {
    return false;
  }
}

/**
 * Create a pod on a CSS server via the account-session handshake.
 *
 * Two modes, one handshake (PRD-DID §5.7):
 *   - `webId` PRESENT (Phase-B B4): pass `settings.webId` so CSS REUSES the
 *     existing WebID — `1 WebID → N Pods`.
 *   - `webId` ABSENT (Phase-C passport): omit it, so CSS MINTS A FRESH WebID
 *     (its default) — a new per-server identity. The returned `webId` is that
 *     fresh one.
 *
 * `server` defaults to the stored OIDC issuer (the current server). Throws a
 * human-readable Error on any failure (caller surfaces `.message`).
 */
export async function createPod(opts: {
  name: string;
  email: string;
  password: string;
  /** Reuse this WebID (B4); omit to mint a fresh one (C2 passport). */
  webId?: string;
  /** Target server origin; defaults to the stored issuer. */
  server?: string;
}): Promise<ProvisionResult> {
  const root = serverRoot(opts.server);
  const accountIndex = `${root}.account/`;

  // 1. Discover the password-login control (unauthenticated index).
  let idxRes: Response;
  try {
    idxRes = await fetch(accountIndex, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Can't reach the account server — is it online?");
  }
  if (!idxRes.ok) throw new Error(`Can't reach the account server (${idxRes.status}).`);
  const idx = await json<{ controls?: { password?: { login?: string } } }>(idxRes);
  const loginUrl = idx.controls?.password?.login;
  if (!loginUrl) throw new Error("This server doesn't support password login.");

  // 2. Log in to the CSS *account* (email/password → CSS-Account-Token).
  const loginRes = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  });
  if (loginRes.status === 401 || loginRes.status === 403) {
    throw new Error("That account email or password wasn't accepted.");
  }
  if (!loginRes.ok) throw new Error(`Account login failed (${loginRes.status}).`);
  const { authorization } = await json<{ authorization?: string }>(loginRes);
  if (!authorization) throw new Error("Account login returned no token.");
  const authHeader = { Authorization: `CSS-Account-Token ${authorization}` };

  // 3. Re-read the index *as the logged-in account* — the `pod` create control
  //    only appears once authenticated (CSS controls are contextual).
  const meRes = await fetch(accountIndex, {
    headers: { ...authHeader, Accept: "application/json" },
  });
  if (!meRes.ok) throw new Error(`Account lookup failed (${meRes.status}).`);
  const me = await json<{ controls?: { account?: { pod?: string } } }>(meRes);
  const podUrl = me.controls?.account?.pod;
  if (!podUrl) throw new Error("This account isn't allowed to create pods.");

  // 4. Create the pod. With `webId` → reuse it (settings.webId); without →
  //    let CSS mint a fresh WebID (its default), which is the passport identity.
  const slug = slugify(opts.name);
  const body: { name: string; settings?: { webId: string } } = { name: slug };
  if (opts.webId) body.settings = { webId: opts.webId };
  const createRes = await fetch(podUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeader },
    body: JSON.stringify(body),
  });
  if (createRes.status === 400 || createRes.status === 409) {
    throw new Error(`A workspace named "${slug}" already exists on this server.`);
  }
  if (!createRes.ok) throw new Error(`Pod creation failed (${createRes.status}).`);
  const created = await json<{ pod?: string; webId?: string }>(createRes).catch(
    () => ({}) as { pod?: string; webId?: string },
  );

  const podRoot = created.pod ?? `${root}${slug}/`;
  const webId = created.webId ?? opts.webId;
  if (!webId) {
    throw new Error("Pod created but the server returned no WebID.");
  }
  return {
    podRoot: podRoot.endsWith("/") ? podRoot : podRoot + "/",
    webId,
  };
}

/**
 * Provision a new pod (Workspace) reusing the existing WebID (Phase-B B4). Thin
 * wrapper over {@link createPod} kept for the shell's `createWorkspace` path.
 */
export async function provisionPod(opts: {
  name: string;
  email: string;
  password: string;
  webId: string;
}): Promise<ProvisionResult> {
  return createPod(opts);
}

// ---------------------------------------------------------------------------
// Self-service passport account (PRD-DID C2 — "close the gap")
// ---------------------------------------------------------------------------

/** A provisioned passport account: fresh WebID + pod + headless re-auth creds. */
export interface PassportAccountResult extends ProvisionResult {
  /** Client-credentials token for headless (no-redirect, no-typing) sign-in. */
  creds: { id: string; secret: string };
}

/** GET headers for the CSS account API (no content-type — CSS 500s on a GET body type). */
function acctGet(token: string) {
  return { Authorization: `CSS-Account-Token ${token}`, Accept: "application/json" };
}
/** POST headers for the CSS account API. */
function acctPost(token: string) {
  return { ...acctGet(token), "Content-Type": "application/json" };
}

/** The contextual account controls that appear once authenticated. */
interface AuthedControls {
  password?: { create?: string };
  account?: { pod?: string; clientCredentials?: string };
}

/**
 * Create a brand-new, fully independent CSS account and passport in one flow
 * (PRD-DID §5.7 / §5.6). Unlike {@link createPod} (which logs into an EXISTING
 * account to mint a pod), this owns the whole lifecycle so each passport is its
 * own account with its own auto-generated password — the user never picks or
 * types one:
 *
 *   1. POST `account.create`            → a fresh empty account + session token
 *   2. POST `password.create {email,pw}`→ attach a password login
 *   3. POST `account.pod {name}`        → a FRESH WebID + pod (CSS default)
 *   4. POST `account.clientCredentials` → durable {id,secret} for headless login
 *   5. (optional) bind the master DID to this account via the DID-login extension
 *      (SOLID_DID.md US-1), while the account token is still in scope. Best-effort:
 *      a stock CSS without the extension simply skips this — provisioning still
 *      succeeds, and the client-credentials path remains the universal fallback.
 *
 * The auto-generated password is used once here and dropped; the durable key the
 * wallet keeps is the client-credentials pair (sealed in the encrypted registry,
 * never written to a pod, never logged — AGENTS.md rule #5). Only the public
 * WebID + pod root + the (secret-bearing) creds leave this call.
 */
export async function createPassportAccount(opts: {
  email: string;
  password: string;
  /** Pod path slug; a short random suffix is appended to avoid collisions. */
  name: string;
  /** Target server origin; defaults to the stored issuer. */
  server?: string;
  /**
   * When set, bind this master DID to the new account so it can later log in by
   * signing a server challenge (no stored password). Signing is delegated to the
   * wallet's audited core (HARD rule #4).
   */
  linkDid?: { did: string; sign: DidSigner };
}): Promise<PassportAccountResult & { didLinked: boolean }> {
  const root = serverRoot(opts.server);
  const accountIndex = `${root}.account/`;

  // 1. Create a fresh account (unauthenticated POST) → a session token.
  let createRes: Response;
  try {
    createRes = await fetch(`${accountIndex}account/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
  } catch {
    throw new Error("Can't reach the account server — is it online?");
  }
  if (!createRes.ok) {
    // Some servers disable open registration.
    throw new Error(
      createRes.status === 403 || createRes.status === 404
        ? "This server doesn't allow creating new accounts."
        : `Account creation failed (${createRes.status}).`,
    );
  }
  const { authorization: token } = await json<{ authorization?: string }>(createRes);
  if (!token) throw new Error("Account creation returned no session token.");

  // 2. Re-read the index as the new account — the create/pod controls are contextual.
  const ctrlRes = await fetch(accountIndex, { headers: acctGet(token) });
  if (!ctrlRes.ok) throw new Error(`Account lookup failed (${ctrlRes.status}).`);
  const { controls } = await json<{ controls?: AuthedControls }>(ctrlRes);
  const pwCreate = controls?.password?.create;
  const podCtl = controls?.account?.pod;
  const ccCtl = controls?.account?.clientCredentials;
  if (!pwCreate || !podCtl || !ccCtl) {
    throw new Error("This server's account API can't provision passports.");
  }

  // 3. Attach a password login (the password is auto-generated upstream).
  const pwRes = await fetch(pwCreate, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  });
  if (!pwRes.ok) {
    throw new Error(
      pwRes.status === 400 || pwRes.status === 409
        ? "That account email is already taken — try again."
        : `Setting the account password failed (${pwRes.status}).`,
    );
  }

  // 4. Create the pod — no settings.webId, so CSS mints a FRESH WebID.
  const slug = `${slugify(opts.name)}-${randomSuffix()}`;
  const podRes = await fetch(podCtl, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ name: slug }),
  });
  if (!podRes.ok) {
    throw new Error(`Pod creation failed (${podRes.status}).`);
  }
  const pod = await json<{ pod?: string; webId?: string }>(podRes);
  if (!pod.webId || !pod.pod) {
    throw new Error("Pod created but the server returned no WebID.");
  }

  // 5. Mint durable client credentials bound to the fresh WebID.
  const ccRes = await fetch(ccCtl, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ name: "mind-shell", webId: pod.webId }),
  });
  if (!ccRes.ok) {
    throw new Error(`Could not mint passport credentials (${ccRes.status}).`);
  }
  const cc = await json<{ id?: string; secret?: string }>(ccRes);
  if (!cc.id || !cc.secret) {
    throw new Error("Server returned incomplete passport credentials.");
  }

  // 6. Best-effort: bind the master DID while we still hold the account token.
  //    A stock CSS (no DID extension) returns false; a hard failure mid-link is
  //    non-fatal — the passport is already usable via client-credentials.
  let didLinked = false;
  if (opts.linkDid) {
    try {
      didLinked = await linkDidToAccount({
        did: opts.linkDid.did,
        sign: opts.linkDid.sign,
        accountToken: token,
        server: opts.server,
      });
    } catch {
      didLinked = false;
    }
  }

  return {
    podRoot: pod.pod.endsWith("/") ? pod.pod : pod.pod + "/",
    webId: pod.webId,
    creds: { id: cc.id, secret: cc.secret },
    didLinked,
  };
}

/** A provisioned hybrid workspace: a pod owned by the REUSED master WebID. */
export interface WorkspaceAccountResult extends ProvisionResult {
  /** The auto-generated CSS account login — sealed in the wallet, never shown. */
  account: { email: string; password: string };
  /** True once the master DID was bound to this account (DID-aware CSS only). */
  didLinked: boolean;
}

/**
 * Provision a **hybrid workspace** (PRD-DID §5.7, "reuse my WebID"): the user
 * types only a name; the shell does the rest. Unlike {@link createPassportAccount}
 * (fresh WebID) and {@link createPod} (needs a typed password), this:
 *
 *   1. POST `account.create`              → a throwaway account + session token
 *   2. POST `password.create {email,pw}`  → attach an AUTO-GENERATED login
 *   3. POST `account.pod {name, settings.webId: MY_WEBID}`
 *                                         → a pod OWNED (WAC) by the reused WebID
 *   4. (DID-aware CSS) link the master DID to this account — best-effort
 *
 * The account email+password are auto-generated by the caller (the Vault's audited
 * generator) and returned so the wallet can seal them — the user never types or
 * sees one. The pod is owned by the signed-in WebID, so the existing OIDC session
 * reads/writes it with no extra credential; the sealed account login is kept only
 * so the workspace's account stays recoverable (and, on a DID server, DID-linked).
 *
 * Works on BOTH worlds: a stock CSS skips step 4 (`didLinked:false`); a DID-aware
 * CSS binds the DID (`didLinked:true`). Security: the generated password leaves
 * this module ONLY in the result (for sealing) — never logged (AGENTS.md rule #5).
 */
export async function provisionWorkspaceAccount(opts: {
  /** Human workspace name → pod slug. */
  name: string;
  /** The signed-in WebID to own the pod (reused — the hybrid model). */
  webId: string;
  /** Auto-generated CSS account login (from the Vault generator). */
  email: string;
  password: string;
  /** Target server origin; defaults to the stored issuer. */
  server?: string;
  /** Bind the master DID to the new account (best-effort, DID-aware CSS only). */
  linkDid?: { did: string; sign: DidSigner };
}): Promise<WorkspaceAccountResult> {
  const root = serverRoot(opts.server);
  const accountIndex = `${root}.account/`;

  // 1. Create a throwaway account (unauthenticated POST) → a session token.
  let createRes: Response;
  try {
    createRes = await fetch(`${accountIndex}account/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
  } catch {
    throw new Error("Can't reach the account server — is it online?");
  }
  if (!createRes.ok) {
    // 401 too: a server with no account API (e.g. a DID-only server) falls
    // through to its storage layer, which answers 401 — not "bad credentials".
    throw new Error(
      createRes.status === 401 || createRes.status === 403 || createRes.status === 404
        ? "This server doesn't allow creating new accounts."
        : `Account creation failed (${createRes.status}).`,
    );
  }
  const { authorization: token } = await json<{ authorization?: string }>(createRes);
  if (!token) throw new Error("Account creation returned no session token.");

  // 2. Re-read the index as the new account — controls are contextual.
  const ctrlRes = await fetch(accountIndex, { headers: acctGet(token) });
  if (!ctrlRes.ok) throw new Error(`Account lookup failed (${ctrlRes.status}).`);
  const { controls } = await json<{ controls?: AuthedControls }>(ctrlRes);
  const pwCreate = controls?.password?.create;
  const podCtl = controls?.account?.pod;
  if (!pwCreate || !podCtl) {
    throw new Error("This server's account API can't provision workspaces.");
  }

  // 3. Attach the auto-generated password login.
  const pwRes = await fetch(pwCreate, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  });
  if (!pwRes.ok) {
    throw new Error(
      pwRes.status === 400 || pwRes.status === 409
        ? "Couldn't set up the workspace account — try again."
        : `Setting the account password failed (${pwRes.status}).`,
    );
  }

  // 4. Create the pod REUSING the master WebID — CSS sets it as WAC owner.
  const slug = `${slugify(opts.name)}-${randomSuffix()}`;
  const podRes = await fetch(podCtl, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ name: slug, settings: { webId: opts.webId } }),
  });
  if (createRes.status === 400 || podRes.status === 409) {
    throw new Error(`A workspace named "${slug}" already exists on this server.`);
  }
  if (!podRes.ok) throw new Error(`Pod creation failed (${podRes.status}).`);
  const pod = await json<{ pod?: string; webId?: string }>(podRes);
  if (!pod.pod) throw new Error("Pod created but the server returned no pod URL.");

  // 5. Best-effort DID link while we still hold the account token. Stock CSS
  //    returns false; a mid-link error is non-fatal (the pod already exists).
  let didLinked = false;
  if (opts.linkDid) {
    try {
      didLinked = await linkDidToAccount({
        did: opts.linkDid.did,
        sign: opts.linkDid.sign,
        accountToken: token,
        server: opts.server,
      });
    } catch {
      didLinked = false;
    }
  }

  return {
    podRoot: pod.pod.endsWith("/") ? pod.pod : pod.pod + "/",
    webId: pod.webId ?? opts.webId,
    account: { email: opts.email, password: opts.password },
    didLinked,
  };
}

/** Short random hex suffix for collision-resistant pod slugs. */
function randomSuffix(): string {
  const buf = new Uint8Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
