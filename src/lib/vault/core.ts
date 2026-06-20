"use client";

/**
 * WASM crypto-core loader + adapter.
 *
 * `getCryptoCore()` instantiates the wasm module exactly once (memoized),
 * installs the panic hook once, and returns an object implementing the
 * `CryptoCore` interface from `crypto-contract.ts` by delegating to the named
 * wasm exports.
 *
 * ZERO-KNOWLEDGE INVARIANT: this adapter only ever marshals base64 strings,
 * KDF params, opaque numeric session handles, and short-lived display values
 * (generated passwords, TOTP codes, decrypted item JSON shown to the user).
 * Raw keys never come back across the FFI — the core holds them in WASM memory
 * behind the numeric handle.
 */

import type {
  CreatedIdentity,
  CryptoCore,
  HibpPrefix,
  IdentityHandle,
  KdfParams,
  PwGenOptions,
  SealedItem,
  SessionHandle,
  UnlockedIdentity,
  VaultBootstrap,
} from "./crypto-contract";
import init, {
  init as initPanicHook,
  calibrateKdf as wasmCalibrateKdf,
  changePassword as wasmChangePassword,
  createVault as wasmCreateVault,
  decryptItem as wasmDecryptItem,
  encryptItem as wasmEncryptItem,
  generatePassphrase as wasmGeneratePassphrase,
  generatePassword as wasmGeneratePassword,
  hibpPrefix as wasmHibpPrefix,
  identityCreate as wasmIdentityCreate,
  identityFromSeed as wasmIdentityFromSeed,
  identityLock as wasmIdentityLock,
  identityUnlock as wasmIdentityUnlock,
  lock as wasmLock,
  masterDid as wasmMasterDid,
  signDetached as wasmSignDetached,
  totpAt as wasmTotpAt,
  unlock as wasmUnlock,
  verifyBinding as wasmVerifyBinding,
} from "./pkg/crypto_core";

let corePromise: Promise<CryptoCore> | null = null;

function build(): CryptoCore {
  return {
    calibrateKdf(targetMs: number): KdfParams {
      return wasmCalibrateKdf(targetMs) as KdfParams;
    },
    createVault(masterPassword: string, params: KdfParams): VaultBootstrap {
      return wasmCreateVault(masterPassword, params) as VaultBootstrap;
    },
    unlock(
      masterPassword: string,
      saltB64: string,
      params: KdfParams,
      wrappedDataKeyB64: string,
    ): SessionHandle {
      return wasmUnlock(masterPassword, saltB64, params, wrappedDataKeyB64) as SessionHandle;
    },
    lock(handle: SessionHandle): void {
      wasmLock(handle);
    },
    encryptItem(
      handle: SessionHandle,
      itemId: string,
      version: number,
      plaintextJson: string,
    ): SealedItem {
      return wasmEncryptItem(handle, itemId, version, plaintextJson) as SealedItem;
    },
    decryptItem(
      handle: SessionHandle,
      itemId: string,
      version: number,
      sealed: SealedItem,
    ): string {
      return wasmDecryptItem(handle, itemId, version, sealed);
    },
    changePassword(handle: SessionHandle, newPassword: string, params: KdfParams): VaultBootstrap {
      return wasmChangePassword(handle, newPassword, params) as VaultBootstrap;
    },
    generatePassword(opts: PwGenOptions): string {
      return wasmGeneratePassword(opts);
    },
    generatePassphrase(words: number, separator: string): string {
      return wasmGeneratePassphrase(words, separator);
    },
    totpAt(secretB32: string, unixSeconds: number, period: number, digits: number): string {
      return wasmTotpAt(secretB32, unixSeconds, period, digits);
    },
    hibpPrefix(password: string): HibpPrefix {
      return wasmHibpPrefix(password) as HibpPrefix;
    },

    // ---- identity / DID layer (PRD-DID §5.9) ----
    identityCreate(masterPassword: string, params: KdfParams): CreatedIdentity {
      return wasmIdentityCreate(masterPassword, params) as CreatedIdentity;
    },
    identityUnlock(
      masterPassword: string,
      saltB64: string,
      params: KdfParams,
      wrappedSeedB64: string,
    ): UnlockedIdentity {
      return wasmIdentityUnlock(
        masterPassword,
        saltB64,
        params,
        wrappedSeedB64,
      ) as UnlockedIdentity;
    },
    identityFromSeed(seedB64: string): IdentityHandle {
      return wasmIdentityFromSeed(seedB64);
    },
    masterDid(handle: IdentityHandle): string {
      return wasmMasterDid(handle);
    },
    signDetached(handle: IdentityHandle, payload: string): string {
      return wasmSignDetached(handle, payload);
    },
    verifyBinding(did: string, payload: string, signatureB64: string): boolean {
      return wasmVerifyBinding(did, payload, signatureB64);
    },
    identityLock(handle: IdentityHandle): void {
      wasmIdentityLock(handle);
    },
  };
}

/** Singleton accessor: loads + instantiates wasm once, installs the panic hook once. */
export function getCryptoCore(): Promise<CryptoCore> {
  if (!corePromise) {
    corePromise = (async () => {
      await init();
      initPanicHook();
      return build();
    })().catch((e) => {
      // Reset so a later call can retry a transient load failure.
      corePromise = null;
      throw e;
    });
  }
  return corePromise;
}
