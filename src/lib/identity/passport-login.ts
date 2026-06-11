"use client";

/**
 * Headless passport sign-in (PRD-DID C4 / §5.6 — "close the gap").
 *
 * Turns a stored passport into an *active session* with NO redirect and NO typed
 * password. Using the durable client-credentials the wallet captured at
 * provisioning (sealed in the encrypted registry), we run the OAuth
 * `client_credentials` grant against the server's token endpoint and build a
 * DPoP-bound authenticated fetch — then park it in {@link setActivePassportSession}
 * so the whole shell transparently acts as the passport.
 *
 * Crypto note (AGENTS.md rule #4): DPoP proofing + the authenticated fetch are
 * the audited Inrupt SDK's own primitives (`@inrupt/solid-client-authn-core`) —
 * the SAME library that already powers the browser session. We add NO bespoke
 * crypto; the Vault's zero-knowledge core is untouched. The client-credentials
 * secret is read from the unlocked wallet and used only to mint short-lived
 * tokens; it is never logged (rule #5).
 *
 * Web-first: the web build holds the passport fetch in memory. Native custody of
 * passport credentials (Rust-side client-credentials) is a later milestone; we
 * fail loudly there rather than pretend.
 */

import {
  createDpopHeader,
  generateDpopKeyPair,
  buildAuthenticatedFetch,
  type KeyPair,
} from "@inrupt/solid-client-authn-core";
import { ensureSeeded } from "@mind-studio/core/apps";
import { getPlatform } from "@/lib/platform";
import {
  setActivePassportSession,
  clearActivePassportSession,
} from "@/lib/solid/passport-session";
import { loginWithDid } from "@/lib/solid/did-account";
import { podRootFromWebId } from "@/lib/solid/account-login";
import { sign as walletSign, getDid } from "./wallet";
import type { Passport } from "./types";

function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

/** Discover the OIDC token endpoint for a server (CSS: `{root}.oidc/token`). */
async function tokenEndpoint(server: string): Promise<string> {
  const root = ensureSlash(server);
  const res = await fetch(`${root}.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Server has no OIDC metadata (${res.status}).`);
  const cfg = (await res.json()) as { token_endpoint?: string };
  if (!cfg.token_endpoint) throw new Error("Server exposes no token endpoint.");
  return cfg.token_endpoint;
}

interface MintedToken {
  accessToken: string;
  dpopKey: KeyPair;
  /** Epoch ms when the token expires (used to refresh proactively). */
  expiresAt: number;
}

/** Run the client_credentials grant once and return a fresh DPoP-bound token. */
async function mintToken(
  tokenUrl: string,
  id: string,
  secret: string
): Promise<MintedToken> {
  const dpopKey = await generateDpopKeyPair();
  const basic = btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await createDpopHeader(tokenUrl, "POST", dpopKey),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!res.ok) {
    throw new Error(`Could not sign in as this passport (token ${res.status}).`);
  }
  const t = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!t.access_token) throw new Error("Token endpoint returned no access token.");
  const ttlMs = (t.expires_in ?? 600) * 1000;
  return { accessToken: t.access_token, dpopKey, expiresAt: Date.now() + ttlMs };
}

/**
 * A self-refreshing authenticated fetch for a passport. Client-credentials
 * tokens are short-lived (CSS: 10 min) and carry no refresh token, so we re-mint
 * proactively (30s before expiry) and reactively (on a 401), keeping the session
 * usable for as long as the passport stays active.
 */
async function makePassportFetch(
  server: string,
  id: string,
  secret: string
): Promise<typeof fetch> {
  const tokenUrl = await tokenEndpoint(server);
  let current = await mintToken(tokenUrl, id, secret);
  let authFetch = buildAuthenticatedFetch(current.accessToken, {
    dpopKey: current.dpopKey,
  });

  const refresh = async () => {
    current = await mintToken(tokenUrl, id, secret);
    authFetch = buildAuthenticatedFetch(current.accessToken, {
      dpopKey: current.dpopKey,
    });
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (Date.now() > current.expiresAt - 30_000) await refresh();
    let res = await authFetch(input, init);
    if (res.status === 401) {
      await refresh();
      res = await authFetch(input, init);
    }
    return res;
  }) as typeof fetch;
}

/**
 * Establish an active passport session from raw client-credentials — the shared
 * core both the stored-passport path ({@link loginAsPassport}) and the on-page
 * email+password path (`PasswordLoginCard`) build on. Mints a self-refreshing,
 * DPoP-bound authed fetch (Inrupt primitives, no bespoke crypto — rule #4) and
 * parks it as the active session. Web-only for now (native passport custody is a
 * later milestone); we fail loudly rather than pretend.
 */
export async function loginWithClientCredentials(opts: {
  passportId: string;
  server: string;
  webId: string;
  podRoot: string;
  label?: string;
  id: string;
  secret: string;
}): Promise<void> {
  const platform = await getPlatform();
  if (platform.kind !== "web") {
    throw new Error(
      "Headless passport sign-in is available on the web build for now."
    );
  }
  const fetchFn = await makePassportFetch(opts.server, opts.id, opts.secret);
  setActivePassportSession({
    passportId: opts.passportId,
    webId: opts.webId,
    podRoot: opts.podRoot,
    label: opts.label,
    fetch: fetchFn,
  });
}

/**
 * A self-refreshing authenticated fetch for a **DID-session** passport
 * (`solid-server-rs`). Unlike client-credentials there is no stored secret: the
 * token is re-obtained by signing a fresh server challenge with the wallet's
 * master `did:key` (HARD rule #4 — signing is delegated to the audited core).
 * The returned `DID-Session` bearer is sent verbatim as `Authorization`; on a
 * 401 (token aged out) we re-login and retry once. No DPoP: this server issues a
 * plain bearer (verified against its reference client).
 */
async function makeDidSessionFetch(
  server: string,
  did: string,
  sign: (payload: string) => Promise<string>,
  initialToken: string
): Promise<typeof fetch> {
  let token = initialToken;

  const withAuth = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set("authorization", token);
    return fetch(input, { ...init, headers });
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let res = await withAuth(input, init);
    if (res.status === 401) {
      token = (await loginWithDid({ did, sign, server })).token;
      res = await withAuth(input, init);
    }
    return res;
  }) as typeof fetch;
}

/**
 * Sign in via **server-side DID login** and make it the shell's active identity
 * (`solid-server-rs` and any server exposing the DID challenge/login protocol).
 * Proves control of the wallet's master DID by signing a server challenge — no
 * password, no redirect, no client-credentials — and on first login the server
 * auto-provisions the pod. Returns the authenticated WebID + pod root so the
 * caller can seal a resumable `did`-kind passport.
 */
export async function loginWithDidSession(opts: {
  passportId: string;
  server: string;
  did: string;
  sign: (payload: string) => Promise<string>;
  label?: string;
}): Promise<{ webId: string; podRoot: string }> {
  const platform = await getPlatform();
  if (platform.kind !== "web") {
    throw new Error("DID sign-in is available on the web build for now.");
  }
  const { token, webId } = await loginWithDid({
    did: opts.did,
    sign: opts.sign,
    server: opts.server,
  });
  if (!webId) {
    throw new Error("This server's DID login returned no WebID to act as.");
  }
  const podRoot = podRootFromWebId(webId);
  const fetchFn = await makeDidSessionFetch(opts.server, opts.did, opts.sign, token);
  setActivePassportSession({
    passportId: opts.passportId,
    webId,
    podRoot,
    label: opts.label,
    fetch: fetchFn,
  });
  // The server auto-provisions the pod on first DID login; seed the app catalog
  // so the first /shell render is clean (mirrors enterPassport). Best-effort.
  try {
    await ensureSeeded(podRoot, platform.pod.fetch);
  } catch {
    /* non-fatal — the launcher self-seeds on first open */
  }
  return { webId, podRoot };
}

/**
 * Re-establish a stored `did`-kind passport's session (background resume / switch)
 * by re-running DID login with the unlocked wallet. The master seed never leaves
 * the core — only a signature crosses the FFI.
 */
async function enterDidPassport(passport: Passport): Promise<void> {
  const did = getDid();
  if (!did) throw new Error("Unlock your wallet to resume this DID identity.");
  await loginWithDidSession({
    passportId: passport.id,
    server: passport.server,
    did,
    sign: walletSign,
    label: passport.label,
  });
}

/**
 * Sign in headlessly AS `passport` and make it the shell's active identity.
 * Requires the passport to carry client-credentials (provisioned passports do;
 * manually-captured ones don't — they still use a normal /connect sign-in).
 */
export async function loginAsPassport(passport: Passport): Promise<void> {
  const creds = passport.creds;
  if (!creds || creds.kind !== "client-credentials" || !creds.id || !creds.secret) {
    throw new Error("This passport has no stored credentials to sign in with.");
  }
  await loginWithClientCredentials({
    passportId: passport.id,
    server: passport.server,
    webId: passport.webId,
    podRoot: passport.podRoots[0],
    label: passport.label,
    id: creds.id,
    secret: creds.secret,
  });
}

/**
 * Sign in as a passport AND make sure its pod is ready for the shell to render
 * cleanly. On a brand-new passport pod the launcher's app grid would otherwise
 * probe a not-yet-seeded `home/apps.ttl` (a 404) on the marquee screen; seeding
 * the catalog here (with the shared launcher's own `ensureSeeded`) means the pod
 * arrives initialized and the first /shell render is clean. Best-effort — a
 * failure just defers to the launcher's own first-open self-seed.
 *
 * This is the entry point switch paths should use (the new-user onboarding, the
 * Identity app's "Switch to this passport", and the account switcher).
 */
export async function enterPassport(passport: Passport): Promise<void> {
  if (passport.creds?.kind === "did") {
    await enterDidPassport(passport);
  } else {
    await loginAsPassport(passport);
  }
  try {
    const platform = await getPlatform();
    await ensureSeeded(passport.podRoots[0], platform.pod.fetch);
  } catch {
    /* non-fatal — the launcher self-seeds on first open */
  }
}

/** Drop the active passport session (return to the main OIDC WebID). */
export function logoutPassport(): void {
  clearActivePassportSession();
}
