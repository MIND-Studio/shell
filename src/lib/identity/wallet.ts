"use client";

/**
 * The wallet — the master identity + passport registry (PRD-DID C1).
 *
 * A process-wide singleton (like the Solid session): exactly one wallet is
 * unlocked at a time, shared by the Identity app and the account switcher. The
 * UI reads {@link getView} and re-renders on {@link subscribe}.
 *
 * KEY CUSTODY (PRD-DID §5.4, §8):
 *   - The master seed + Ed25519 private key live ONLY in the Rust core, behind an
 *     opaque handle. They never enter JS and are never persisted in the clear.
 *   - At rest the seed is wrapped by the audited crypto-core envelope (Argon2id →
 *     XChaCha20) under the master password — ONE reviewed stack, no Stronghold.
 *   - The passport registry (which may carry creds) is sealed by the SAME
 *     envelope (a tiny one-item vault). The persisted blob ({@link StoredWallet})
 *     is therefore all ciphertext + non-secret params: safe for localStorage and
 *     for an optional encrypted pod backup (the pod sees ciphertext only).
 *
 * WEB DEGRADED PATH (§5.4): the browser build holds the unlocked seed in WASM
 * memory for the session after a password unlock — an explicit, documented
 * XSS-risk tradeoff for the prototype (native custody is the hardened path). The
 * UI surfaces this caveat. Lock zeroizes the core handles.
 *
 * NEVER logged: the master password, seed, private key, or decrypted registry
 * (AGENTS.md rule #5). OK to log: the public did, server origin, event type.
 */

import { getPlatform, type AsyncCryptoCore } from "@/lib/platform";
import type { KdfParams } from "@/lib/vault/crypto-contract";
import {
  REGISTRY_ITEM_ID,
  WALLET_STORAGE_KEY,
  type Passport,
  type StoredWallet,
  type WalletView,
} from "./types";

/** In-memory unlocked state — only opaque handles + public/derived display data. */
interface Unlocked {
  did: string;
  /** Identity session handle (Ed25519 signing) — opaque. */
  idHandle: number;
  /** Registry vault session handle (encrypt/decrypt the passport list) — opaque. */
  vaultHandle: number;
  passports: Passport[];
}

let unlocked: Unlocked | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Subscribe to wallet state changes (create/unlock/lock/passport edits). */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function core(): Promise<AsyncCryptoCore> {
  return (await getPlatform()).crypto.getCore();
}

// ---- persistence (localStorage primary; ciphertext only) --------------------

function load(): StoredWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(WALLET_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredWallet) : null;
  } catch {
    return null;
  }
}

function persist(w: StoredWallet): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(w));
}

/** True if an encrypted wallet exists on this device. */
export function hasWallet(): boolean {
  return load() != null;
}

/** The raw encrypted blob (ciphertext + non-secret params) for pod backup. */
export function exportBlob(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(WALLET_STORAGE_KEY);
}

/** Restore a wallet from a backup blob (e.g. fetched from the pod). Stays locked. */
export function importBlob(blob: string): void {
  // Validate it parses to a wallet shape before overwriting.
  const w = JSON.parse(blob) as StoredWallet;
  if (w.version !== 1 || !w.identity?.did) throw new Error("Not a valid wallet backup.");
  persist(w);
  emit();
}

// ---- view -------------------------------------------------------------------

/** A render snapshot (never exposes handles/seeds). */
export function getView(): WalletView {
  if (unlocked) {
    return { status: "unlocked", did: unlocked.did, passports: unlocked.passports };
  }
  const w = load();
  if (w) return { status: "locked", did: w.identity.did };
  return { status: "none" };
}

/** The master did:key when a wallet exists (locked or unlocked), else null. */
export function getDid(): string | null {
  return getView().did ?? null;
}

/** The decrypted passport list (empty unless unlocked). */
export function getPassports(): Passport[] {
  return unlocked ? unlocked.passports : [];
}

// ---- lifecycle --------------------------------------------------------------

/**
 * Create a brand-new master identity (fresh random seed) + an empty encrypted
 * registry, both wrapped under `masterPassword`, and leave the wallet unlocked.
 * Overwrites any existing wallet on this device — the caller guards that.
 */
export async function createWallet(masterPassword: string): Promise<WalletView> {
  const c = await core();
  // One calibration drives both envelopes (identity seed + registry).
  const params: KdfParams = await c.calibrateKdf(750);
  const created = await c.identityCreate(masterPassword, params);
  const bootstrap = await c.createVault(masterPassword, params);
  const vaultHandle = await c.unlock(
    masterPassword,
    bootstrap.salt_b64,
    bootstrap.kdf,
    bootstrap.wrapped_data_key_b64
  );

  const w: StoredWallet = {
    version: 1,
    identity: {
      did: created.did,
      kdf: created.kdf,
      salt_b64: created.salt_b64,
      wrapped_seed_b64: created.wrapped_seed_b64,
    },
    registry: { bootstrap, sealed: null, version: 0 },
    createdAt: new Date().toISOString(),
  };
  persist(w);
  unlocked = { did: created.did, idHandle: created.handle, vaultHandle, passports: [] };
  emit();
  return getView();
}

/**
 * Unlock the stored wallet with `masterPassword`. Throws generically on a wrong
 * password (the core's AEAD tag check fails). Decrypts the passport registry.
 */
export async function unlockWallet(masterPassword: string): Promise<WalletView> {
  const w = load();
  if (!w) throw new Error("No wallet on this device.");
  const c = await core();
  // identityUnlock throws first on a wrong password (same password unlocks both).
  const u = await c.identityUnlock(
    masterPassword,
    w.identity.salt_b64,
    w.identity.kdf,
    w.identity.wrapped_seed_b64
  );
  const vaultHandle = await c.unlock(
    masterPassword,
    w.registry.bootstrap.salt_b64,
    w.registry.bootstrap.kdf,
    w.registry.bootstrap.wrapped_data_key_b64
  );
  let passports: Passport[] = [];
  if (w.registry.sealed) {
    const json = await c.decryptItem(
      vaultHandle,
      REGISTRY_ITEM_ID,
      w.registry.version,
      w.registry.sealed
    );
    passports = JSON.parse(json) as Passport[];
  }
  unlocked = { did: u.did, idHandle: u.handle, vaultHandle, passports };
  emit();
  return getView();
}

/** Lock the wallet: drop + zeroize the core handles, clear in-memory state. */
export function lockWallet(): void {
  const u = unlocked;
  unlocked = null;
  emit();
  if (!u) return;
  void (async () => {
    const c = await core();
    await c.identityLock(u.idHandle).catch(() => {});
    await c.lock(u.vaultHandle).catch(() => {});
  })();
}

// ---- passport registry ------------------------------------------------------

/** Re-encrypt + persist the passport list. Requires an unlocked wallet. */
async function saveRegistry(): Promise<void> {
  if (!unlocked) throw new Error("Wallet is locked.");
  const c = await core();
  const w = load();
  if (!w) throw new Error("Wallet missing.");
  const version = w.registry.version + 1;
  const json = JSON.stringify(unlocked.passports);
  const sealed = await c.encryptItem(unlocked.vaultHandle, REGISTRY_ITEM_ID, version, json);
  w.registry.sealed = sealed;
  w.registry.version = version;
  persist(w);
}

/** Add a passport to the encrypted registry. Requires an unlocked wallet. */
export async function addPassport(passport: Passport): Promise<WalletView> {
  if (!unlocked) throw new Error("Wallet is locked.");
  unlocked.passports = [...unlocked.passports, passport];
  await saveRegistry();
  emit();
  return getView();
}

/** Patch a passport (by id) in the encrypted registry. */
export async function updatePassport(
  id: string,
  patch: Partial<Passport>
): Promise<WalletView> {
  if (!unlocked) throw new Error("Wallet is locked.");
  unlocked.passports = unlocked.passports.map((p) =>
    p.id === id ? { ...p, ...patch } : p
  );
  await saveRegistry();
  emit();
  return getView();
}

/** Remove a passport from the registry (does not delete its pod). */
export async function removePassport(id: string): Promise<WalletView> {
  if (!unlocked) throw new Error("Wallet is locked.");
  unlocked.passports = unlocked.passports.filter((p) => p.id !== id);
  await saveRegistry();
  emit();
  return getView();
}

// ---- signing ----------------------------------------------------------------

/**
 * Detached EdDSA signature over `payload` by the master key. Requires an
 * unlocked wallet. The private key never leaves the core — only the signature
 * comes back (PRD-DID §8).
 */
export async function sign(payload: string): Promise<string> {
  if (!unlocked) throw new Error("Wallet is locked.");
  const c = await core();
  return c.signDetached(unlocked.idHandle, payload);
}

/** Stable random id for a new passport. */
export function newPassportId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `pp-${rand}`;
}
