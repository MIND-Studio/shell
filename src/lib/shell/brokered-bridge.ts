"use client";

/**
 * Brokered identity-handoff availability (PRD-APPS §3 + PRD-PROVIDER-ACCOUNTS P4).
 *
 * The shell hosts first-party apps in a sandboxed iframe and hands them the
 * user's identity over the capability bridge (`IframeHost.tsx` + `bridge.ts` +
 * `bridge-protocol.ts`): the user is signed in WITHOUT typing a credential, and
 * NO pod credential crosses the boundary — the shell brokers every pod request
 * with its own authed fetch. When a provider ALSO ships such an in-shell app the
 * brokered handoff is the PREFERRED entry path for its account, and the stored
 * provider login (PRD-PROVIDER-ACCOUNTS P0–P3) is the typed FALLBACK. Both coexist.
 *
 * Availability is read from the LIVE shell catalog (`useShell().apps`: the
 * built-ins incl. Drive, plus pod-owned `apps.ttl` entries via `readCatalog`).
 * The brokered handoff is available for `server` when that catalog holds an
 * enabled `embed:"iframe"`, `trust:"first-party"` app whose `mind:url` host
 * matches the provider host. A generic CSS pod with no in-shell app resolves to
 * the stored-login path (no regression) — the signal is honest, not hard-coded.
 */
import type { HostedApp } from "./types";

export function brokeredHandoffAvailable(
  server: string | undefined,
  apps: HostedApp[]
): boolean {
  const target = hostOf(server);
  if (!target) return false;
  return apps.some(
    (a) =>
      a.enabled &&
      a.embed === "iframe" &&
      a.trust === "first-party" &&
      hostOf(a.url) === target
  );
}

/** Lowercased host of a URL, scheme-tolerant. `null` when unparseable. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    try {
      return new URL(`https://${url}`).host.toLowerCase();
    } catch {
      return null;
    }
  }
}
