"use client";

import type { PlatformKind } from "./types";

/**
 * Runtime detection of the delivery target (PRD-NATIVE.md §4).
 *
 * Tauri injects `window.__TAURI__` (and `window.__TAURI_INTERNALS__` in v2) into
 * the webview before any app code runs. That presence — not the user agent — is
 * the single source of truth for whether we're inside the native shell. We never
 * sniff UA strings (a desktop Tauri webview looks like a normal browser).
 *
 * During SSR / static build there is no `window`, so we report `web`; the native
 * branch only ever matters at runtime inside the Tauri webview, and every impl
 * that touches a Tauri API is `"use client"` and guarded behind this check.
 */

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.__TAURI_INTERNALS__ !== "undefined" ||
    typeof window.__TAURI__ !== "undefined"
  );
}

export function platformKind(): PlatformKind {
  return isNative() ? "native" : "web";
}
