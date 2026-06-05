"use client";

/**
 * Web platform implementation (PRD-NATIVE.md §4) — the current behavior, factored
 * behind the `Platform` interface so the native shell can swap it.
 *
 * Nothing here is new logic: auth delegates to the existing single-flight
 * `src/lib/solid/auth.ts` (AGENTS.md HARD rule #3 — `handleIncomingRedirect` is
 * memoized there and must keep exactly one call site per page load), crypto
 * delegates to the wasm core (`src/lib/vault/core.ts`), and storage is
 * `localStorage`. Biometric and autofill have no web equivalent and report
 * unsupported so the UI falls back to the master password / hides OS autofill.
 */

import {
  login as browserLogin,
  type ISessionInfo,
} from "@inrupt/solid-client-authn-browser";
import {
  ensureSession as solidEnsureSession,
  completeLoginRedirect,
  rememberReturnToDefault,
} from "../solid/auth";
import { session, rememberIssuer } from "../solid/session";
import {
  getActivePassportSession,
  clearActivePassportSession,
} from "../solid/passport-session";
import { getCryptoCore } from "../vault/core";
import type {
  Platform,
  PlatformAuth,
  PlatformAutofill,
  PlatformBiometric,
  PlatformCrypto,
  PlatformStorage,
  PlatformPod,
  AutofillIndexEntry,
  AsyncCryptoCore,
} from "./types";

const auth: PlatformAuth = {
  async login(issuer: string, redirectTo: string): Promise<void> {
    rememberIssuer(issuer);
    rememberReturnToDefault(redirectTo);
    // Full-page redirect to the IdP — this navigates away and does not resolve
    // normally. Mirrors `browserOidcLogin` from @mind-studio/core exactly
    // (callbackPath "/login/callback" off window.location.origin, same
    // clientName) so the shared-login behavior is unchanged.
    await browserLogin({
      oidcIssuer: issuer,
      redirectUrl: new URL("/login/callback", window.location.origin).toString(),
      clientName: "Mind Shell",
    });
  },

  // Single-flight by contract — these forward to the memoized helpers in
  // solid/auth.ts; they do not add a second `handleIncomingRedirect` call site.
  // When a passport session is active (C4), we report ITS WebID without touching
  // the OIDC redirect, so the shell re-resolves identity + pod as the passport.
  ensureSession(): Promise<ISessionInfo> {
    const ps = getActivePassportSession();
    if (ps) return Promise.resolve(passportSessionInfo(ps.passportId, ps.webId));
    return solidEnsureSession();
  },

  completeLogin(): Promise<ISessionInfo> {
    return completeLoginRedirect();
  },

  currentSession(): ISessionInfo {
    const ps = getActivePassportSession();
    if (ps) return passportSessionInfo(ps.passportId, ps.webId);
    return session().info;
  },

  async logout(): Promise<void> {
    // Drop any passport overlay first, then tear down the underlying OIDC session.
    clearActivePassportSession();
    await session().logout();
  },

  onAuthCallback(): () => void {
    // Web resolves the redirect inline via ensureSession/completeLogin; there is
    // no out-of-band callback to subscribe to.
    return () => {};
  },
};

const crypto: PlatformCrypto = {
  // Wrap the synchronous wasm core in the uniform async surface so the Vault UI
  // awaits identically on web and native. No behavior change — each method just
  // resolves the sync result.
  async getCore(): Promise<AsyncCryptoCore> {
    const core = await getCryptoCore();
    return {
      calibrateKdf: async (...a) => core.calibrateKdf(...a),
      createVault: async (...a) => core.createVault(...a),
      unlock: async (...a) => core.unlock(...a),
      lock: async (...a) => core.lock(...a),
      encryptItem: async (...a) => core.encryptItem(...a),
      decryptItem: async (...a) => core.decryptItem(...a),
      changePassword: async (...a) => core.changePassword(...a),
      generatePassword: async (...a) => core.generatePassword(...a),
      generatePassphrase: async (...a) => core.generatePassphrase(...a),
      totpAt: async (...a) => core.totpAt(...a),
      hibpPrefix: async (...a) => core.hibpPrefix(...a),
      identityCreate: async (...a) => core.identityCreate(...a),
      identityUnlock: async (...a) => core.identityUnlock(...a),
      identityFromSeed: async (...a) => core.identityFromSeed(...a),
      masterDid: async (...a) => core.masterDid(...a),
      signDetached: async (...a) => core.signDetached(...a),
      verifyBinding: async (...a) => core.verifyBinding(...a),
      identityLock: async (...a) => core.identityLock(...a),
    };
  },
};

const biometric: PlatformBiometric = {
  async isAvailable(): Promise<boolean> {
    return false;
  },
  async isEnrolled(): Promise<boolean> {
    return false;
  },
  async enroll(): Promise<void> {
    throw new Error("Biometric unlock is not available on web");
  },
  async unlock(): Promise<string> {
    throw new Error("Biometric unlock is not available on web");
  },
};

const autofill: PlatformAutofill = {
  isSupported(): boolean {
    return false;
  },
  async syncIndex(_entries: AutofillIndexEntry[]): Promise<void> {
    // No OS autofill store on web.
  },
};

const storage: PlatformStorage = {
  async get(key: string): Promise<string | null> {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  async remove(key: string): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

const pod: PlatformPod = {
  // Pod I/O on web is the browser Solid SDK's authenticated fetch — unchanged
  // behavior. Resolve session().fetch at call time (not module load) so it
  // always reflects the current session, matching pod-fs.ts's prior pattern.
  // pod-fs.ts still applies its own wrappers (e.g. cache:'no-store').
  //
  // C4: when a passport session is active, route pod I/O through ITS authed
  // fetch instead — so every read/write transparently acts as the passport.
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
    const ps = getActivePassportSession();
    const f = ps ? ps.fetch : (session().fetch as typeof fetch);
    return f(input, init);
  }) as typeof fetch,
};

/**
 * Synthesize an `ISessionInfo` for an active passport. It's a real, usable
 * session (a DPoP-bound client-credentials fetch backs it) — just not the
 * browser SDK's single OIDC session — so we report `isLoggedIn: true` with the
 * passport's WebID and a stable synthetic id.
 */
function passportSessionInfo(passportId: string, webId: string): ISessionInfo {
  return { isLoggedIn: true, webId, sessionId: `passport:${passportId}` };
}

export const webPlatform: Platform = {
  kind: "web",
  auth,
  crypto,
  biometric,
  autofill,
  storage,
  pod,
};
