/**
 * Email helpers for provider accounts (PRD-PROVIDER-ACCOUNTS P2 — email branch).
 *
 * Some pod providers require a **verified, deliverable** email before an account
 * can be used (Inrupt PodSpaces, a hosted CSS with confirmation). The shell's
 * default `autoEmail()` mints a NON-deliverable placeholder (`…@workspace.mind.local`)
 * — fine for a stock localhost CSS that never sends mail, useless where the
 * provider verifies. This module is the pure logic the create flow + the Vault
 * viewer share to: tell a real address from a placeholder, suggest a plus-alias
 * so one inbox covers many accounts, and report an account's verification state.
 *
 * Pure functions only: no React, no crypto, no DOM, no network — so it stays
 * unit-testable under `tsx` (`scripts/test-email.ts`) and carries no runtime
 * weight. The verification *state* is non-secret metadata; the email itself is
 * already a viewable provider-account field (PRD-PROVIDER-ACCOUNTS §5.1).
 */

/**
 * Domains the shell uses for auto-generated, NON-deliverable account emails
 * (`autoEmail()` in provision.ts → `…@passport.mind.local`; createWorkspace →
 * `…@workspace.mind.local`). Anything under `.mind.local` is a placeholder that
 * can't receive mail, so there is nothing to verify.
 */
const PLACEHOLDER_EMAIL_TLD = ".mind.local";

/** The verification lifecycle of a provider account's email. */
export type VerificationState =
  /** A real address the provider confirmed (or that needs no confirming). */
  | "verified"
  /** A real address awaiting confirmation — silent resume is disabled (§6). */
  | "pending"
  /** A non-deliverable placeholder (or no email) — nothing to verify. */
  | "not-required";

/** Just the fields of a credential this module reasons about. */
export interface EmailCreds {
  email?: string;
  /** `false` ⇒ PENDING; `true`/absent ⇒ verified (see {@link verificationState}). */
  emailVerified?: boolean;
}

/** Split an email into `[local, domain]`, or null if it isn't shaped like one. */
function split(email: string): [string, string] | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return [email.slice(0, at), email.slice(at + 1)];
}

/**
 * A non-deliverable placeholder the shell auto-generated (under `.mind.local`),
 * NOT a real inbox. These never need verification (no provider will mail them).
 */
export function isAutoEmail(email: string): boolean {
  const parts = split(email);
  if (!parts) return false;
  const domain = parts[1].toLowerCase().replace(/\.$/, "");
  return domain === "mind.local" || domain.endsWith(PLACEHOLDER_EMAIL_TLD);
}

/**
 * A permissive, deliberately-not-RFC email shape check (one `@`, a dotted
 * domain, no whitespace). Good enough to keep an obviously-broken address out
 * of the provider flow; the provider itself is the real validator.
 */
export function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (/\s/.test(e)) return false;
  const parts = split(e);
  if (!parts) return false;
  const [local, domain] = parts;
  if (!local) return false;
  // Domain must have a dot with non-empty labels on both sides.
  return /^[^.\s@][^\s@]*\.[^.\s@]+$/.test(domain);
}

/** A short, address-safe tag from a human label ("Work Drive" → "work-drive"). */
export function aliasSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Suggest a plus-aliased address so ONE inbox covers many provider accounts
 * (`you@gmail.com` + "Work Drive" → `you+work-drive@gmail.com`). Idempotent on an
 * already-aliased base: an existing `+tag` is dropped before the new one is
 * applied (`you+old@x` + "New" → `you+new@x`). Returns the base unchanged when it
 * isn't a usable email or the label slugs to nothing — never throws.
 *
 * Plus-alias acceptance varies by provider (PRD §10 open question): this is
 * *guidance*, surfaced as an editable suggestion, not enforced.
 */
export function suggestPlusAlias(baseEmail: string, label: string): string {
  const parts = split(baseEmail.trim());
  if (!parts) return baseEmail.trim();
  const [localFull, domain] = parts;
  const local = localFull.split("+")[0]; // drop any existing +tag
  const slug = aliasSlug(label);
  return slug ? `${local}+${slug}@${domain}` : `${local}@${domain}`;
}

/**
 * The verification state of an account's email (PRD-PROVIDER-ACCOUNTS §6):
 *   - no email or a non-deliverable placeholder → `"not-required"`
 *   - a real address explicitly flagged `emailVerified:false` → `"pending"`
 *   - any other real address → `"verified"` (legacy records had nothing to
 *     verify; only the bring-your-own-email branch sets the pending flag).
 */
export function verificationState(creds?: EmailCreds): VerificationState {
  const email = creds?.email?.trim();
  if (!email || isAutoEmail(email)) return "not-required";
  return creds?.emailVerified === false ? "pending" : "verified";
}

/** True iff the account is awaiting email confirmation (silent resume blocked). */
export function isVerificationPending(creds?: EmailCreds): boolean {
  return verificationState(creds) === "pending";
}
