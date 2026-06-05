"use client";

import {
  handleIncomingRedirect,
  type ISessionInfo,
} from "@inrupt/solid-client-authn-browser";
import { session } from "./session";

const RETURN_TO_KEY = "mind-shell:return-to";

/**
 * The URL users should land on after the OIDC dance — set right before
 * triggering login(), read by /login/callback once the code is consumed.
 *
 * We deliberately do NOT use `restorePreviousSession: true`. In the @inrupt
 * browser SDK that flag is a full-page redirect to the IdP (not a token-based
 * silent restore), which on CSS produces an infinite /login/callback ↔ /shell
 * loop and discards deep links. The price is that a hard refresh without an
 * OIDC code lands on the signed-out prompt; we soften that by remembering the
 * attempted path (see `rememberSignedOutPath`).
 */
export function rememberReturnTo(url: string) {
  if (typeof window === "undefined") return;
  if (url.startsWith("/login/callback") || url.startsWith("/connect")) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, url);
  } catch {}
}

/**
 * Set the post-login destination ONLY if one isn't already remembered, so a
 * deep link recorded by the signed-out view isn't clobbered by a default.
 */
export function rememberReturnToDefault(url: string) {
  if (typeof window === "undefined") return;
  try {
    if (!sessionStorage.getItem(RETURN_TO_KEY)) rememberReturnTo(url);
  } catch {}
}

export function rememberSignedOutPath() {
  if (typeof window === "undefined") return;
  rememberReturnTo(window.location.pathname + window.location.search);
}

export function consumeReturnTo(): string {
  if (typeof window === "undefined") return "/shell";
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (v && v.startsWith("/") && !v.startsWith("//")) return v;
  } catch {}
  return "/shell";
}

/**
 * Single-flight wrapper around `handleIncomingRedirect` (THE non-negotiable
 * rule — see PRD §2.2). The OIDC authorization code is one-time-use: redeeming
 * it twice makes the token endpoint return `invalid_grant`, which resets the
 * @inrupt session back to signed-out. The shell mounts several session-aware
 * components at once (rail, account switcher, app body), so without this memo
 * they would each call `handleIncomingRedirect` and race to redeem the same
 * code, landing the user signed-out nondeterministically.
 *
 * Memoizing to a module-level promise guarantees the redirect is handled
 * exactly once per page load no matter how many components ask.
 */
let redirectHandled: Promise<void> | null = null;

function handleRedirectOnce(): Promise<void> {
  if (!redirectHandled) {
    redirectHandled = handleIncomingRedirect({
      url: typeof window !== "undefined" ? window.location.href : undefined,
    })
      .then(() => undefined)
      // Swallow: a stale/replayed code rejects here, but the first (winning)
      // call already established the session. Callers re-read session().info.
      .catch(() => undefined);
  }
  return redirectHandled;
}

/**
 * Idempotent session check on page load. Consumes an OIDC code if the URL has
 * one, but does NOT trigger silent re-auth. Returns the current session info —
 * caller is responsible for handling signed-out.
 */
export async function ensureSession(): Promise<ISessionInfo> {
  const s = session();
  if (s.info.isLoggedIn) return s.info;
  await handleRedirectOnce();
  return session().info;
}

/**
 * Completes the OIDC redirect on the /login/callback route. Shares the same
 * single-flight redemption as `ensureSession`, so the callback page and any
 * concurrently-mounted shell component never redeem the code twice.
 */
export async function completeLoginRedirect(): Promise<ISessionInfo> {
  await handleRedirectOnce();
  return session().info;
}
