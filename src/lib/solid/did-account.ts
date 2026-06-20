"use client";

import { storedIssuer } from "./session";

/**
 * Server-side **DID login** to a CSS account (SOLID_DID.md US-2).
 *
 * This is the counterpart to the wallet-centric path: instead of re-authenticating
 * to a server's account API with a stored password, the wallet's master `did:key`
 * is bound to the CSS account once ({@link linkDidToAccount}) and thereafter proves
 * control by signing a short-lived, server-issued challenge ({@link loginWithDid}).
 * The result is a normal `CSS-Account-Token` — identical to what password login
 * yields — so every existing account-API call (create pod, mint client-credentials)
 * works unchanged.
 *
 * Requires a DID-aware CSS (one exposing `controls.did.*`). Against a stock server
 * these helpers throw / no-op, so the existing password+client-credentials flow
 * stays the universal fallback.
 *
 * Crypto: the challenge `payload` is signed verbatim by the audited wallet core
 * (Ed25519, raw UTF-8, base64) — the SAME `sign` primitive that writes binding
 * documents. No bespoke crypto here; the master seed never leaves the core.
 */

/** Discovered DID controls on a DID-aware CSS. */
interface DidControls {
  /** Login challenge endpoint (unauthenticated). */
  challenge?: string;
  /** Login finish endpoint (unauthenticated). */
  login?: string;
  /** Account-authorized link endpoint (start + finish). */
  link?: string;
}

/** A server-issued challenge: the exact string to sign. */
interface DidChallenge {
  nonce: string;
  payload: string;
  expiresAt?: string;
}

/** Signs a UTF-8 payload with the master key (i.e. `wallet.sign`). */
export type DidSigner = (payload: string) => Promise<string>;

function serverRoot(server?: string): string {
  const base = server ?? storedIssuer();
  return base.endsWith("/") ? base : base + "/";
}

async function readControls(
  accountIndex: string,
  headers: Record<string, string>,
): Promise<DidControls> {
  let res: Response;
  try {
    res = await fetch(accountIndex, { headers: { Accept: "application/json", ...headers } });
  } catch {
    throw new Error("Can't reach the account server — is it online?");
  }
  if (!res.ok) throw new Error(`Can't reach the account server (${res.status}).`);
  const idx = (await res.json()) as { controls?: { did?: DidControls } };
  return idx.controls?.did ?? {};
}

/**
 * Read DID controls, tolerating both server shapes:
 *  - CSS DID-fork: advertised on the (authed) account index `{root}.account/`
 *    as `controls.did.{challenge,login,link}`.
 *  - solid-server-rs: a dedicated, unauthenticated discovery doc at
 *    `{root}.account/did/` with the SAME `{controls:{did:{challenge,login}}}`
 *    shape (no `link` — DID login auto-provisions the pod on first use).
 *
 * We try the dedicated doc first (cheap, unauthenticated, no 401 noise on
 * solid-server-rs) and fall back to the account index for the CSS fork.
 */
async function readDidControls(
  root: string,
  headers: Record<string, string>,
): Promise<DidControls> {
  try {
    const did = await readControls(`${root}.account/did/`, headers);
    if (did.challenge && did.login) return did;
  } catch {
    /* fall through to the CSS-fork account index */
  }
  return readControls(`${root}.account/`, headers);
}

/**
 * Probe whether a server is DID-aware (advertises `controls.did.challenge` +
 * `.login`). Used by the UI to show the DID-login affordance only where it can
 * actually work — instead of letting the user click into a dead end on stock
 * CSS. Never throws: an unreachable or non-DID server simply resolves `false`.
 */
export async function serverSupportsDid(server?: string): Promise<boolean> {
  try {
    const did = await readDidControls(serverRoot(server), {});
    return Boolean(did.challenge && did.login);
  } catch {
    return false;
  }
}

/** The result of a successful DID login. */
export interface DidLoginResult {
  /**
   * The authorization token to present on subsequent requests, **including its
   * scheme prefix**. On the CSS DID-fork this is a `CSS-Account-Token …` (used
   * against the account API); on `solid-server-rs` it's a `DID-Session …`
   * bearer usable directly for LDP. Send it verbatim as `Authorization`.
   */
  token: string;
  /**
   * The WebID the server authenticated us as. The CSS fork omits it (the caller
   * already knows the account's WebID); `solid-server-rs` returns it (and has
   * auto-provisioned that WebID's pod on first login).
   */
  webId?: string;
}

/**
 * Log in by proving control of a DID. Returns the authorization token (with its
 * scheme prefix) and, when the server supplies it, the authenticated WebID.
 *
 * @throws if the server is not DID-aware, the DID is not linked, or the proof
 * is rejected.
 */
export async function loginWithDid(opts: {
  did: string;
  sign: DidSigner;
  /** Target server origin; defaults to the stored issuer. */
  server?: string;
}): Promise<DidLoginResult> {
  const did = await readDidControls(serverRoot(opts.server), {});
  if (!did.challenge || !did.login) {
    throw new Error("This server doesn't support DID login.");
  }

  // 1. Ask for a challenge bound to our DID.
  const startRes = await fetch(did.challenge, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ did: opts.did }),
  });
  if (!startRes.ok) throw new Error(`Could not start DID login (${startRes.status}).`);
  const challenge = (await startRes.json()) as DidChallenge;
  if (!challenge.nonce || !challenge.payload) {
    throw new Error("Server returned an invalid DID challenge.");
  }

  // 2. Sign the exact server-issued payload and finish the login.
  const proofValue = await opts.sign(challenge.payload);
  const finishRes = await fetch(did.login, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ did: opts.did, nonce: challenge.nonce, proofValue }),
  });
  if (finishRes.status === 401 || finishRes.status === 403) {
    throw new Error(
      "This DID is not linked to an account on this server, or the proof was rejected.",
    );
  }
  if (!finishRes.ok) throw new Error(`DID login failed (${finishRes.status}).`);
  const { authorization, webid, webId } = (await finishRes.json()) as {
    authorization?: string;
    webid?: string;
    webId?: string;
  };
  if (!authorization) throw new Error("DID login returned no token.");
  return { token: authorization, webId: webid ?? webId };
}

/**
 * Bind a DID to the CSS account identified by an active `CSS-Account-Token`
 * (SOLID_DID.md US-1). Runs the account-authorized link challenge: start →
 * sign → finish.
 *
 * No-throw on a stock (non-DID) server: returns `false` so callers can treat
 * DID binding as best-effort during provisioning. Returns `true` once bound.
 */
export async function linkDidToAccount(opts: {
  did: string;
  sign: DidSigner;
  /** A `CSS-Account-Token` for the account to bind the DID to. */
  accountToken: string;
  server?: string;
}): Promise<boolean> {
  const accountIndex = `${serverRoot(opts.server)}.account/`;
  const authHeader = { Authorization: `CSS-Account-Token ${opts.accountToken}` };
  const did = await readControls(accountIndex, authHeader);
  if (!did.link) {
    // Stock CSS without the DID extension — nothing to bind to.
    return false;
  }

  const post = (body: unknown): Promise<Response> =>
    fetch(did.link!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeader },
      body: JSON.stringify(body),
    });

  // 1. Start: request a link challenge for our DID.
  const startRes = await post({ did: opts.did });
  if (!startRes.ok) throw new Error(`Could not start DID link (${startRes.status}).`);
  const challenge = (await startRes.json()) as DidChallenge;
  if (!challenge.nonce || !challenge.payload) {
    throw new Error("Server returned an invalid DID link challenge.");
  }

  // 2. Finish: sign the payload and store the binding.
  const proofValue = await opts.sign(challenge.payload);
  const finishRes = await post({ did: opts.did, nonce: challenge.nonce, proofValue });
  if (!finishRes.ok) throw new Error(`Could not finish DID link (${finishRes.status}).`);
  return true;
}
