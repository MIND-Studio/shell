"use client";

/**
 * Native (Tauri) platform implementation (PRD-NATIVE.md §4).
 *
 * Every capability forwards to a `#[tauri::command]` in `src-tauri/` via
 * `@tauri-apps/api`'s `invoke`. The headline win (PRD-NATIVE.md §2): crypto runs
 * in the Rust process, so plaintext/keys never enter the webview — `invoke`
 * marshals only base64, KDF params, and opaque session handles, exactly like the
 * wasm FFI (AGENTS.md HARD rule #1, #4). Auth uses a system auth session + a
 * custom-scheme deep-link callback rather than an in-app redirect (§3.1).
 *
 * COMMAND-NAME CONTRACT: the snake_case names below are coordinated with rust-dev
 * (owner of `src-tauri/`). They live in this one file so reconciling with the
 * Rust side is a single edit. If a name changes on the Rust side, change it here
 * — not in the UI.
 */

import type { ISessionInfo } from "@inrupt/solid-client-authn-browser";
import type {
  CreatedIdentity,
  HibpPrefix,
  IdentityHandle,
  KdfParams,
  PwGenOptions,
  SealedItem,
  SessionHandle,
  UnlockedIdentity,
  VaultBootstrap,
} from "../vault/crypto-contract";
import type {
  AsyncCryptoCore,
  AutofillIndexEntry,
  Platform,
  PlatformAuth,
  PlatformAutofill,
  PlatformBiometric,
  PlatformCrypto,
  PlatformPod,
  PlatformStorage,
} from "./types";

// Tauri command + event names — the single source of truth for the JS↔Rust wire.
// Keep in sync with src-tauri/src/commands.rs (+ auth.rs). [coordinated w/ rust-dev]
const CMD = {
  // crypto-core wrappers (mirror crypto-contract.ts)
  calibrateKdf: "calibrate_kdf",
  createVault: "create_vault",
  unlock: "unlock",
  lock: "lock",
  encryptItem: "encrypt_item",
  decryptItem: "decrypt_item",
  changePassword: "change_password",
  generatePassword: "generate_password",
  generatePassphrase: "generate_passphrase",
  totpAt: "totp_at",
  hibpPrefix: "hibp_prefix",
  // identity / DID layer (PRD-DID §5.9) — mirror crypto-contract IdentityCore.
  identityCreate: "identity_create",
  identityUnlock: "identity_unlock",
  identityFromSeed: "identity_from_seed",
  masterDid: "master_did",
  signDetached: "sign_detached",
  verifyBinding: "verify_binding",
  identityLock: "identity_lock",
  // auth (native OIDC + deep-link, §3.1) — names confirmed by rust-dev. The Rust
  // side collapses login/ensure/complete/current into start + status: `auth_start`
  // opens the system browser, the deep-link callback resolves the session in the
  // Rust process, and `auth_status` is the single read of current session state.
  authStart: "auth_start",
  authStatus: "auth_status",
  authLogout: "auth_logout",
  // biometric (§3.3) — NOT YET CONFIRMED by rust-dev (no biometric commands in
  // their scaffold message). Names are provisional; reconcile before N4.
  biometricAvailable: "biometric_available",
  biometricEnrolled: "biometric_enrolled",
  biometricEnroll: "biometric_enroll",
  biometricUnlock: "biometric_unlock",
  // autofill index (§3.2) — provisional, later milestone (N5).
  autofillSyncIndex: "autofill_sync_index",
  // ciphertext cache / kv (§3.4) — NOT YET CONFIRMED by rust-dev; provisional.
  storageGet: "storage_get",
  storageSet: "storage_set",
  storageRemove: "storage_remove",
  // authed pod I/O (§3.1) — confirmed landed (src-tauri/src/pod_fetch.rs).
  podFetch: "pod_fetch",
} as const;

/**
 * Rust `auth_status` payload — mapped onto the SDK `ISessionInfo` shape.
 *
 * The Rust `AuthStatus` struct derives `Serialize` without a rename, so it
 * currently serializes snake_case (`signed_in`/`web_id`); if rust-dev later adds
 * `#[serde(rename_all = "camelCase")]` it becomes `signedIn`/`webId`. We accept
 * BOTH so the boundary survives either choice without a coordination round-trip.
 */
interface NativeAuthStatus {
  signed_in?: boolean;
  signedIn?: boolean;
  web_id?: string;
  webId?: string;
}

function toSessionInfo(s: NativeAuthStatus): ISessionInfo {
  const isLoggedIn = s.signedIn ?? s.signed_in ?? false;
  const webId = s.webId ?? s.web_id;
  return { isLoggedIn, webId } as ISessionInfo;
}

// Event emitted by the Rust side (auth.rs::EVENT_AUTH_CALLBACK) when the
// deep-link OIDC callback resolves (§3.1). The UI subscribes via
// `auth.onAuthCallback`.
//
// NAME — team-lead decided "auth-callback" (plain, no scheme prefix); the
// mindshell:// deep-link SCHEME is separate. The landed auth.rs still emits the
// old placeholder "mind://auth-callback"; rust-dev is converging to this name.
// This const is the single point to flip if the final name differs.
const EVENT_AUTH_CALLBACK = "auth-callback";

/**
 * Payload of the auth-callback event. We tolerate BOTH agreed shapes so the
 * boundary survives the in-flight convergence:
 *   - decided minimal form `{ ok }` (no secrets on the event bus, HARD #1/#5) —
 *     handler then reads the session via `auth_status`; OR
 *   - the landed richer form `{ isLoggedIn, webId }` (+ `error` on failure) —
 *     handler uses it directly and skips the extra round-trip.
 */
interface AuthCallbackPayload {
  ok?: boolean;
  isLoggedIn?: boolean;
  webId?: string;
}

/**
 * Thin `invoke` wrapper. `@tauri-apps/api` is imported dynamically so this module
 * never pulls Tauri internals into the web bundle — `getPlatform()` only reaches
 * here when `isNative()` is true.
 */
async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const auth: PlatformAuth = {
  async login(issuer: string, _redirectTo: string): Promise<void> {
    // Opens the system browser/auth session; the session is established when the
    // deep-link callback fires (Rust side -> EVENT_AUTH_CALLBACK, see
    // onAuthCallback). Does not resolve with a logged-in session itself.
    // `redirectTo` (post-login in-app path) is handled web-side; on native the
    // callback returns to the app and the UI navigates after onAuthCallback.
    await invokeCmd<void>(CMD.authStart, { issuer });
  },

  // Single-flight is enforced on the Rust side (one OIDC redemption per launch,
  // AGENTS.md HARD rule #3). ensureSession/completeLogin/currentSession all read
  // the same Rust-held session via `auth_status`.
  async ensureSession(): Promise<ISessionInfo> {
    return toSessionInfo(await invokeCmd<NativeAuthStatus>(CMD.authStatus));
  },

  async completeLogin(): Promise<ISessionInfo> {
    return toSessionInfo(await invokeCmd<NativeAuthStatus>(CMD.authStatus));
  },

  currentSession(): ISessionInfo {
    // The native session lives in the Rust process and can't be read
    // synchronously. Callers needing fresh native state use ensureSession() or
    // onAuthCallback(); this conservative default keeps the sync contract honest.
    return { isLoggedIn: false } as ISessionInfo;
  },

  async logout(): Promise<void> {
    await invokeCmd<void>(CMD.authLogout);
  },

  onAuthCallback(handler: (info: ISessionInfo) => void): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<AuthCallbackPayload>(EVENT_AUTH_CALLBACK, (e) => {
        if (cancelled) return;
        const p = e.payload ?? {};
        // Richer form `{ isLoggedIn, webId }` — use it directly, no round-trip.
        if (typeof p.isLoggedIn === "boolean") {
          handler({ isLoggedIn: p.isLoggedIn, webId: p.webId } as ISessionInfo);
          return;
        }
        // Failure signal in the minimal form.
        if (p.ok === false) {
          handler({ isLoggedIn: false } as ISessionInfo);
          return;
        }
        // Minimal success `{ ok: true }` — read the session via auth_status so no
        // secrets ride the event bus.
        invokeCmd<NativeAuthStatus>(CMD.authStatus)
          .then((s) => {
            if (!cancelled) handler(toSessionInfo(s));
          })
          .catch(() => {
            if (!cancelled) handler({ isLoggedIn: false } as ISessionInfo);
          });
      });
      if (cancelled) stop();
      else unlisten = stop;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

/**
 * Native crypto core: the `AsyncCryptoCore` surface, every method an `invoke`
 * over the same Rust crate the wasm path compiles (PRD-NATIVE.md §2). The core
 * holds keys behind the opaque session handle; only base64, KDF params, handles,
 * and short-lived display values cross the boundary (AGENTS.md HARD rule #1, #4)
 * — identical to the wasm FFI, just async because it's a process hop.
 */
const nativeCore: AsyncCryptoCore = {
  calibrateKdf: (targetMs: number) => invokeCmd<KdfParams>(CMD.calibrateKdf, { targetMs }),
  createVault: (masterPassword: string, params: KdfParams) =>
    invokeCmd<VaultBootstrap>(CMD.createVault, { masterPassword, params }),
  unlock: (masterPassword: string, saltB64: string, params: KdfParams, wrappedDataKeyB64: string) =>
    invokeCmd<SessionHandle>(CMD.unlock, {
      masterPassword,
      saltB64,
      params,
      wrappedDataKeyB64,
    }),
  lock: (handle: SessionHandle) => invokeCmd<void>(CMD.lock, { handle }),
  encryptItem: (handle: SessionHandle, itemId: string, version: number, plaintextJson: string) =>
    invokeCmd<SealedItem>(CMD.encryptItem, {
      handle,
      itemId,
      version,
      plaintextJson,
    }),
  decryptItem: (handle: SessionHandle, itemId: string, version: number, sealed: SealedItem) =>
    invokeCmd<string>(CMD.decryptItem, { handle, itemId, version, sealed }),
  changePassword: (handle: SessionHandle, newPassword: string, params: KdfParams) =>
    invokeCmd<VaultBootstrap>(CMD.changePassword, {
      handle,
      newPassword,
      params,
    }),
  generatePassword: (opts: PwGenOptions) => invokeCmd<string>(CMD.generatePassword, { opts }),
  generatePassphrase: (words: number, separator: string) =>
    invokeCmd<string>(CMD.generatePassphrase, { words, separator }),
  totpAt: (secretB32: string, unixSeconds: number, period: number, digits: number) =>
    invokeCmd<string>(CMD.totpAt, { secretB32, unixSeconds, period, digits }),
  hibpPrefix: (password: string) => invokeCmd<HibpPrefix>(CMD.hibpPrefix, { password }),

  // ---- identity / DID layer (PRD-DID §5.9) ----
  identityCreate: (masterPassword: string, params: KdfParams) =>
    invokeCmd<CreatedIdentity>(CMD.identityCreate, { masterPassword, params }),
  identityUnlock: (
    masterPassword: string,
    saltB64: string,
    params: KdfParams,
    wrappedSeedB64: string,
  ) =>
    invokeCmd<UnlockedIdentity>(CMD.identityUnlock, {
      masterPassword,
      saltB64,
      params,
      wrappedSeedB64,
    }),
  identityFromSeed: (seedB64: string) =>
    invokeCmd<IdentityHandle>(CMD.identityFromSeed, { seedB64 }),
  masterDid: (handle: IdentityHandle) => invokeCmd<string>(CMD.masterDid, { handle }),
  signDetached: (handle: IdentityHandle, payload: string) =>
    invokeCmd<string>(CMD.signDetached, { handle, payload }),
  verifyBinding: (did: string, payload: string, signatureB64: string) =>
    invokeCmd<boolean>(CMD.verifyBinding, { did, payload, signatureB64 }),
  identityLock: (handle: IdentityHandle) => invokeCmd<void>(CMD.identityLock, { handle }),
};

const crypto: PlatformCrypto = {
  async getCore(): Promise<AsyncCryptoCore> {
    return nativeCore;
  },
};

const biometric: PlatformBiometric = {
  isAvailable(): Promise<boolean> {
    return invokeCmd<boolean>(CMD.biometricAvailable);
  },
  isEnrolled(vaultId: string): Promise<boolean> {
    return invokeCmd<boolean>(CMD.biometricEnrolled, { vaultId });
  },
  async enroll(vaultId: string, wrappedDeviceKeyB64: string): Promise<void> {
    await invokeCmd<void>(CMD.biometricEnroll, { vaultId, wrappedDeviceKeyB64 });
  },
  unlock(vaultId: string): Promise<string> {
    return invokeCmd<string>(CMD.biometricUnlock, { vaultId });
  },
};

const autofill: PlatformAutofill = {
  isSupported(): boolean {
    // OS autofill is a later milestone (N5); registration support is reported by
    // the Rust side per-platform. Conservatively false until wired.
    return false;
  },
  async syncIndex(entries: AutofillIndexEntry[]): Promise<void> {
    await invokeCmd<void>(CMD.autofillSyncIndex, { entries });
  },
};

const storage: PlatformStorage = {
  get(key: string): Promise<string | null> {
    return invokeCmd<string | null>(CMD.storageGet, { key });
  },
  async set(key: string, value: string): Promise<void> {
    await invokeCmd<void>(CMD.storageSet, { key, value });
  },
  async remove(key: string): Promise<void> {
    await invokeCmd<void>(CMD.storageRemove, { key });
  },
};

// ---------------------------------------------------------------------------
// Authenticated pod I/O (§3.1) — a WHATWG-fetch shim over the `pod_fetch` Tauri
// command (src-tauri/src/pod_fetch.rs). The Rust side signs every request with
// the in-process DPoP key + access token and does the RFC 9449 nonce retry; the
// token/key NEVER cross into JS (HARD rule #1). This shim only marshals the
// request and rebuilds a real Response so @inrupt/solid-client works unchanged.
// ---------------------------------------------------------------------------

// Mirrors PodRequest/PodResponse in src-tauri/src/pod_fetch.rs
// (#[serde(rename_all="camelCase")]). The wire shape is intentionally uniform:
// headers are ORDERED [name,value] pairs (NOT a map) so duplicate Link headers
// survive in BOTH directions, and the body is ALWAYS base64 (text .ttl + binary
// .enc alike) so there's a single encode/decode path.
type HeaderPair = [string, string];

/** Mirrors PodRequest in pod_fetch.rs. */
interface PodRequest {
  url: string;
  method?: string;
  headers: HeaderPair[];
  /** Always base64 (null/omitted for bodyless verbs). */
  body?: string;
}

/** Mirrors PodResponse in pod_fetch.rs. */
interface PodResponse {
  status: number;
  statusText: string;
  headers: HeaderPair[];
  /** Always base64. */
  body: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Flatten a fetch() HeadersInit into ordered pairs (preserves duplicates). */
function headerPairs(init?: HeadersInit): HeaderPair[] {
  const out: HeaderPair[] = [];
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => out.push([k, v]));
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out.push([k, v]);
  } else {
    for (const [k, v] of Object.entries(init)) out.push([k, v]);
  }
  return out;
}

/** Encode any fetch() body to base64 (the uniform wire shape). */
async function encodeBodyB64(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return bytesToB64(new TextEncoder().encode(body));
  if (body instanceof Blob) return bytesToB64(new Uint8Array(await body.arrayBuffer()));
  if (body instanceof ArrayBuffer) return bytesToB64(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    const v = body as ArrayBufferView;
    return bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  // URLSearchParams/FormData aren't used by pod-fs.ts (string Turtle + binary
  // Blobs only); stringify as a last resort.
  return bytesToB64(new TextEncoder().encode(String(body)));
}

const podFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input as RequestInfo | URL, init);
  const url = request.url;
  const method = (init?.method ?? request.method ?? "GET").toUpperCase();

  // Headers: prefer the Request's merged headers; fall back to init.
  const headers = headerPairs(
    input instanceof Request && !init?.headers
      ? request.headers
      : (init?.headers ?? request.headers),
  );

  // Body (base64): only bodyless-exempt verbs carry one. init first, else Request.
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (init?.body != null) {
      body = await encodeBodyB64(init.body);
    } else if (input instanceof Request) {
      const buf = await request.clone().arrayBuffer();
      if (buf.byteLength > 0) body = bytesToB64(new Uint8Array(buf));
    }
  }

  const req: PodRequest = { url, method, headers, body };

  const res = await invokeCmd<PodResponse>(CMD.podFetch, { req });

  // Rebuild Headers from ordered pairs so duplicate Link headers survive
  // (Headers.append keeps repeats). @inrupt's container parsing depends on them.
  const respHeaders = new Headers();
  for (const [k, v] of res.headers) respHeaders.append(k, v);

  // Body is always base64. 204/205/304 must not carry a body (Fetch spec).
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  const respBody: BodyInit | null = nullBody
    ? null
    : new Blob([b64ToBytes(res.body) as unknown as BlobPart]);

  return new Response(respBody, {
    status: res.status,
    statusText: res.statusText,
    headers: respHeaders,
  });
};

const pod: PlatformPod = {
  fetch: podFetch,
};

export const nativePlatform: Platform = {
  kind: "native",
  auth,
  crypto,
  biometric,
  autofill,
  storage,
  pod,
};
