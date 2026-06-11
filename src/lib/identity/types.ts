/**
 * The DID identity layer's data model (PRD-DID §5.10).
 *
 * Pure types + helpers — no React, no crypto. The wallet (wallet.ts) owns a
 * portable master `did:key` that controls many per-server **passports** (a fresh
 * WebID + account + pod on each server). This file is the shape contract the
 * wallet, provisioning, and binding modules share.
 *
 * What is and isn't secret (PRD-DID §8):
 *   - PUBLIC / non-secret: the master `did:key`, a passport's WebID, server
 *     origin, pod roots, label, KDF params, salts, ciphertext.
 *   - SECRET (never cleartext at rest, never logged): the master seed (lives only
 *     in the Rust core), and a passport's `creds` (encrypted inside the registry
 *     blob only — never written to a pod or localStorage in the clear).
 */

import type {
  IdentityKeystore,
  VaultBootstrap,
  SealedItem,
} from "@/lib/vault/crypto-contract";

/** The portable master identity (PRD-DID §2.4 — one master DID for v0). */
export interface MasterIdentity {
  /** `did:key:z6Mk…` — public; the controller named in every binding. */
  did: string;
  createdAt: string;
  // The seed + Ed25519 private key are NEVER here; they live in the Rust core
  // behind an opaque handle, wrapped at rest in `StoredWallet.identity`.
}

/**
 * Optional headless re-auth creds — encrypted-at-rest only (PRD-DID §5.6).
 *
 *   - `client-credentials`: a passport's durable `{id,secret}` for headless,
 *     no-redirect Solid-OIDC sign-in (used by fresh-WebID passports).
 *   - `password`: the CSS *account* email+password the shell auto-generated when
 *     provisioning a hybrid workspace (a pod reusing the master WebID). The user
 *     never types or sees it; the shell keeps it here so the workspace's account
 *     is recoverable. Sealed inside the registry blob only — never on a pod, never
 *     logged (AGENTS.md rule #5).
 *   - `did`: NO stored secret at all. The passport re-authenticates by signing a
 *     server challenge with the wallet's master `did:key` (server-side DID login,
 *     e.g. `solid-server-rs`, where first login also auto-provisions the pod).
 *     Silently resumable because the unlocked wallet can always re-sign.
 */
export interface PassportCreds {
  kind: "client-credentials" | "password" | "none" | "did";
  id?: string;
  secret?: string;
  /** `password` kind only: the auto-generated CSS account login. */
  email?: string;
  password?: string;
  /**
   * Email-verification state (PRD-PROVIDER-ACCOUNTS §6). Only meaningful for a
   * real, deliverable `email` (a `.mind.local` placeholder needs no verifying):
   *   - `undefined`/`true` → verified or nothing to verify (the default path)
   *   - `false`            → PENDING confirmation. The account is usable only
   *     after the user confirms in-provider; until then silent resume is
   *     disabled for it (resume.ts) so we never auto-enter an unconfirmed login.
   * Non-secret metadata — sealed alongside the creds, never logged.
   */
  emailVerified?: boolean;
}

/** A per-server bundle the master identity owns (PRD-DID §2.2). */
export interface Passport {
  /** Local stable id (random). */
  id: string;
  /** The master did:key (same across all passports for v0 — §2.4). */
  did: string;
  /** Server origin, e.g. "http://localhost:3101". */
  server: string;
  /** The WebID THIS server minted for this passport (fresh, not reused). */
  webId: string;
  /** Pods/workspaces under this passport — feeds the Phase-B rail. */
  podRoots: string[];
  /** Human label ("Work", "Personal"). */
  label?: string;
  /** Account email used at signup (recovery channel; never an identifier — §5.8). */
  email?: string;
  createdAt: string;
  /** True once a signed binding document has been written into its pod (§5.5). */
  bound?: boolean;
  /**
   * True once the master DID has been bound to this server's ACCOUNT, so the
   * wallet can later log in by signing a challenge (server-side DID login,
   * SOLID_DID.md US-1). Distinct from `bound` (an in-pod binding doc): this is
   * an account-layer link. Set at provision time on a DID-aware CSS;
   * `undefined`/`false` on stock servers.
   */
  didLinked?: boolean;
  /**
   * True when this record is a **hybrid workspace** (PRD-DID §5.7 hybrid), not a
   * standalone passport: its pod reuses the master WebID (so `webId` is the master
   * WebID, not a fresh one) and `creds` is a `password` kind. The account switcher
   * filters these out of the switchable-identity list — they're workspaces in the
   * rail, not identities to act as.
   */
  workspace?: boolean;
  /**
   * True when this login was **captured manually** (PRD-PROVIDER-ACCOUNTS P3): an
   * existing account at a provider the shell can't provision headlessly (Inrupt
   * PodSpaces, a register-yourself CSS). The user typed the email + password; the
   * shell seals them like any other provider account but holds NO client-
   * credentials key card, so it is never silently resumed (resume.ts) — a
   * viewable, reusable login only.
   */
  manual?: boolean;
  /** Encrypted-at-rest only; present only inside the decrypted registry. */
  creds?: PassportCreds;
}

/**
 * The encrypted wallet blob persisted to localStorage (primary) and optionally
 * backed up to the pod as ciphertext (PRD-DID §5.6). Every field is non-secret:
 * the master seed is wrapped inside `identity`, and the passport list (which may
 * carry creds) is sealed inside `registry`. Safe to hand to an untrusted store.
 */
export interface StoredWallet {
  version: 1;
  /** Envelope-wrapped master seed + public did + KDF params (from the core). */
  identity: IdentityKeystore;
  /** The passport registry: a vault-envelope keystore + one sealed JSON item. */
  registry: {
    bootstrap: VaultBootstrap;
    /** Sealed `Passport[]` JSON; null until the first passport is added. */
    sealed: SealedItem | null;
    /** AEAD version for the sealed registry item (bumped on every save). */
    version: number;
  };
  createdAt: string;
}

/** The wallet's runtime status, surfaced to the UI. */
export type WalletStatus = "none" | "locked" | "unlocked";

/** Snapshot the UI renders from (never carries seeds/handles). */
export interface WalletView {
  status: WalletStatus;
  /** Present when status is "locked" or "unlocked" (public did). */
  did?: string;
  /** Present when "unlocked". */
  passports?: Passport[];
}

/** The fixed registry item id (one sealed item holds the whole passport list). */
export const REGISTRY_ITEM_ID = "passports";

/** localStorage key for the encrypted wallet blob. */
export const WALLET_STORAGE_KEY = "mind-shell:wallet";

/**
 * localStorage key for the **last-active passport id** (non-secret pointer only).
 *
 * Written when a passport session goes active (passport-session.ts) so a returning
 * visit can resume the SAME identity headlessly: on a same-tab SPA nav the unlocked
 * wallet re-enters it silently; after a hard reload the one-tap unlock picks this
 * passport first. Holds ONLY a registry id — never creds, never a WebID secret —
 * so it's safe in plaintext localStorage (AGENTS.md rule #2/#5).
 */
export const LAST_ACTIVE_PASSPORT_KEY = "mind-shell:last-active-passport";

/** The pod path for the optional encrypted wallet backup (ciphertext only). */
export function walletBackupUrl(podRoot: string): string {
  const base = podRoot.endsWith("/") ? podRoot : podRoot + "/";
  return `${base}apps/shell/wallet.enc`;
}
