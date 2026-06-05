"use client";

/**
 * Platform abstraction contract (PRD-NATIVE.md §4).
 *
 * The shell and Vault UI are delivered two ways: the web shell (browser,
 * `output: 'standalone'` Docker) and the native shell (Tauri desktop/mobile,
 * `output: 'export'` static bundle). The *only* thing that differs between them
 * is how four capabilities are satisfied — OIDC auth, crypto, biometric unlock,
 * autofill, and local storage. Everything above this line stays platform-agnostic
 * and consumes these interfaces; nothing in `src/components/` or `src/apps/`
 * should reach for `window.__TAURI__`, `@tauri-apps/api`, or browser-only globals
 * directly.
 *
 * The `web` impl preserves today's exact behavior (browser
 * `handleIncomingRedirect` single-flight, wasm crypto, localStorage). The
 * `native` impl forwards to Tauri commands so plaintext/keys stay in the Rust
 * process (PRD-NATIVE.md §2 — "the hardened crypto path comes for free").
 *
 * ZERO-KNOWLEDGE INVARIANT (AGENTS.md HARD rule #1, #4): the crypto surface here
 * is exactly `CryptoCore` from `../vault/crypto-contract.ts`. It marshals base64,
 * KDF params, and opaque session handles only — raw keys and long-lived
 * plaintext never cross this boundary in either impl.
 */

import type { ISessionInfo } from "@inrupt/solid-client-authn-browser";
import type { CryptoCore } from "../vault/crypto-contract";

/**
 * Async mirror of `CryptoCore`. The wasm core is synchronous, but the native core
 * runs in the Rust process so every call crosses the Tauri command boundary and
 * must be awaited. To keep the Vault UI platform-agnostic, both platforms present
 * crypto through this uniform *async* surface: the web impl wraps the sync wasm
 * core (each method just `await`s a resolved value), the native impl forwards to
 * `invoke`. The zero-knowledge invariant is unchanged — return types are the same
 * base64/handle/display values as `CryptoCore`, never raw keys or stored plaintext.
 */
export type AsyncCryptoCore = {
  [K in keyof CryptoCore]: (
    ...args: Parameters<CryptoCore[K]>
  ) => Promise<ReturnType<CryptoCore[K]>>;
};

/**
 * Which delivery target is running. Detected once at module load via
 * `window.__TAURI__` (see `detect.ts`); never branch on user agent.
 */
export type PlatformKind = "web" | "native";

/**
 * OIDC / Solid auth. On web this is the browser SDK's redirect dance with the
 * single-flight `handleIncomingRedirect` (AGENTS.md HARD rule #3). On native the
 * redirect can't be an in-app webview navigation — it goes out to a system auth
 * session and returns via a custom-scheme deep link (PRD-NATIVE.md §3.1), so the
 * native impl drives a Tauri-side PKCE/DPoP flow and surfaces the same
 * `ISessionInfo` shape back to the UI.
 */
export interface PlatformAuth {
  /**
   * Begin sign-in for the given OIDC issuer. `redirectTo` is the in-app path to
   * land on once the session is established.
   *
   * - web: sets up the return-to and calls the browser SDK `login()` (full-page
   *   redirect; this call does not resolve normally — the page navigates away).
   * - native: opens the system auth session; resolves (or fires
   *   `onAuthCallback`) once the deep-link callback completes.
   */
  login(issuer: string, redirectTo: string): Promise<void>;

  /**
   * Idempotent session check on load. Consumes a pending OIDC redirect exactly
   * once (web: the memoized `handleIncomingRedirect`; native: completes any
   * deep-link callback in flight), then returns current session info. Safe to
   * call from many components per page load — it is single-flight by contract.
   */
  ensureSession(): Promise<ISessionInfo>;

  /**
   * Completes the OIDC redirect on the dedicated callback route. Shares the same
   * single-flight redemption as `ensureSession` so the code is never redeemed
   * twice (AGENTS.md HARD rule #3).
   */
  completeLogin(): Promise<ISessionInfo>;

  /** Current session info without triggering any redirect handling. */
  currentSession(): ISessionInfo;

  /** Tear down the session. */
  logout(): Promise<void>;

  /**
   * Subscribe to out-of-band session changes (native deep-link callbacks arrive
   * asynchronously, not as a resolved promise). Returns an unsubscribe fn. On
   * web this is a no-op subscription (the redirect resolves inline).
   */
  onAuthCallback(handler: (info: ISessionInfo) => void): () => void;
}

/**
 * Crypto. Identical surface on both platforms — `CryptoCore` is the authoritative
 * FFI mirror (`../vault/crypto-contract.ts`). On web it resolves the wasm-backed
 * core (`../vault/core.ts`); on native it resolves a core whose every method
 * forwards to a `#[tauri::command]` wrapper over the *same* Rust crate, so keys
 * live in the Rust process, not the webview (PRD-NATIVE.md §2).
 */
export interface PlatformCrypto {
  /**
   * Resolve the crypto core for this platform (memoized by the impl). Always the
   * async surface so the Vault UI awaits the same way on web (sync wasm wrapped)
   * and native (Tauri commands).
   */
  getCore(): Promise<AsyncCryptoCore>;
}

/**
 * Biometric unlock (PRD-NATIVE.md §3.3). Mobile-first unlock is Face ID / Touch
 * ID / Android BiometricPrompt. The master-password-derived key wraps a device
 * unlock key held in the Secure Enclave / Keystore; biometrics release it to
 * unwrap the vault session. The master password stays the root of trust.
 *
 * Web has no equivalent, so `isAvailable()` returns false and the unlock UI
 * falls back to the master password.
 */
export interface PlatformBiometric {
  /** Whether biometric unlock can be offered on this device right now. */
  isAvailable(): Promise<boolean>;

  /**
   * Whether the user has previously enrolled a device unlock key for `vaultId`.
   * False on web.
   */
  isEnrolled(vaultId: string): Promise<boolean>;

  /**
   * After a successful master-password unlock, wrap a device unlock key for
   * `vaultId` behind biometrics so future unlocks can skip the password.
   * The payload is opaque ciphertext produced by the Rust core — never a raw key
   * (AGENTS.md HARD rule #1). No-op rejection on web.
   */
  enroll(vaultId: string, wrappedDeviceKeyB64: string): Promise<void>;

  /**
   * Prompt for biometrics and, on success, return the wrapped device key blob
   * the core needs to unwrap the vault session. Returns ciphertext only.
   * Rejects on web (no biometric available).
   */
  unlock(vaultId: string): Promise<string>;
}

/**
 * OS autofill bridge (PRD-NATIVE.md §3.2). Native autofill lives in a separate
 * OS extension process (iOS ASCredentialProvider / Android Autofill). This is a
 * later-milestone capability (N5); the interface is declared now so the UI never
 * grows a Tauri branch later, but both impls currently report unsupported.
 */
export interface PlatformAutofill {
  /** Whether OS-level autofill registration is supported on this platform. */
  isSupported(): boolean;

  /**
   * Publish the non-secret credential index (labels, usernames, target domains —
   * NOT passwords) to the OS autofill store so the extension can offer matches.
   * The extension re-unlocks via the core to decrypt on demand (§3.2); no
   * plaintext secret is handed to the OS here. No-op where unsupported.
   */
  syncIndex(entries: AutofillIndexEntry[]): Promise<void>;
}

/** Non-secret descriptor the OS autofill store matches against. No passwords. */
export interface AutofillIndexEntry {
  itemId: string;
  label: string;
  username?: string;
  /** Domains/app-ids this credential should be offered for. */
  targets: string[];
}

/**
 * Key/value storage. On web this is `localStorage` (issuer choice, theme, etc).
 * On native it is a Tauri-backed store, which (for the Vault) becomes the offline
 * encrypted cache of `items/{itemId}.enc` (PRD-NATIVE.md §3.4).
 *
 * HARD rule #2: this stores **ciphertext only** for vault data — never plaintext
 * secrets to disk. Non-secret app state (issuer, layout) is fine.
 */
export interface PlatformStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Authenticated pod I/O (PRD-NATIVE.md §3.1, zero-trust-of-webview).
 *
 * `fetch` is a WHATWG-`fetch`-compatible function that the `@inrupt/solid-client`
 * helpers in `src/lib/solid/pod-fs.ts` are handed as their `{ fetch }` option, so
 * every pod read/write is authenticated for the current session:
 *   - web: the browser Solid SDK's `session().fetch` (cookie/DPoP handled by the
 *     SDK in the webview) — unchanged behavior.
 *   - native: a shim over the Rust `pod_fetch` Tauri command. The access token +
 *     DPoP private key live ONLY in the Rust process and sign each request there;
 *     they never cross into JS (HARD rule #1). The shim only marshals the request
 *     and reconstructs the `Response`.
 *
 * Keeping pod I/O behind this single capability is what makes "pod is the only
 * store" work identically on both targets without leaking tokens to the webview.
 */
export interface PlatformPod {
  readonly fetch: typeof fetch;
}

/** The full platform surface the app consumes via `getPlatform()`. */
export interface Platform {
  readonly kind: PlatformKind;
  readonly auth: PlatformAuth;
  readonly crypto: PlatformCrypto;
  readonly biometric: PlatformBiometric;
  readonly autofill: PlatformAutofill;
  readonly storage: PlatformStorage;
  readonly pod: PlatformPod;
}
