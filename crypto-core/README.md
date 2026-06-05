# `crypto-core`

The zero-knowledge crypto core for the mind-shell **Vault** (a password
manager). One audited Rust codebase, two targets:

- **WASM** (`wasm-pack build --target web`) for the in-pod web app — the
  default path. Built into `../src/lib/vault/pkg/` by `npm run wasm`.
- **Native** `rlib`/`cdylib` for `cargo test` and a future Tauri sidecar.

It implements the FFI contract in [`CONTRACT.md`](./CONTRACT.md) (authoritative),
mirrored in TypeScript at `../src/lib/vault/crypto-contract.ts`.

## What it does

- **KDF:** Argon2id (RFC 9106 / OWASP first choice) + HKDF-SHA256 stretch into
  domain-separated enc/wrap subkeys. Params are **calibrated at runtime** and
  floored at the OWASP baseline (m=19456 KiB, t=2, p=1); the default target is
  RFC 9106's "second recommended" zone (m=65536 KiB, t=3, p=4).
- **AEAD:** XChaCha20-Poly1305 ONLY (192-bit random nonces — safe across
  multi-device pod writes). No AES-CBC, no unauthenticated modes.
- **Envelope encryption:** random 256-bit vault data key wrapped by the
  stretched master key; per-item keys wrapped by the data key; item ciphertext
  bound to its identity via AAD = `"{itemId}:{version}"`.
- **Session model:** `unlock` stashes the unlocked keys in WASM linear memory
  behind an opaque `u32` handle. Raw keys and plaintext **never** cross the FFI.
  `lock` zeroizes and removes the session.
- **Generators:** CSPRNG password + passphrase. **TOTP:** RFC 6238 (host
  supplies trusted time via `totpAt`). **HIBP:** SHA-1 k-anonymity prefix/suffix
  split — the password and full hash never leave the device.

## Memory hygiene

Key material is wrapped in `secrecy::SecretBox`, key structs derive
`ZeroizeOnDrop`, keys are fixed-size `[u8; 32]` arrays (not `Vec`/`String`), and
secret comparisons use `subtle` constant-time equality.

**WASM caveats (PRD §5.5):** no `mlock`, weaker memory-copy control on the JS/GC
heap, and stock WASM is not constant-time by spec. Strict CSP is mandatory for
the web surface; the native path is the hardened path.

**Native hardening (PRD-NATIVE §2):** the native (`rlib`, Tauri) path pins the
unlocked data-key region into physical RAM — `mlock` on Unix, `VirtualLock` on
Windows (`memlock.rs`) — so it is never written to swap, and zeroizes +
unpins it on `lock`/drop. Its session store is process-global and thread-safe
(so a handle survives Tauri's worker threads). It exposes the same operations as
the WASM FFI via `crypto_core::native` — see the "Native API" section of
[`CONTRACT.md`](./CONTRACT.md). The native API is **not** a wider FFI: raw keys
and plaintext never leave it; a session is referenced only by an opaque `u32`.

## Commands

```bash
cargo test          # pure-Rust core, runs natively (no WASM needed)
cargo audit         # advisory scan  (cargo install cargo-audit)
cargo deny check    # advisories + bans (cargo install cargo-deny), see deny.toml
npm run wasm        # from the project root: build the WASM glue into src/lib/vault/pkg/
```

## Caveat

**Independent crypto review is required before this core touches real secrets**
(PRD §8). `cargo audit` + `cargo deny` are standing CI controls but are not a
substitute for review. The WASM target inherits the browser/XSS threat surface.
