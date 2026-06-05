"use client";

/**
 * The active *passport* session (PRD-DID C4 — "close the gap").
 *
 * The browser Solid SDK keeps exactly one OIDC session (your "main" WebID). A
 * passport is a *different* WebID the master DID controls; to act AS it without a
 * full-page re-auth, the wallet mints a headless client-credentials session
 * (see identity/passport-login.ts) and parks the resulting authenticated `fetch`
 * here. The platform layer (platform/web.ts) consults this override so ALL pod
 * I/O — and the shell's notion of "who am I" — transparently becomes the passport
 * while it's active. Clearing it falls straight back to the underlying OIDC
 * session (no re-auth to come back).
 *
 * This module is pure state with no identity/crypto deps, so platform/web.ts can
 * import it without a dependency cycle. The `fetch` it holds is a normal authed
 * fetch (DPoP handled by the Inrupt SDK); no secret is stored here — the durable
 * client-credentials live only in the encrypted wallet registry.
 *
 * Single-flight OIDC is untouched: switching never calls `handleIncomingRedirect`
 * (AGENTS.md HARD rule #3).
 */

import { LAST_ACTIVE_PASSPORT_KEY } from "@/lib/identity/types";

export interface ActivePassportSession {
  /** The passport's local registry id. */
  passportId: string;
  /** The passport's WebID (what the shell reports as the active identity). */
  webId: string;
  /** The passport's pod root (trailing-slashed). */
  podRoot: string;
  /** Human label for chrome ("Work"). */
  label?: string;
  /** Authenticated fetch acting as this passport (self-refreshing). */
  fetch: typeof fetch;
}

let active: ActivePassportSession | null = null;
const listeners = new Set<() => void>();

/** The active passport session, or null when running as the main OIDC WebID. */
export function getActivePassportSession(): ActivePassportSession | null {
  return active;
}

/** Set (or clear, with null) the active passport session and notify subscribers. */
export function setActivePassportSession(s: ActivePassportSession | null): void {
  active = s;
  // Persist a non-secret pointer to the active passport so a returning visit can
  // resume the same identity (background resume / one-tap unlock). Only the id is
  // stored — never creds (those stay sealed in the encrypted wallet).
  if (typeof window !== "undefined") {
    try {
      if (s) localStorage.setItem(LAST_ACTIVE_PASSPORT_KEY, s.passportId);
      else localStorage.removeItem(LAST_ACTIVE_PASSPORT_KEY);
    } catch {
      /* private-mode / disabled storage — resume just won't be available */
    }
  }
  for (const l of listeners) l();
}

/** Drop the passport session — fall back to the main OIDC WebID. */
export function clearActivePassportSession(): void {
  setActivePassportSession(null);
}

/** Subscribe to passport-session changes (switch in / switch back). */
export function subscribePassportSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
