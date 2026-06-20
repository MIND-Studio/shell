/**
 * Provider-entry policy (PRD-PROVIDER-ACCOUNTS P1 + P4).
 *
 * Two pure decisions the shell makes about a provider account's *login*:
 *
 *   P1 — will provisioning STORE a viewable login at all? The shell seals a
 *   workspace's account login into the wallet registry (the only zero-knowledge
 *   store), so it can only do so when a master wallet is UNLOCKED. With none, the
 *   pod is still created but its login can't be saved — the create UI must say so
 *   honestly instead of promising a Vault entry it won't write.
 *
 *   P4 — HOW will the user get into the provider's own app? When the brokered
 *   bridge lands (PRD-APPS §5.1), a hosted first-party app receives the identity
 *   over the capability bridge — signed in with NO typed credential. That brokered
 *   handoff is PREFERRED; the stored login (P0–P3) becomes the typed FALLBACK.
 *   Both coexist: even with a broker, the saved login stays viewable as an escape
 *   hatch. Until the bridge exists the broker signal is false everywhere, so this
 *   resolves to the stored-login path — today's behavior — with no policy churn
 *   when the brokered arm flips on.
 *
 * Pure functions only — no React, no crypto, no DOM, no network. Type-only
 * imports, so it stays unit-testable under `tsx` (`scripts/test-provider-entry.ts`).
 */

import type { ProviderAccount } from "./provider-accounts";
import type { WalletStatus } from "./types";

/** How the user will sign in to a provider's own app surface. */
export type EntryMode =
  /** Hosted in-shell; identity handed off over the bridge — no typed credential. */
  | "brokered"
  /** Open the provider and sign in with the stored login (the typed path). */
  | "stored-login"
  /** No stored login and no broker — nothing to offer yet. */
  | "none";

/** The resolved plan for entering a provider (P4). */
export interface ProviderEntryPlan {
  mode: EntryMode;
  /**
   * The stored login involved: the credential to type in `stored-login` mode, or
   * the fallback login surfaced alongside a `brokered` handoff. Absent in `none`.
   */
  account?: ProviderAccount;
  /** True iff a brokered handoff is preferred AND a stored login also exists. */
  fallbackAvailable: boolean;
  /** A short, human hint the UI can show for this entry path. */
  reason: string;
}

/** The host of a URL, lowercased — tolerant of a bare host or trailing path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[/?#].*$/, "");
  }
}

/** Find the stored login for a provider, matched by host (scheme/path-agnostic). */
export function matchAccountForServer(
  accounts: ProviderAccount[],
  server: string,
): ProviderAccount | undefined {
  const h = hostOf(server);
  if (!h) return undefined;
  return accounts.find((a) => hostOf(a.server) === h);
}

/**
 * Plan how to enter a provider's own app (P4): brokered handoff when available
 * (preferred), else the stored login typed by the user, else nothing. The stored
 * login is always carried when one exists, so a brokered path can still offer it
 * as a fallback ("both coexist").
 */
export function planProviderEntry(opts: {
  /** The provider origin we want to enter. */
  server: string;
  /** The viewable provider accounts (from the P0 projection). */
  accounts: ProviderAccount[];
  /** Whether a brokered in-shell handoff is available for this provider. */
  brokered: boolean;
}): ProviderEntryPlan {
  const account = matchAccountForServer(opts.accounts, opts.server);
  if (opts.brokered) {
    return {
      mode: "brokered",
      account,
      fallbackAvailable: !!account,
      reason: account
        ? "Opens signed-in inside the shell. Your saved login is the fallback."
        : "Opens signed-in inside the shell — no login needed.",
    };
  }
  if (account) {
    return {
      mode: "stored-login",
      account,
      fallbackAvailable: false,
      reason: "Open the provider and sign in with your saved login.",
    };
  }
  return {
    mode: "none",
    fallbackAvailable: false,
    reason: "No saved login for this provider yet.",
  };
}

/**
 * Whether provisioning will actually SEAL a viewable login (P1). The login is
 * sealed into the wallet registry — the sole zero-knowledge store — so it needs
 * an UNLOCKED master wallet. Locked or absent ⇒ the pod is still created, but its
 * login can't be saved; the create UI must say so rather than over-promise.
 */
export function willSealWorkspaceLogin(walletStatus: WalletStatus): boolean {
  return walletStatus === "unlocked";
}
