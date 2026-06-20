"use client";

/**
 * Probe whether a pod provider requires a **verified email** to use an account
 * (PRD-PROVIDER-ACCOUNTS §6), mirroring `serverSupportsDid()` in did-account.ts.
 *
 * Why best-effort: a stock CSS account index does NOT advertise its email-
 * confirmation policy in a standard control — verification is a server config the
 * unauthenticated `.account/` index doesn't expose. So this probe is honestly
 * conservative: it reports `true` only when the server *does* surface a
 * verification/confirmation control (a DID-fork or a future provider that opts to
 * advertise it), and `false` (the stock-CSS default) otherwise. It never throws —
 * an unreachable or silent server resolves `false`.
 *
 * The probe is a HINT, not a gate. The create form always lets the user choose to
 * bring a real email regardless (so a workspace account stays recoverable via a
 * real inbox); the probe just flips that choice on by default where we can tell
 * the provider will verify. Providers we can't automate at all (Inrupt PodSpaces)
 * are handled by manual capture (P3), not this probe.
 */

import { storedIssuer } from "./session";

function serverRoot(server?: string): string {
  const base = server ?? storedIssuer();
  return base.endsWith("/") ? base : base + "/";
}

/** Account-index controls that would hint at an email-verification step. */
interface MaybeVerifyControls {
  password?: { verify?: string; confirm?: string };
  account?: { emailVerification?: string; verifyEmail?: string };
}

/**
 * True iff the server advertises an email-verification/confirmation control.
 * Conservative: stock CSS (no such control) → `false`. Never throws.
 */
export async function serverRequiresEmailVerification(server?: string): Promise<boolean> {
  const accountIndex = `${serverRoot(server)}.account/`;
  try {
    const res = await fetch(accountIndex, { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const idx = (await res.json()) as { controls?: MaybeVerifyControls };
    const c = idx.controls;
    return Boolean(
      c?.password?.verify ||
        c?.password?.confirm ||
        c?.account?.emailVerification ||
        c?.account?.verifyEmail,
    );
  } catch {
    return false;
  }
}
