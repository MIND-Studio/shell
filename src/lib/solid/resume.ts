"use client";

/**
 * Background session resume (the "automated / background connect" path).
 *
 * A returning user shouldn't re-type their way in every visit. This module owns
 * the single decision the apex router (`app/page.tsx`) and the shell guard
 * (`context.tsx`) both make on load: are we already in, can we resume silently,
 * or do we need a one-tap unlock / a full connect?
 *
 * It honors the custody model (AGENTS.md): the master seed is never stored, so a
 * hard reload that dropped the in-memory passport session and locked the wallet
 * can only be resumed by re-deriving the key from the master password — hence the
 * `'unlock'` state (a single password entry, no redirect, no re-typed email/issuer).
 * Within a live SPA session the wallet stays unlocked, so resume is fully silent.
 *
 * Web-only: native (Tauri) holds a durable Rust session that `ensureSession()`
 * restores on its own, so this never reaches the passport path there.
 *
 * No bespoke crypto, no new persistence: the only thing read here is the public
 * last-active-passport pointer (a registry id) plus the already-unlocked wallet.
 */

import { getPlatform } from "@/lib/platform";
import { hasWallet, getView, getPassports } from "@/lib/identity/wallet";
import { enterPassport } from "@/lib/identity/passport-login";
import { LAST_ACTIVE_PASSPORT_KEY, type Passport } from "@/lib/identity/types";
import { isVerificationPending } from "@/lib/identity/email";
import { getActivePassportSession } from "./passport-session";

/** Where the front door should send the user on load. */
export type EntryState = "in" | "unlock" | "connect";

function readLastActivePassportId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_ACTIVE_PASSPORT_KEY);
  } catch {
    return null;
  }
}

/**
 * A passport is silently resumable iff the unlocked wallet can re-establish its
 * session with no user input:
 *   - `client-credentials`: re-mint a token from the sealed `{id,secret}` (and
 *     only once its email isn't awaiting verification — PRD-PROVIDER-ACCOUNTS §6,
 *     so we never auto-enter an account the provider hasn't confirmed yet).
 *   - `did`: re-sign a fresh server challenge with the master `did:key` — no
 *     stored secret needed, so always resumable while the wallet is unlocked.
 */
function isResumable(p: Passport): boolean {
  if (p.creds?.kind === "did") return true;
  return (
    p.creds?.kind === "client-credentials" &&
    !!p.creds.id &&
    !!p.creds.secret &&
    !isVerificationPending(p.creds)
  );
}

/** Prefer the last-active passport; fall back to the first resumable one. */
function pickResumable(passports: Passport[], lastId: string | null): Passport | undefined {
  if (lastId) {
    const exact = passports.find((p) => p.id === lastId && isResumable(p));
    if (exact) return exact;
  }
  return passports.find(isResumable);
}

/**
 * Silently re-establish a passport session when possible (web, unlocked wallet).
 * Returns whether a session is now active. Used by the shell guard so internal
 * navigations never flash the login screen for an unlocked-wallet user. Does NOT
 * prompt — a locked wallet returns false (the front door shows the unlock hero).
 */
export async function trySilentResume(): Promise<boolean> {
  const platform = await getPlatform();
  if (platform.kind !== "web") return false;
  if (getActivePassportSession()) return true; // already active in this tab
  if (!hasWallet()) return false;
  if (getView().status !== "unlocked") return false; // locked → needs one-tap unlock
  const target = pickResumable(getPassports(), readLastActivePassportId());
  if (!target) return false;
  try {
    await enterPassport(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide the front-door state on load:
 *   - `'in'`      — a live OIDC session, a native durable session, an active
 *                   passport, OR an unlocked-wallet passport we just resumed.
 *   - `'unlock'`  — a wallet exists but is locked (hard reload): one master-
 *                   password entry resumes the last-active identity, no redirect.
 *   - `'connect'` — no resumable identity; show the full connect surface.
 */
export async function resolveEntry(): Promise<EntryState> {
  const platform = await getPlatform();
  try {
    const info = await platform.auth.ensureSession();
    if (info.isLoggedIn) return "in";
  } catch {
    /* fall through to the wallet path */
  }
  if (platform.kind !== "web") return "connect";
  if (!hasWallet()) return "connect";
  if (getView().status === "unlocked") {
    return (await trySilentResume()) ? "in" : "connect";
  }
  // Wallet present but locked — a hard reload dropped the in-memory session.
  return "unlock";
}
