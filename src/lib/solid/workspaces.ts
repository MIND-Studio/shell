"use client";

import {
  getSolidDataset,
  createSolidDataset,
  saveSolidDatasetAt,
  getThingAll,
  getUrl,
  getUrlAll,
  getStringNoLocale,
  setThing,
  removeThing,
  buildThing,
  createThing,
} from "@inrupt/solid-client";
import { getPlatform } from "@/lib/platform";
import { resourceExistsByListing } from "@/lib/solid/pod-fs";
import { shellZone } from "@/lib/shell/types";
import type { WorkspaceRef, WorkspaceRole } from "@/lib/shell/types";

/**
 * The per-identity Workspace index (PRD-IDENTITY.md §4 — "Mechanism A").
 *
 * The shell authenticates as a WebID via Solid-OIDC; it does NOT hold a CSS
 * *account* session, so it cannot enumerate "every pod this account owns" via the
 * account API (§4.1). Instead we keep a small pod-hosted index of `WorkspaceRef`s
 * the identity owns or has joined. This is OIDC-native, spans servers, covers
 * *joined* (not just owned) workspaces, and is DID-ready: in Phase C the index
 * relocates to an identity-scoped location without changing this shape (§4.2).
 *
 * v0 location: `{homePod}apps/shell/workspaces.ttl` — inside the shell's own zone.
 * Reads are 404-tolerant (missing index → []); `context.tsx` then bootstraps a
 * single home-pod entry in memory and the index is written on the first add.
 */

const MIND = "https://mind.dev/ns/v1#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MIND_WORKSPACE_REF = `${MIND}WorkspaceRef`;
const MIND_REGISTRY = `${MIND}WorkspaceRegistry`;
const MIND_POD_ROOT = `${MIND}podRoot`;
const MIND_ROLE = `${MIND}role`;
const DCT_TITLE = "http://purl.org/dc/terms/title";

const ROLES: readonly WorkspaceRole[] = ["owner", "member", "guest"];

function indexUrl(homePod: string): string {
  return `${shellZone(homePod)}workspaces.ttl`;
}

export function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

/** Authenticated fetch with no-store so we don't read a stale index after a write. */
async function noStoreFetch(): Promise<typeof fetch> {
  const inner = (await getPlatform()).pod.fetch;
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    inner(url, { ...init, cache: "no-store" })) as typeof fetch;
}

function asRole(value: string | null): WorkspaceRole {
  return value && (ROLES as readonly string[]).includes(value)
    ? (value as WorkspaceRole)
    : "owner";
}

/**
 * Read the Workspace index for an identity's home pod. Tolerant of a missing
 * index (or no access) — returns `[]`, leaving the caller to bootstrap.
 */
export async function listWorkspaceRefs(homePod: string): Promise<WorkspaceRef[]> {
  // Gate the GET on a container-listing walk so a fresh pod with no index yet
  // doesn't 404 in the console (the browser logs caught 404s). Common now that
  // switching to a freshly-provisioned passport lands on an empty pod (C4).
  if (!(await resourceExistsByListing(indexUrl(homePod), homePod))) return [];
  let ds;
  try {
    ds = await getSolidDataset(indexUrl(homePod), { fetch: await noStoreFetch() });
  } catch {
    return [];
  }
  const refs: WorkspaceRef[] = [];
  for (const thing of getThingAll(ds)) {
    if (!getUrlAll(thing, RDF_TYPE).includes(MIND_WORKSPACE_REF)) continue;
    const podRoot = getUrl(thing, MIND_POD_ROOT);
    if (!podRoot) continue;
    refs.push({
      podRoot: ensureSlash(podRoot),
      role: asRole(getStringNoLocale(thing, MIND_ROLE)),
      name: getStringNoLocale(thing, DCT_TITLE) ?? undefined,
    });
  }
  return refs;
}

/**
 * Add (or replace, keyed by podRoot) a Workspace entry, creating the index on
 * first use. The index is the source of truth (the pod, not localStorage), so
 * additions survive reload — PRD-IDENTITY.md §4.6 acceptance criteria.
 */
export async function addWorkspaceRef(homePod: string, ref: WorkspaceRef): Promise<void> {
  const url = indexUrl(homePod);
  const podRoot = ensureSlash(ref.podRoot);

  let ds;
  try {
    ds = await getSolidDataset(url, { fetch: await noStoreFetch() });
  } catch {
    ds = createSolidDataset();
  }

  // De-dupe: drop any existing ref for the same pod.
  for (const thing of getThingAll(ds)) {
    if (
      getUrlAll(thing, RDF_TYPE).includes(MIND_WORKSPACE_REF) &&
      getUrl(thing, MIND_POD_ROOT) === podRoot
    ) {
      ds = removeThing(ds, thing);
    }
  }

  let builder = buildThing(createThing())
    .addUrl(RDF_TYPE, MIND_WORKSPACE_REF)
    .addUrl(MIND_POD_ROOT, podRoot)
    .addStringNoLocale(MIND_ROLE, ref.role);
  if (ref.name) builder = builder.addStringNoLocale(DCT_TITLE, ref.name);

  ds = setThing(ds, builder.build());
  await saveSolidDatasetAt(url, ds, { fetch: (await getPlatform()).pod.fetch });
}

/**
 * Ensure the identity's personal (home) pod is recorded in the index as an owner
 * Workspace. The home entry is otherwise only ever an in-memory bootstrap
 * (`context.tsx` synthesizes it when the index is empty) and never persisted, so
 * the first time we add *another* workspace the index would contain only that
 * other pod — losing the personal one. Call this before adding a sibling so the
 * index is always self-contained. No-op if home is already present.
 */
export async function ensureHomeRef(homePod: string): Promise<void> {
  const home = ensureSlash(homePod);
  const refs = await listWorkspaceRefs(home);
  if (refs.some((r) => ensureSlash(r.podRoot) === home)) return;
  await addWorkspaceRef(home, { podRoot: home, role: "owner" });
}

/** Remove a Workspace entry by pod root. No-op if absent. */
export async function removeWorkspaceRef(homePod: string, podRoot: string): Promise<void> {
  const url = indexUrl(homePod);
  const target = ensureSlash(podRoot);
  let ds;
  try {
    ds = await getSolidDataset(url, { fetch: await noStoreFetch() });
  } catch {
    return;
  }
  let changed = false;
  for (const thing of getThingAll(ds)) {
    if (
      getUrlAll(thing, RDF_TYPE).includes(MIND_WORKSPACE_REF) &&
      getUrl(thing, MIND_POD_ROOT) === target
    ) {
      ds = removeThing(ds, thing);
      changed = true;
    }
  }
  if (changed) {
    await saveSolidDatasetAt(url, ds, { fetch: (await getPlatform()).pod.fetch });
  }
}

// `MIND_REGISTRY` is reserved for a future `<#registry> mind:workspace …` anchor
// (PRD-IDENTITY.md §4.3); refs are currently discovered by rdf:type alone.
void MIND_REGISTRY;
