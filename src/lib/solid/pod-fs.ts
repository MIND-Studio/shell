"use client";

import {
  getSolidDataset,
  getContainedResourceUrlAll,
  getThing,
  getDatetime,
  getInteger,
  deleteFile,
  deleteContainer,
  overwriteFile,
  getFile,
  createContainerAt,
  getSourceUrl,
  getContentType,
} from "@inrupt/solid-client";
import { getPlatform } from "@/lib/platform";

/**
 * POSIX-shaped wrappers around the Solid LDP HTTP API (ported from the sibling
 * prototypes). Shell + Vault both read/write the pod through here.
 *
 * The authenticated `fetch` is sourced from the platform abstraction
 * (PRD-NATIVE.md §3.1): on web it's the browser Solid SDK's `session().fetch`
 * (unchanged); on native it's a shim over the Rust `pod_fetch` command that signs
 * each request with the in-process DPoP key — the token never enters the webview
 * (HARD rule #1). pod-fs is otherwise platform-agnostic.
 *
 * Solid-protocol limits we accept (not ours to fix):
 *   - LDP PUT replaces the whole resource. Write is whole-file only.
 *   - No native move / rename — `rename` here = copy + unlink (ACLs don't follow).
 *   - `deleteContainer` errors if non-empty; `rmrf` walks the tree first.
 *   - `readdir()` is one level deep.
 *   - Default Content-Type is application/octet-stream — always pass it.
 */

export type PodEntry = {
  url: string;
  name: string;
  kind: "container" | "resource";
  modified?: Date;
  size?: number;
  contentType?: string;
};

async function authedFetch(): Promise<typeof fetch> {
  const platform = await getPlatform();
  return platform.pod.fetch;
}

function ensureSlash(u: string) {
  return u.endsWith("/") ? u : u + "/";
}

function basename(url: string, parent: string): string {
  const tail = url.slice(parent.length);
  if (tail.endsWith("/")) return tail.slice(0, -1);
  return tail;
}

/**
 * Wrap the authenticated fetch with `cache: 'no-store'` so CSS containment
 * triples aren't served stale after a write. (On native the Rust pod_fetch
 * never caches, so `cache` is a harmless no-op there.)
 */
async function noCacheFetch(): Promise<typeof fetch> {
  const inner = await authedFetch();
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    inner(url, { ...init, cache: "no-store" })) as typeof fetch;
}

export async function readdir(containerUrl: string): Promise<PodEntry[]> {
  const parent = ensureSlash(containerUrl);
  const dataset = await getSolidDataset(parent, { fetch: await noCacheFetch() });
  const urls = getContainedResourceUrlAll(dataset);
  return urls
    .map((url): PodEntry => {
      const isContainer = url.endsWith("/");
      const thing = getThing(dataset, url);
      const modified = thing
        ? getDatetime(thing, "http://purl.org/dc/terms/modified") ?? undefined
        : undefined;
      const size = thing
        ? getInteger(thing, "http://www.w3.org/ns/posix/stat#size") ?? undefined
        : undefined;
      return {
        url,
        name: basename(url, parent),
        kind: isContainer ? "container" : "resource",
        modified: modified ?? undefined,
        size: size ?? undefined,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "container" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** True if the container exists (200), false on 404. Rethrows other errors. */
export async function exists(url: string): Promise<boolean> {
  try {
    await getSolidDataset(url, { fetch: await noCacheFetch() });
    return true;
  } catch (e: unknown) {
    const status = (e as { statusCode?: number; response?: { status?: number } })
      ?.statusCode ?? (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    // 401/403 etc. — surface to caller.
    throw e;
  }
}

export async function readFileText(url: string): Promise<string> {
  const blob = await getFile(url, { fetch: await authedFetch() });
  return await blob.text();
}

export async function readFileBlob(url: string): Promise<Blob> {
  return await getFile(url, { fetch: await authedFetch() });
}

export async function writeFileText(
  url: string,
  contents: string,
  contentType = "text/plain"
): Promise<void> {
  await overwriteFile(url, new Blob([contents], { type: contentType }), {
    contentType,
    fetch: await authedFetch(),
  });
}

export async function writeFileBlob(
  url: string,
  blob: Blob,
  contentType?: string
): Promise<string> {
  const type = contentType ?? blob.type ?? "application/octet-stream";
  const result = await overwriteFile(url, blob, {
    contentType: type,
    fetch: await authedFetch(),
  });
  return getSourceUrl(result) ?? url;
}

export async function unlink(url: string): Promise<void> {
  if (url.endsWith("/")) {
    await deleteContainer(url, { fetch: await authedFetch() });
  } else {
    await deleteFile(url, { fetch: await authedFetch() });
  }
}

export async function mkdir(url: string): Promise<string> {
  const target = ensureSlash(url);
  const result = await createContainerAt(target, { fetch: await authedFetch() });
  return getSourceUrl(result) ?? target;
}

/**
 * Ensure every container from `podRoot` down to (and including) `container`
 * exists, creating ONLY the missing levels. Walks via container listings so it
 * never issues a request that 404s/409s (the browser logs those even when caught
 * in JS — the cause of console noise on a "create the zone" path). `container`
 * should be under `podRoot`; falls back to an existence check otherwise.
 */
export async function ensureContainerChain(
  container: string,
  podRoot: string
): Promise<void> {
  const base = ensureSlash(podRoot);
  if (!container.startsWith(base)) {
    if (!(await exists(container))) await mkdir(container);
    return;
  }
  const segments = container.slice(base.length).split("/").filter(Boolean);
  let current = base; // always exists
  for (const seg of segments) {
    let entries: PodEntry[] = [];
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

/**
 * True if `resourceUrl` exists, decided by walking container listings from
 * `podRoot` down — so it NEVER issues a request that 404s (the browser logs
 * caught 404s, which is the source of console noise when landing on a fresh pod
 * that lacks an expected file). Returns false the moment any level on the path is
 * missing. `resourceUrl` should be under `podRoot`; falls back to {@link exists}
 * (which may log) when it isn't.
 */
export async function resourceExistsByListing(
  resourceUrl: string,
  podRoot: string
): Promise<boolean> {
  const base = ensureSlash(podRoot);
  if (!resourceUrl.startsWith(base)) return exists(resourceUrl);
  const parts = resourceUrl.slice(base.length).split("/").filter(Boolean);
  if (parts.length === 0) return true;
  let current = base; // always exists
  for (let i = 0; i < parts.length; i++) {
    let entries: PodEntry[];
    try {
      entries = await readdir(current);
    } catch {
      return false;
    }
    const seg = parts[i];
    if (i === parts.length - 1) {
      return entries.some((e) => e.name === seg);
    }
    if (!entries.some((e) => e.kind === "container" && e.name === seg)) return false;
    current = `${current}${seg}/`;
  }
  return true;
}

/**
 * Recursive delete. LDP `deleteContainer` returns 409 if non-empty, so we
 * depth-first delete every descendant first.
 */
export async function rmrf(url: string): Promise<void> {
  if (!url.endsWith("/")) {
    await unlink(url);
    return;
  }
  const entries = await readdir(url);
  for (const entry of entries) {
    await rmrf(entry.url);
  }
  await unlink(url);
}

export function parentOf(url: string, root: string): string | null {
  if (url === root) return null;
  const stripped = url.endsWith("/") ? url.slice(0, -1) : url;
  const i = stripped.lastIndexOf("/");
  if (i < 0) return null;
  const parent = stripped.slice(0, i + 1);
  if (!parent.startsWith(root)) return root;
  return parent;
}

export { getContentType };
