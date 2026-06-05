"use client";

/**
 * Vault item model + pod persistence (PRD §4.2 / §6).
 *
 * ZERO-KNOWLEDGE INVARIANT — what crosses to the pod:
 *   - vault.ttl: KDF params, salt, wrapped data key, schema version, and a
 *     NON-SECRET item index (id, kind, title, url, username, version, updatedAt).
 *     Per the v0 default, titles/urls/usernames are cleartext for search;
 *     passwords/notes/totp seeds are NEVER in the index.
 *   - items/{itemId}.enc: an OPAQUE BINARY blob framing the SealedItem
 *     (nonce || wrappedItemKey || ciphertext). All three are base64 fields from
 *     the core; we decode + frame them so the file is not UTF-8 JSON.
 * Nothing else — no plaintext password/note/totp ever reaches the pod or disk.
 */

import {
  exists,
  readdir,
  readFileBlob,
  readFileText,
  writeFileBlob,
  writeFileText,
  mkdir,
  unlink,
} from "@/lib/solid/pod-fs";
import type { SealedItem, SessionHandle, VaultBootstrap } from "./crypto-contract";
import type { AsyncCryptoCore } from "@/lib/platform";

export const VAULT_SCHEMA_VERSION = 1;

export type VaultItemKind = "login" | "note" | "card";

/** Non-secret index entry held in vault.ttl. */
export interface VaultItemMeta {
  id: string;
  kind: VaultItemKind;
  title: string;
  /** Login URL (cleartext index, optional). */
  url?: string;
  /** Login username (cleartext index, optional). */
  username?: string;
  /** AEAD AAD version — bumped on every save (prevents ciphertext rollback/swap). */
  version: number;
  /** ISO timestamp of last write. */
  updatedAt: string;
}

/** The encrypted payload — only ever lives in WASM/JS memory, never the pod in plaintext. */
export interface VaultItemSecret {
  /** Login / generic password. */
  password?: string;
  /** Free-form secure note body. */
  notes?: string;
  /** Base32 TOTP seed for RFC 6238 codes. */
  totpSecret?: string;
  // card fields
  cardNumber?: string;
  cardholder?: string;
  expiry?: string;
  cvv?: string;
}

export interface LoadedVault {
  bootstrap: VaultBootstrap;
  schemaVersion: number;
  index: VaultItemMeta[];
}

const MIND_NS = "https://mind.dev/ns/v1#";

// ---------------------------------------------------------------------------
// Zone helpers
// ---------------------------------------------------------------------------

function vaultTtlUrl(zone: string): string {
  return `${zone}vault.ttl`;
}
function itemsContainer(zone: string): string {
  return `${zone}items/`;
}
function itemUrl(zone: string, id: string): string {
  return `${itemsContainer(zone)}${encodeURIComponent(id)}.enc`;
}

// ---------------------------------------------------------------------------
// Sealed-item binary framing (opaque blob, NOT JSON)
//   layout: nonce(24) || u16-LE wrappedKeyLen || wrappedKey || ciphertext
// ---------------------------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const NONCE_LEN = 24;

export function packSealed(sealed: SealedItem): Blob {
  const nonce = b64ToBytes(sealed.nonce_b64);
  const wrappedKey = b64ToBytes(sealed.wrapped_item_key_b64);
  const ciphertext = b64ToBytes(sealed.ciphertext_b64);
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`vault: unexpected nonce length ${nonce.length}`);
  }
  if (wrappedKey.length > 0xffff) {
    throw new Error("vault: wrapped key too large to frame");
  }
  const total = NONCE_LEN + 2 + wrappedKey.length + ciphertext.length;
  const buf = new Uint8Array(total);
  let off = 0;
  buf.set(nonce, off);
  off += NONCE_LEN;
  buf[off] = wrappedKey.length & 0xff;
  buf[off + 1] = (wrappedKey.length >> 8) & 0xff;
  off += 2;
  buf.set(wrappedKey, off);
  off += wrappedKey.length;
  buf.set(ciphertext, off);
  return new Blob([buf], { type: "application/octet-stream" });
}

export function unpackSealed(bytes: Uint8Array): SealedItem {
  if (bytes.length < NONCE_LEN + 2) {
    throw new Error("vault: sealed blob too short");
  }
  let off = 0;
  const nonce = bytes.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const wrappedKeyLen = bytes[off] | (bytes[off + 1] << 8);
  off += 2;
  if (off + wrappedKeyLen > bytes.length) {
    throw new Error("vault: sealed blob truncated (wrapped key)");
  }
  const wrappedKey = bytes.subarray(off, off + wrappedKeyLen);
  off += wrappedKeyLen;
  const ciphertext = bytes.subarray(off);
  return {
    nonce_b64: bytesToB64(nonce),
    wrapped_item_key_b64: bytesToB64(wrappedKey),
    ciphertext_b64: bytesToB64(ciphertext),
  };
}

// ---------------------------------------------------------------------------
// vault.ttl (Turtle) read / write — hand-written + parsed, kept robust.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function unesc(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function serializeVaultTtl(v: LoadedVault): string {
  const lines: string[] = [];
  lines.push(`@prefix mind: <${MIND_NS}> .`);
  lines.push(`@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push("");
  lines.push(`<#vault> a mind:Vault ;`);
  lines.push(`  mind:schemaVersion ${v.schemaVersion} ;`);
  lines.push(`  mind:kdfMemoryKib ${v.bootstrap.kdf.m_kib} ;`);
  lines.push(`  mind:kdfTime ${v.bootstrap.kdf.t} ;`);
  lines.push(`  mind:kdfParallelism ${v.bootstrap.kdf.p} ;`);
  lines.push(`  mind:salt "${esc(v.bootstrap.salt_b64)}" ;`);
  lines.push(`  mind:wrappedDataKey "${esc(v.bootstrap.wrapped_data_key_b64)}" .`);
  lines.push("");
  for (const m of v.index) {
    lines.push(`<#item-${esc(m.id)}> a mind:VaultItem ;`);
    lines.push(`  mind:itemId "${esc(m.id)}" ;`);
    lines.push(`  mind:kind "${esc(m.kind)}" ;`);
    lines.push(`  mind:title "${esc(m.title)}" ;`);
    if (m.url) lines.push(`  mind:url "${esc(m.url)}" ;`);
    if (m.username) lines.push(`  mind:username "${esc(m.username)}" ;`);
    lines.push(`  mind:version ${m.version} ;`);
    lines.push(`  mind:updatedAt "${esc(m.updatedAt)}" .`);
    lines.push("");
  }
  return lines.join("\n");
}

function literal(block: string, pred: string): string | undefined {
  const re = new RegExp(`mind:${pred}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
  const m = block.match(re);
  return m ? unesc(m[1]) : undefined;
}

function intLit(block: string, pred: string): number | undefined {
  const re = new RegExp(`mind:${pred}\\s+(\\d+)`);
  const m = block.match(re);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseVaultTtl(ttl: string): LoadedVault {
  // Split into subject blocks at each "<#...>" subject (statements end with ".").
  const blocks = ttl
    .split(/(?=<#)/)
    .map((b) => b.trim())
    .filter(Boolean);

  let bootstrap: VaultBootstrap | null = null;
  let schemaVersion = VAULT_SCHEMA_VERSION;
  const index: VaultItemMeta[] = [];

  for (const block of blocks) {
    if (block.startsWith("<#vault>")) {
      const salt = literal(block, "salt");
      const wrapped = literal(block, "wrappedDataKey");
      const m_kib = intLit(block, "kdfMemoryKib");
      const t = intLit(block, "kdfTime");
      const p = intLit(block, "kdfParallelism");
      schemaVersion = intLit(block, "schemaVersion") ?? VAULT_SCHEMA_VERSION;
      if (salt && wrapped && m_kib != null && t != null && p != null) {
        bootstrap = {
          kdf: { m_kib, t, p },
          salt_b64: salt,
          wrapped_data_key_b64: wrapped,
        };
      }
    } else if (block.startsWith("<#item-")) {
      const id = literal(block, "itemId");
      const kind = literal(block, "kind") as VaultItemKind | undefined;
      const title = literal(block, "title");
      const version = intLit(block, "version");
      const updatedAt = literal(block, "updatedAt");
      if (id && kind && title != null && version != null) {
        index.push({
          id,
          kind,
          title,
          url: literal(block, "url"),
          username: literal(block, "username"),
          version,
          updatedAt: updatedAt ?? new Date().toISOString(),
        });
      }
    }
  }

  if (!bootstrap) {
    throw new Error("vault: vault.ttl is missing or malformed (no bootstrap)");
  }
  return { bootstrap, schemaVersion, index };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Is `target` present, checked by walking down from `podRoot` through containers
 * that actually exist? A direct GET/HEAD on a missing vault.ttl (or its missing
 * `apps/vault/` parent on a fresh pod) returns 404, which the browser logs to the
 * console even when caught — so we descend only into listed containers and never
 * issue a request that 404s. Falls back to a direct `exists()` if `target` isn't
 * under `podRoot` (shouldn't happen for a workspace zone).
 */
async function resourcePresent(target: string, podRoot: string): Promise<boolean> {
  if (!target.startsWith(podRoot)) return exists(target);
  const segments = target.slice(podRoot.length).split("/").filter(Boolean);
  let current = podRoot; // always exists
  for (let i = 0; i < segments.length; i++) {
    let entries;
    try {
      entries = await readdir(current);
    } catch {
      return false; // container missing / no access → resource not present
    }
    const name = segments[i];
    if (!entries.some((e) => e.name === name)) return false;
    if (i === segments.length - 1) return true;
    current = `${current}${name}/`;
  }
  return false;
}

/**
 * Ensure every container from `podRoot` down to (and including) `container`
 * exists, creating any missing level. Walks via container listings (no 404s) and
 * guarantees intermediate containers (e.g. `apps/`) on a fresh pod — which a lone
 * `mkdir(zone)` would not.
 */
async function ensureContainerChain(container: string, podRoot: string): Promise<void> {
  if (!container.startsWith(podRoot)) {
    if (!(await exists(container))) await mkdir(container);
    return;
  }
  const segments = container.slice(podRoot.length).split("/").filter(Boolean);
  let current = podRoot;
  for (const seg of segments) {
    let entries: Awaited<ReturnType<typeof readdir>> = [];
    try {
      entries = await readdir(current);
    } catch {
      entries = [];
    }
    const next = `${current}${seg}/`;
    if (!entries.some((e) => e.kind === "container" && e.name === seg)) {
      await mkdir(next);
    }
    current = next;
  }
}

/** Load bootstrap + index from the pod, or null if no vault exists yet. */
export async function loadVault(zone: string, podRoot: string): Promise<LoadedVault | null> {
  if (!(await resourcePresent(vaultTtlUrl(zone), podRoot))) return null;
  const ttl = await readFileText(vaultTtlUrl(zone));
  return parseVaultTtl(ttl);
}

/** Create a fresh vault on the pod: calibrate KDF, createVault, write vault.ttl + items/. */
export async function createVaultOnPod(
  core: AsyncCryptoCore,
  zone: string,
  podRoot: string,
  masterPw: string
): Promise<LoadedVault> {
  const params = await core.calibrateKdf(750);
  const bootstrap = await core.createVault(masterPw, params);
  const vault: LoadedVault = {
    bootstrap,
    schemaVersion: VAULT_SCHEMA_VERSION,
    index: [],
  };
  // Create the zone + items container (and any missing parents like apps/),
  // walking listed containers so a fresh pod doesn't 404 on the way down.
  await ensureContainerChain(itemsContainer(zone), podRoot);
  await writeVaultTtl(zone, vault);
  return vault;
}

async function writeVaultTtl(zone: string, vault: LoadedVault): Promise<void> {
  await writeFileText(vaultTtlUrl(zone), serializeVaultTtl(vault), "text/turtle");
}

/**
 * Encrypt + persist an item. Bumps the AAD version, encrypts the secret JSON,
 * writes the opaque .enc blob, then updates + rewrites the non-secret index.
 * `vault` is the in-memory cache; this mutates its index and returns the saved meta.
 */
export async function saveItem(
  core: AsyncCryptoCore,
  zone: string,
  handle: SessionHandle,
  vault: LoadedVault,
  meta: VaultItemMeta,
  secret: VaultItemSecret
): Promise<VaultItemMeta> {
  const nextVersion = meta.version + 1;
  const saved: VaultItemMeta = {
    ...meta,
    version: nextVersion,
    updatedAt: new Date().toISOString(),
  };
  const plaintextJson = JSON.stringify(secret);
  const sealed = await core.encryptItem(handle, saved.id, saved.version, plaintextJson);
  await writeFileBlob(itemUrl(zone, saved.id), packSealed(sealed), "application/octet-stream");

  const i = vault.index.findIndex((m) => m.id === saved.id);
  if (i >= 0) vault.index[i] = saved;
  else vault.index.push(saved);
  await writeVaultTtl(zone, vault);
  return saved;
}

/** Read + decrypt an item's secret payload. */
export async function loadItemSecret(
  core: AsyncCryptoCore,
  zone: string,
  handle: SessionHandle,
  meta: VaultItemMeta
): Promise<VaultItemSecret> {
  const blob = await readFileBlob(itemUrl(zone, meta.id));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sealed = unpackSealed(bytes);
  const json = await core.decryptItem(handle, meta.id, meta.version, sealed);
  return JSON.parse(json) as VaultItemSecret;
}

/** Delete an item: remove the .enc blob and drop it from the index. */
export async function deleteItem(
  zone: string,
  vault: LoadedVault,
  id: string
): Promise<void> {
  try {
    await unlink(itemUrl(zone, id));
  } catch {
    /* already gone — still drop from index */
  }
  vault.index = vault.index.filter((m) => m.id !== id);
  await writeVaultTtl(zone, vault);
}

/**
 * Change the master password: re-derive + RE-WRAP the data key only (bulk
 * ciphertext untouched), then rewrite vault.ttl's bootstrap. Items are not
 * re-encrypted. Returns the updated vault cache.
 */
export async function changeMasterPassword(
  core: AsyncCryptoCore,
  zone: string,
  handle: SessionHandle,
  vault: LoadedVault,
  newPw: string
): Promise<LoadedVault> {
  const params = await core.calibrateKdf(750);
  const bootstrap = await core.changePassword(handle, newPw, params);
  vault.bootstrap = bootstrap;
  await writeVaultTtl(zone, vault);
  return vault;
}

/** Stable id for a new item. */
export function newItemId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `it-${rand}`;
}
