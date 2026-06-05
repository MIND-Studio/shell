# `crypto-core` — the WASM FFI contract (authoritative)

This file is the **single source of truth** for the boundary between the Rust
crypto core and the TypeScript Vault app. Both sides must conform to it. The
TypeScript mirror is `src/lib/vault/crypto-contract.ts`.

> **Zero-knowledge invariant (PRD §5.5):** plaintext secrets and raw key
> material **never cross the FFI boundary**. The core holds the unlocked keys in
> WASM linear memory behind an opaque numeric **session handle**; JS only ever
> receives ciphertext, wrapped keys, KDF params, salts, or short-lived display
> values (a generated password, a TOTP code, a decrypted item's JSON shown to
> the user). The Solid pod is an **untrusted store**.

## Data shapes (all binary fields are base64, standard alphabet, no wrapping)

```
KdfParams   = { m_kib: number, t: number, p: number }     // Argon2id cost
VaultBootstrap = {                                          // create_vault output
  kdf: KdfParams,
  salt_b64: string,            // 128-bit random
  wrapped_data_key_b64: string // vault data key wrapped by the stretched master key
}
SealedItem  = {                                            // encrypt_item output
  ciphertext_b64: string,      // XChaCha20-Poly1305 AEAD output (tag appended)
  nonce_b64: string,           // 192-bit (24-byte) random nonce
  wrapped_item_key_b64: string // per-item key wrapped by the vault data key
}
PwGenOptions = { length: number, upper: bool, lower: bool, digits: bool,
                 symbols: bool, avoid_ambiguous: bool }
```

AAD for every item = the UTF-8 bytes of `"{itemId}:{version}"` (binds the
ciphertext to its identity — prevents swap attacks; PRD §5.2).

## Exported functions (wasm-bindgen)

```
init(): void
    Install the panic hook. Call once on module load.

calibrate_kdf(target_ms: number): KdfParams
    Time Argon2id on this device and return params that hit ~target_ms
    (PRD §5.1: target ~500–1000 ms). Floor at OWASP m=19456 KiB (19 MiB), t=2,
    p=1; aim for RFC 9106 "second recommended" zone (m>=65536 KiB, t=3, p=4).

create_vault(master_password: string, params: KdfParams): VaultBootstrap
    Generate a fresh 256-bit vault data key (CSPRNG), derive the stretched
    master key from password+salt via Argon2id+HKDF, wrap the data key, and
    return the non-secret bootstrap to persist in vault.ttl. Does NOT unlock.

unlock(master_password: string, salt_b64, params: KdfParams,
       wrapped_data_key_b64): number    // returns a session handle (u32)
    Derive the stretched master key, unwrap the data key, store both in WASM
    memory keyed by the returned handle. Throws on wrong password (AEAD tag
    fail). The handle is the ONLY thing JS holds.

lock(handle: number): void
    Zeroize and drop all key material for the handle. Idempotent.

encrypt_item(handle, item_id: string, version: number,
             plaintext_json: string): SealedItem
    Generate a per-item key, AEAD-encrypt plaintext_json with AAD(item_id,ver),
    wrap the per-item key under the data key.

decrypt_item(handle, item_id: string, version: number,
             sealed: SealedItem): string   // returns plaintext_json
    Unwrap the per-item key, verify AAD + tag, decrypt. Throws on tamper.

change_password(handle, new_password: string,
                params: KdfParams): VaultBootstrap
    Re-derive from new_password and RE-WRAP the existing data key only (bulk
    ciphertext untouched — PRD §5.2). Returns the new bootstrap to persist.

generate_password(opts: PwGenOptions): string
generate_passphrase(words: number, separator: string): string
    CSPRNG generators (OsRng). Display values, returned to JS.

totp_now(secret_b32: string, period: number, digits: number): string
    RFC 6238 TOTP for the current time. NOTE: WASM has no clock the core can
    trust independently; the host passes time via `totp_at` in practice ->

totp_at(secret_b32: string, unix_seconds: number, period, digits): string
    Deterministic TOTP at an explicit timestamp (host supplies Date.now()/1000).

hibp_prefix(password: string): { prefix: string, suffix: string }
    SHA-1 the password locally, return the 5-hex-char prefix (sent to the HIBP
    range API) and the remaining suffix (compared locally). The password and
    full hash NEVER leave the device (PRD §4.1 k-anonymity).
```

## Identity / DID layer (PRD-DID §5.9)

The wallet's portable master identity is an Ed25519 keypair. Its public key is a
`did:key` (multicodec `ed25519-pub` `0xed01` prefix + base58btc multibase, so
every one renders `did:key:z6Mk…`). Signing material is held behind a SEPARATE
opaque `u32` session handle (distinct map from the vault sessions).

> **Zero-knowledge invariant extends here:** the master seed and Ed25519 private
> key NEVER cross the FFI. The seed enters exactly once (base64, at
> `identity_from_seed`) to mint a session and is zeroized immediately; thereafter
> only the handle, the public `did:key`, and detached signatures cross the
> boundary. Bindings are signed pod content, NOT credentials any server checks.

```
identity_from_seed(seed_b64: string): number   // returns an identity handle (u32)
    Decode a base64 32-byte seed, derive the Ed25519 master key, store it in
    WASM/native memory keyed by the returned handle. The decoded seed is zeroized
    before return. Throws on a non-32-byte seed / bad base64.

master_did(handle: number): string             // "did:key:z6Mk…"
    The session's master did:key (public material only).

sign_detached(handle, payload: string): string // base64 EdDSA signature
    Detached EdDSA over the UTF-8 bytes of `payload` (the canonical JCS binding
    document — PRD-DID §5.5). The private key never crosses the FFI.

verify_binding(did: string, payload: string, signature_b64: string): boolean
    Pure verification (no handle): decode the did:key → Ed25519 `verify_strict`
    over the UTF-8 `payload`. Returns false on signature/key mismatch; throws on
    a malformed did:key / signature. ZERO server support required.

identity_lock(handle: number): void
    Zeroize and drop the identity session's key material. Idempotent.
```

### Encrypted-at-rest keystore (C1: envelope-wrapped seed)

The wallet must not keep the master seed in cleartext storage (PRD-DID §5.4). The
seed is wrapped with the SAME audited envelope as the Vault — Argon2id (`kdf`) →
XChaCha20-Poly1305 (`aead`), AAD `mind-shell/identity/v1/master-seed` — under a
master password, so the wallet reuses ONE reviewed crypto stack (no Stronghold,
no second keystore format). The seed is generated/unwrapped INSIDE the core and
never crosses the FFI; only the public did:key + the ciphertext keystore cross.

```
IdentityKeystore = {                       // all NON-secret; persisted by the wallet
  did: string,                 // "did:key:z6Mk…" (public)
  kdf: KdfParams,
  salt_b64: string,            // 128-bit random
  wrapped_seed_b64: string     // 32-byte master seed wrapped under the master password
}

identity_create(master_password: string, params: KdfParams)
    : IdentityKeystore & { handle: number }
    Generate a fresh 32-byte master seed (CSPRNG), wrap it under the
    password-derived key, mint a session, and return the keystore + handle. This
    is identity CREATION (fresh random seed), not derivation — two calls differ.

identity_unlock(master_password: string, salt_b64, params: KdfParams,
                wrapped_seed_b64): { did: string, handle: number }
    Re-derive the wrap key, unwrap the seed in-core, mint a session, return the
    public did:key + handle. Throws generically on a wrong master password.
```

Crates added for this layer: `ed25519-dalek` (RustCrypto family; `zeroize`
feature so `SigningKey` wipes on drop) + `bs58` for the `did:key` multibase. No
HD/SLIP-0010 in v0 — the seed IS the single master keypair (PRD-DID §2.4); HD
child-DID derivation is the deferred hardening path.

## Crate rules (PRD §5.3–5.4)

- Use RustCrypto: `argon2`, `chacha20poly1305` (XChaCha20Poly1305), `hkdf`,
  `sha1`, `sha2`, `zeroize`, `secrecy`, `subtle`, `rand`/`getrandom`,
  `base64`, `totp`/hand-rolled RFC 6238, `serde`/`serde_json`, `wasm-bindgen`.
- Wrap all key material in `secrecy::SecretBox`; `#[derive(ZeroizeOnDrop)]` on
  key structs; prefer fixed-size `[u8; 32]` arrays over `Vec`/`String` for keys.
- Constant-time compares via `subtle` only — never `==` on secrets.
- `cargo audit` + `cargo deny` in CI; pin versions; no unaudited crypto.
- AEAD = XChaCha20-Poly1305 ONLY (192-bit nonce → safe random nonces across
  multi-device pod writes). Do NOT use AES-CBC or any unauthenticated mode.

## Targets

- `wasm-pack build --target web --out-dir ../src/lib/vault/pkg --no-pack`
  (the `npm run wasm` script). The Vault app imports the generated glue.
- Same crate also builds as a native `rlib`/`cdylib` for the future Tauri
  sidecar (PRD M6) — keep all `wasm_bindgen` behind `#[cfg(target_arch =
  "wasm32")]` or a `wasm` feature so `cargo test` runs the pure-Rust core
  natively.
- Tests: unit tests + known-answer tests (round-trip encrypt/decrypt, wrong
  password fails, tamper fails, AAD mismatch fails, re-wrap preserves data key).

## Native API (Tauri) — `crypto_core::native` (NOT a wider FFI)

The native (`rlib`) path exposes the **same operations** as the WASM FFI above,
for the Tauri shell's Rust commands (`src-tauri/src/commands.rs`) to call
directly. It is built on the same store-free primitives in `envelope`/`kdf`/…,
so the crypto logic exists exactly once. It preserves every zero-knowledge
invariant: it returns only ciphertext, wrapped keys, KDF params, salts, and
short-lived display values; the unlocked session is referenced ONLY by an opaque
`u32` handle held in native memory. **The Tauri command layer must not return
the data key or plaintext item bodies across the webview IPC boundary** — treat
this Rust API exactly like the WASM FFI.

What native adds over WASM (PRD-NATIVE §2):

- The unlocked data key is pinned into physical RAM (`mlock` on Unix /
  `VirtualLock` on Windows, see `memlock.rs`) for the session's whole lifetime
  and zeroized + unpinned on drop / `lock`.
- The session store is process-global and thread-safe (`Mutex`), so a handle
  stays valid across Tauri's async worker threads (the WASM store is
  `thread_local!`, single-threaded).

```
native::calibrate_kdf(target_ms: f64) -> Result<KdfParams, CoreError>
native::create_vault(master_password: &str, params: KdfParams)
    -> Result<VaultBootstrap, CoreError>
native::unlock(master_password: &str, salt_b64: &str, params: KdfParams,
               wrapped_data_key_b64: &str) -> Result<u32, CoreError>   // handle
native::lock(handle: u32)                                              // idempotent
native::lock_state(handle: u32) -> Option<LockState>  // Locked | Unlocked; telemetry only
native::encrypt_item(handle: u32, item_id: &str, version: u32,
                     plaintext_json: &str) -> Result<SealedItem, CoreError>
native::decrypt_item(handle: u32, item_id: &str, version: u32,
                     sealed: &SealedItem) -> Result<String, CoreError> // plaintext_json
native::change_password(handle: u32, new_password: &str, params: KdfParams)
    -> Result<VaultBootstrap, CoreError>
native::generate_password(opts: PwGenOptions) -> Result<String, CoreError>
native::generate_passphrase(words: u32, separator: &str) -> Result<String, CoreError>
native::totp_at(secret_b32: &str, unix_seconds: u64, period: u32, digits: u32)
    -> Result<String, CoreError>
native::hibp_prefix(password: &str) -> HibpPrefix                      // { prefix, suffix }

// Identity / DID layer (PRD-DID §5.9). Separate process-global, mlock'd store;
// the SigningKey is pinned into RAM for the session's life (like the vault key)
// and zeroized on drop. Seed/private key never leave these functions.
native::identity_from_seed(seed: &[u8; 32]) -> u32                     // identity handle
native::master_did(handle: u32) -> Result<String, CoreError>          // "did:key:z6Mk…"
native::sign_detached(handle: u32, payload: &[u8]) -> Result<String, CoreError> // base64 sig
native::verify_binding(did: &str, payload: &[u8], signature_b64: &str)
    -> Result<bool, CoreError>                                        // pure; no handle
native::identity_lock(handle: u32)                                     // idempotent
native::identity_create(master_password: &str, params: KdfParams)
    -> Result<(IdentityKeystore, u32), CoreError>   // keystore + handle; pinned key
native::identity_unlock(master_password: &str, salt_b64: &str, params: KdfParams,
    wrapped_seed_b64: &str) -> Result<(String, u32), CoreError>  // did + handle
```

OIDC/PKCE auth-transport crypto (CSPRNG verifier/state, the SHA-256 `S256`
challenge, DPoP ES256/JWT) deliberately lives in `src-tauri`'s auth layer, NOT
in this crate, to keep its audit surface vault-only — do not add auth/protocol
primitives here.

`VaultBootstrap`, `SealedItem`, `KdfParams`, `PwGenOptions`, `HibpPrefix` are the
same Rust types as above (all `serde`-serializable for Tauri command returns
of NON-secret values). `LockState` is `crypto_core::memlock::LockState`.
