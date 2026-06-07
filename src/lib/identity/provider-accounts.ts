/**
 * Provider accounts — the viewable projection (PRD-PROVIDER-ACCOUNTS P0/§5.2).
 *
 * The shell already SEALS the account logins it generates for secondary pod
 * providers (hybrid workspaces) into the wallet registry as `password`-kind
 * passport `creds` (PRD-DID §5.7). They were invisible. This module PROJECTS
 * those sealed records into a read-only, human-viewable shape so the Vault can
 * surface them — without copying the secret into a second store. One source of
 * truth (the wallet registry); two surfaces (silent sign-in vs. human view).
 *
 * THE SECURITY-CRITICAL PROPERTY (PRD-PROVIDER-ACCOUNTS §3 — the trust gradient):
 * the **main identity is never projected**. A primary passport's `creds.kind` is
 * `client-credentials` (a revocable machine key card — never a typeable password),
 * and `createPassportAccount` DROPS its generated account password. This filter
 * gates on `kind === "password"`, so a client-credentials passport can never
 * appear here even if it somehow carried email/password fields. Tested explicitly
 * in `scripts/test-provider-accounts.ts`.
 *
 * Pure types + functions: no React, no crypto, no DOM, type-only `Passport`
 * import — so it stays unit-testable under `tsx` and carries no runtime weight.
 */

import type { Passport } from "./types";
import { verificationState, type VerificationState } from "./email";

/** A viewable provider login, projected from a sealed `password`-kind passport. */
export interface ProviderAccount {
  /** The originating passport's local id — the link back to the wallet record. */
  id: string;
  /** Friendly name ("Work"), falling back to the server host. */
  label: string;
  /** Provider origin, e.g. "https://pod.mindpods.org". */
  server: string;
  /** The WebID this login signs in as (the master WebID for hybrid workspaces). */
  webId: string;
  /** The account email — viewable (recovery channel / provider sign-in). */
  email: string;
  /** The account password — viewable, reusable, copyable. */
  password: string;
  /** True if the master DID is bound to this server's account (DID-aware CSS). */
  didLinked: boolean;
  /** True when this record is a hybrid workspace (vs. a future standalone). */
  workspace: boolean;
  /** True when this login was captured manually (PRD-PROVIDER-ACCOUNTS P3). */
  manual: boolean;
  /** Email-verification lifecycle (PRD-PROVIDER-ACCOUNTS §6). */
  verification: VerificationState;
  /** True iff awaiting confirmation — surfaced as a badge, blocks silent resume. */
  pending: boolean;
}

/** A friendly label from a server URL's host, trailing-slash/scheme-free. */
export function hostLabel(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/**
 * True when a passport carries a viewable provider login. Gates on a stored
 * `password`-kind credential WITH both email and password present. By
 * construction this EXCLUDES the main identity (which is `client-credentials`).
 */
export function hasViewableLogin(p: Passport): boolean {
  const c = p.creds;
  return c?.kind === "password" && !!c.email && !!c.password;
}

/**
 * Project the sealed `password`-kind passports into viewable provider accounts.
 * Caller passes the DECRYPTED passport list (wallet must be unlocked). The main
 * identity and any credential-less / client-credentials passports are filtered
 * out (see module + {@link hasViewableLogin}).
 */
export function projectProviderAccounts(passports: Passport[]): ProviderAccount[] {
  return passports.filter(hasViewableLogin).map((p) => {
    const state = verificationState(p.creds);
    return {
      id: p.id,
      label: p.label?.trim() || hostLabel(p.server),
      server: p.server,
      webId: p.webId,
      // Non-null: hasViewableLogin guarantees both are present.
      email: p.creds!.email!,
      password: p.creds!.password!,
      didLinked: p.didLinked === true,
      workspace: p.workspace === true,
      manual: p.manual === true,
      verification: state,
      pending: state === "pending",
    };
  });
}
