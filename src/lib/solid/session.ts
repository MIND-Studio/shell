"use client";

import { getDefaultSession } from "@inrupt/solid-client-authn-browser";

/**
 * The browser SDK keeps a process-wide default session. We re-export it as a
 * single helper so call sites never accidentally instantiate a second one
 * and end up unauthenticated.
 */
export function session() {
  return getDefaultSession();
}

const ISSUER_KEY = "mind-shell:oidc-issuer";

export const DEFAULT_ISSUER =
  process.env.NEXT_PUBLIC_SOLID_ISSUER ??
  process.env.NEXT_PUBLIC_POD_BASE_URL ??
  "https://pods.mindpods.org/";

export function storedIssuer(): string {
  if (typeof window === "undefined") return DEFAULT_ISSUER;
  return localStorage.getItem(ISSUER_KEY) ?? DEFAULT_ISSUER;
}

export function rememberIssuer(issuer: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ISSUER_KEY, issuer);
}
