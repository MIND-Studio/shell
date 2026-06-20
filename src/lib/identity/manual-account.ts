/**
 * Manual provider-account capture (PRD-PROVIDER-ACCOUNTS P3 — manual/non-CSS).
 *
 * Some providers can't be provisioned headlessly: Inrupt PodSpaces, a hosted CSS
 * that requires you to register and confirm an email yourself (e.g.
 * `https://pods.mindpods.org` — it exposes only `password.register`/`forgot`, no
 * DID-login extension). The shell can't mint these for you, but once YOU have an
 * account there, P3 lets you **capture** that login — type the email + password
 * you set — and the shell seals it as the SAME `password`-kind record every other
 * provider account is (PRD-PROVIDER-ACCOUNTS §5.2). It then projects into the
 * Vault's "Provider accounts" panel: viewable, copyable, reusable.
 *
 * A captured login holds NO client-credentials key card (we never saw the account
 * being created), so it is **never silently resumed** (resume.ts gates on
 * client-credentials) — it's a stored convenience credential only, exactly the
 * trust gradient §4 describes ("a stored password and no key card").
 *
 * Pure functions only — no React, no crypto, no DOM, no network (the provider is
 * the real validator; we only shape + sanity-check input). Type-only `Passport`
 * import, so it stays unit-testable under `tsx` (`scripts/test-manual-account.ts`).
 */

import { isValidEmail } from "./email";
import type { Passport, PassportCreds } from "./types";

/** What the user types when capturing an existing provider login. */
export interface ManualAccountDraft {
  /** Friendly name for the login ("Inrupt PodSpaces"). */
  label: string;
  /** The provider's web address — coerced to an origin by {@link normalizeServer}. */
  server: string;
  /** The email you sign in with at the provider. */
  email: string;
  /** The password you set at the provider — the viewable secret we seal. */
  password: string;
  /** Optional: the WebID this account signs in as, if you know it. */
  webId?: string;
  /**
   * Whether the provider has already confirmed this email. Captured accounts are
   * existing, working logins, so this defaults to `true`. Pass `false` if you
   * just registered and haven't clicked the confirmation link yet — the record is
   * sealed PENDING (PRD-PROVIDER-ACCOUNTS §6) until you mark it verified.
   */
  verified?: boolean;
}

/** Field-keyed validation errors (empty object ⇒ the draft is valid). */
export interface ManualAccountErrors {
  label?: string;
  server?: string;
  email?: string;
  password?: string;
  webId?: string;
}

/**
 * Coerce a typed provider address to a clean origin (no path, no trailing slash)
 * — matching how `createWorkspace` stores `server` (context.tsx). Adds `https://`
 * when the scheme is omitted, rejects non-http(s) and host-less inputs, and
 * requires a dotted host (or `localhost`) so an obvious typo doesn't slip through.
 * Returns null when the input can't be a provider origin.
 */
export function normalizeServer(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.hostname !== "localhost" && !u.hostname.includes(".")) return null;
  return u.origin;
}

/** A permissive WebID sanity check — an http(s) URL (the provider is authoritative). */
function isLikelyWebId(webId: string): boolean {
  try {
    const u = new URL(webId.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a capture draft, returning a field-keyed error map (empty ⇒ valid).
 * Deliberately lenient — it keeps obviously-broken input out of the Vault, but
 * the provider remains the real authority on whether the login works.
 */
export function validateManualAccount(draft: ManualAccountDraft): ManualAccountErrors {
  const errors: ManualAccountErrors = {};
  if (!draft.label.trim()) errors.label = "Give this login a name.";
  if (!normalizeServer(draft.server)) errors.server = "Enter the provider's web address.";
  if (!isValidEmail(draft.email)) errors.email = "Enter the email you sign in with.";
  if (!draft.password) errors.password = "Enter the password.";
  if (draft.webId && draft.webId.trim() && !isLikelyWebId(draft.webId))
    errors.webId = "That doesn't look like a WebID URL.";
  return errors;
}

/** True iff {@link validateManualAccount} found no problems. */
export function isManualAccountValid(draft: ManualAccountDraft): boolean {
  return Object.keys(validateManualAccount(draft)).length === 0;
}

/**
 * Build the sealed {@link Passport} for a captured login. The caller supplies the
 * impure bits (a fresh id, the unlocked master `did`, a timestamp); this stays
 * pure. The result carries a `password`-kind `creds` (so it projects as a viewable
 * provider account), `manual: true` (provenance), and NO client-credentials (so
 * it's never silently resumed). `verified:false` seals it PENDING (§6).
 *
 * Precondition: the draft passed {@link isManualAccountValid} — `normalizeServer`
 * is asserted non-null here.
 */
export function buildManualPassport(
  draft: ManualAccountDraft,
  ctx: { id: string; did: string; createdAt: string },
): Passport {
  const server = normalizeServer(draft.server);
  if (!server) throw new Error("Invalid provider address.");
  const email = draft.email.trim();
  const creds: PassportCreds = {
    kind: "password",
    email,
    password: draft.password,
    // Existing accounts are already confirmed; only an explicit `false` ⇒ pending.
    emailVerified: draft.verified === false ? false : true,
  };
  return {
    id: ctx.id,
    did: ctx.did,
    server,
    webId: draft.webId?.trim() || "",
    podRoots: [],
    label: draft.label.trim(),
    email,
    createdAt: ctx.createdAt,
    manual: true,
    creds,
  };
}
