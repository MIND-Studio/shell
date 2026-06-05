"use client";

import { lazy, type ComponentType } from "react";

/**
 * Registry of in-process apps the shell can render in the app body (PRD §3:
 * "first-party in-process surfaces"). Keyed by the app's `/apps/{key}/` slug.
 * Each app is code-split via React.lazy so the shell chrome loads instantly and
 * the (WASM-heavy) Vault bundle only downloads when opened.
 *
 * External apps (sibling subdomains) are NOT here — they're launched by the
 * waffle as links; in-process hosting via iframe+postMessage is deferred (§11).
 */
const VaultApp = lazy(() => import("./vault"));
const IdentityApp = lazy(() => import("./identity"));

export const APP_REGISTRY: Record<string, ComponentType> = {
  vault: VaultApp,
  identity: IdentityApp,
};

export function getAppComponent(key: string): ComponentType | null {
  return APP_REGISTRY[key] ?? null;
}
