"use client";

/**
 * On-page CSS account login (the codespaces-style, redirect-free sign-in — but
 * fully client-side, honoring "the pod is the only store; no central DB").
 *
 * This is the *account* plane of CSS (`/.account/`), the same handshake
 * `account.ts` uses to PROVISION pods — here factored for the SIGN-IN direction:
 * log into an existing account with email+password, discover its WebID, and mint
 * durable client-credentials so the shell can run a headless, self-refreshing
 * Solid-OIDC session (via `loginWithClientCredentials`) with NO full-page redirect.
 *
 * Why client-credentials and not the account token itself: a `CSS-Account-Token`
 * authorizes the account API only, not pod I/O. The client-credentials pair runs
 * the standard `client_credentials` grant at the token endpoint → a real DPoP-
 * bound WebID session that reads/writes the pod. Inrupt's own primitives do the
 * crypto (rule #4); the typed password + account token are used once and dropped,
 * never logged (rule #5). The durable creds are sealed in the encrypted wallet by
 * the caller (or held in tab memory) — never written to a pod, never in the clear.
 *
 * CSS-only: external OIDC issuers (and native) still use the redirect path.
 */

import { storedIssuer } from "./session";

/** CSS account API base — the OIDC issuer is the server root for CSS. */
function serverRoot(server?: string): string {
  const base = server ?? storedIssuer();
  return base.endsWith("/") ? base : base + "/";
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** GET headers for the CSS account API (no content-type — CSS 500s on a GET body type). */
function acctGet(token: string) {
  return { Authorization: `CSS-Account-Token ${token}`, Accept: "application/json" };
}
/** POST headers for the CSS account API. */
function acctPost(token: string) {
  return { ...acctGet(token), "Content-Type": "application/json" };
}

/**
 * Log into a CSS account with email+password → a short-lived `CSS-Account-Token`.
 * Mirrors the login steps `createPod` inlines, surfaced for the sign-in flow.
 * Throws a human-readable Error on any failure (caller shows `.message`).
 */
export async function loginToAccount(
  email: string,
  password: string,
  server?: string,
): Promise<string> {
  const root = serverRoot(server);
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

  // 2. Log in (email/password → CSS-Account-Token).
  const loginRes = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status === 401 || loginRes.status === 403) {
    throw new Error("That account email or password wasn't accepted.");
  }
  if (!loginRes.ok) throw new Error(`Account login failed (${loginRes.status}).`);
  const { authorization } = await json<{ authorization?: string }>(loginRes);
  if (!authorization) throw new Error("Account login returned no token.");
  return authorization;
}

/**
 * List the WebID(s) linked to an authenticated account. CSS exposes them via the
 * contextual `controls.account.webId` control, whose GET returns a `webIdLinks`
 * map keyed by WebID (confirmed against CSS v7 / mind-codespaces' css-account.ts).
 * One → use it; many → the caller prompts; none → "register a pod first".
 */
export async function accountWebIds(token: string, server?: string): Promise<string[]> {
  const root = serverRoot(server);
  const accountIndex = `${root}.account/`;
  const ctrlRes = await fetch(accountIndex, { headers: acctGet(token) });
  if (!ctrlRes.ok) throw new Error(`Account lookup failed (${ctrlRes.status}).`);
  const { controls } = await json<{ controls?: { account?: { webId?: string } } }>(ctrlRes);
  const webIdUrl = controls?.account?.webId;
  if (!webIdUrl) throw new Error("This server doesn't expose account WebIDs.");
  const linksRes = await fetch(webIdUrl, { headers: acctGet(token) });
  if (!linksRes.ok) throw new Error(`WebID lookup failed (${linksRes.status}).`);
  const { webIdLinks } = await json<{ webIdLinks?: Record<string, string> }>(linksRes);
  return webIdLinks ? Object.keys(webIdLinks) : [];
}

/**
 * Mint durable client-credentials bound to `webId` for headless, redirect-free
 * sign-in. Same `controls.account.clientCredentials` call `createPassportAccount`
 * makes — surfaced here for an existing account.
 */
export async function mintClientCredentials(
  token: string,
  webId: string,
  server?: string,
  name = "mind-shell",
): Promise<{ id: string; secret: string }> {
  const root = serverRoot(server);
  const accountIndex = `${root}.account/`;
  const ctrlRes = await fetch(accountIndex, { headers: acctGet(token) });
  if (!ctrlRes.ok) throw new Error(`Account lookup failed (${ctrlRes.status}).`);
  const { controls } = await json<{
    controls?: { account?: { clientCredentials?: string } };
  }>(ctrlRes);
  const ccUrl = controls?.account?.clientCredentials;
  if (!ccUrl) throw new Error("This account can't mint sign-in credentials.");
  const ccRes = await fetch(ccUrl, {
    method: "POST",
    headers: acctPost(token),
    body: JSON.stringify({ name, webId }),
  });
  if (!ccRes.ok) throw new Error(`Could not create sign-in credentials (${ccRes.status}).`);
  const cc = await json<{ id?: string; secret?: string }>(ccRes);
  if (!cc.id || !cc.secret) throw new Error("Server returned incomplete credentials.");
  return { id: cc.id, secret: cc.secret };
}

/** Derive the pod root from a CSS WebID (strip a trailing `profile/card#me`). */
export function podRootFromWebId(webId: string): string {
  const noHash = webId.split("#")[0];
  const root = noHash.replace(/profile\/card$/, "").replace(/card$/, "");
  return root.endsWith("/") ? root : root + "/";
}
