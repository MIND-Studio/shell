/**
 * TypeScript mirror of the WASM crypto-core FFI (see crypto-core/CONTRACT.md —
 * the authoritative spec). The wasm loader in `src/lib/vault/core.ts` returns an
 * object conforming to `CryptoCore`; the Vault app codes only against this type,
 * so it can be written and typechecked before `npm run wasm` produces the glue.
 *
 * ZERO-KNOWLEDGE INVARIANT: raw keys never appear here. A session handle (number)
 * is the only reference to unlocked key material, which lives in WASM memory.
 */

export interface KdfParams {
  /** Argon2id memory cost in KiB. */
  m_kib: number;
  /** Argon2id time cost (iterations). */
  t: number;
  /** Argon2id parallelism (lanes). */
  p: number;
}

export interface VaultBootstrap {
  kdf: KdfParams;
  /** 128-bit salt, base64. */
  salt_b64: string;
  /** Vault data key wrapped by the stretched master key, base64. */
  wrapped_data_key_b64: string;
}

export interface SealedItem {
  /** XChaCha20-Poly1305 ciphertext (tag appended), base64. */
  ciphertext_b64: string;
  /** 192-bit (24-byte) random nonce, base64. */
  nonce_b64: string;
  /** Per-item key wrapped by the vault data key, base64. */
  wrapped_item_key_b64: string;
}

export interface PwGenOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export interface HibpPrefix {
  /** First 5 hex chars of SHA-1(password) — the only part sent to HIBP. */
  prefix: string;
  /** Remaining suffix, compared locally against the range response. */
  suffix: string;
}

/** A vault unlock session — an opaque handle into WASM-held key material. */
export type SessionHandle = number;

export interface CryptoCore extends IdentityCore {
  calibrateKdf(targetMs: number): KdfParams;
  createVault(masterPassword: string, params: KdfParams): VaultBootstrap;
  unlock(
    masterPassword: string,
    saltB64: string,
    params: KdfParams,
    wrappedDataKeyB64: string,
  ): SessionHandle;
  lock(handle: SessionHandle): void;
  encryptItem(
    handle: SessionHandle,
    itemId: string,
    version: number,
    plaintextJson: string,
  ): SealedItem;
  decryptItem(handle: SessionHandle, itemId: string, version: number, sealed: SealedItem): string;
  changePassword(handle: SessionHandle, newPassword: string, params: KdfParams): VaultBootstrap;
  generatePassword(opts: PwGenOptions): string;
  generatePassphrase(words: number, separator: string): string;
  totpAt(secretB32: string, unixSeconds: number, period: number, digits: number): string;
  hibpPrefix(password: string): HibpPrefix;
}

/**
 * A master-identity unlock session — an opaque handle into Rust-held Ed25519 key
 * material. Distinct from {@link SessionHandle} (vault sessions are a separate
 * store); never mix the two.
 */
export type IdentityHandle = number;

/**
 * The encrypted-at-rest master identity (C1). Every field is NON-secret: the
 * public `did:key`, the Argon2id params + salt, and the 32-byte master seed
 * wrapped (XChaCha20-Poly1305) under the master password. The wallet persists
 * this verbatim (localStorage primary + optional encrypted pod backup); the seed
 * itself is never part of it and never crosses the FFI.
 */
export interface IdentityKeystore {
  did: string;
  kdf: KdfParams;
  salt_b64: string;
  wrapped_seed_b64: string;
}

/** `identityCreate` result: the persistable keystore plus a live session handle. */
export interface CreatedIdentity extends IdentityKeystore {
  handle: IdentityHandle;
}

/** `identityUnlock` result: the public did:key plus a live session handle. */
export interface UnlockedIdentity {
  did: string;
  handle: IdentityHandle;
}

/**
 * The DID / master-identity FFI (PRD-DID §5.9), mirrored from `CONTRACT.md`.
 *
 * ZERO-KNOWLEDGE INVARIANT (extends {@link CryptoCore}'s): the master seed and
 * Ed25519 private key NEVER appear here. The seed is generated/unwrapped INSIDE
 * Rust (`identityCreate`/`identityUnlock`) and zeroized; `identityFromSeed` (the
 * C0 primitive) takes a seed once, base64, and zeroizes it. After that only the
 * handle, the public `did:key`, and detached signatures cross.
 *
 * NOTE: implemented by the same wasm module as {@link CryptoCore}; the loader in
 * `src/lib/vault/core.ts` exposes these alongside the vault ops.
 */
export interface IdentityCore {
  /**
   * Generate a fresh master identity: a random 32-byte seed wrapped under
   * `masterPassword` (Argon2id → XChaCha20), minting a live session. Returns the
   * persistable keystore + handle. This is identity CREATION (fresh CSPRNG seed),
   * not derivation — two calls with the same password differ.
   */
  identityCreate(masterPassword: string, params: KdfParams): CreatedIdentity;
  /**
   * Unwrap the seed from a stored keystore and mint a live session. Returns the
   * public did:key + handle. Throws generically on a wrong master password.
   */
  identityUnlock(
    masterPassword: string,
    saltB64: string,
    params: KdfParams,
    wrappedSeedB64: string,
  ): UnlockedIdentity;
  /**
   * Mint a session from a base64 32-byte seed; returns its handle. The seed is
   * used once and zeroized; never retained. Throws on a non-32-byte seed. (C0
   * primitive — `identityCreate`/`identityUnlock` are the keystore-backed path.)
   */
  identityFromSeed(seedB64: string): IdentityHandle;
  /** The session's master `did:key` (public material only), e.g. `did:key:z6Mk…`. */
  masterDid(handle: IdentityHandle): string;
  /**
   * Detached EdDSA signature (base64) over the UTF-8 `payload` (the canonical
   * JCS binding document — PRD-DID §5.5). The private key never crosses the FFI.
   */
  signDetached(handle: IdentityHandle, payload: string): string;
  /**
   * Verify a detached signature against a `did:key`. Pure (no handle): returns
   * false on mismatch, throws on a malformed did:key/signature. No server needed.
   */
  verifyBinding(did: string, payload: string, signatureB64: string): boolean;
  /** Zeroize + drop the identity session. Idempotent. */
  identityLock(handle: IdentityHandle): void;
}
