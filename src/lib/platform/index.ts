"use client";

/**
 * Platform entry point (PRD-NATIVE.md §4).
 *
 * `getPlatform()` is the *only* thing the shell and Vault UI import to reach
 * platform-specific capabilities (auth, crypto, biometric, autofill, storage).
 * It detects the delivery target once via `window.__TAURI__` (`detect.ts`) and
 * returns the matching `Platform` impl. The native impl is dynamically imported
 * so `@tauri-apps/api` never lands in the web/Docker bundle.
 *
 * Usage:
 *   const platform = await getPlatform();
 *   await platform.auth.ensureSession();
 *   const core = await platform.crypto.getCore();
 *
 * Do NOT branch on `window.__TAURI__`, import `@tauri-apps/api`, or call browser
 * SDK auth directly from components — go through this surface so the two targets
 * stay swappable (and the single-flight + zero-knowledge invariants stay in one
 * place).
 */

import { isNative, platformKind } from "./detect";
import type { Platform, PlatformKind } from "./types";
import { webPlatform } from "./web";

export type {
  Platform,
  PlatformKind,
  PlatformAuth,
  PlatformCrypto,
  PlatformBiometric,
  PlatformAutofill,
  PlatformStorage,
  PlatformPod,
  AutofillIndexEntry,
  AsyncCryptoCore,
} from "./types";
export { isNative, platformKind } from "./detect";

let platformPromise: Promise<Platform> | null = null;

export function getPlatform(): Promise<Platform> {
  if (!platformPromise) {
    platformPromise = (async () => {
      if (isNative()) {
        // Lazy import keeps Tauri APIs out of the web bundle entirely.
        const { nativePlatform } = await import("./native");
        return nativePlatform;
      }
      return webPlatform;
    })();
  }
  return platformPromise;
}

/**
 * Synchronous kind check for render-time branching (e.g. show/hide a biometric
 * button or the OS-autofill toggle). For actual capability calls use
 * `getPlatform()`.
 */
export function currentPlatformKind(): PlatformKind {
  return platformKind();
}
