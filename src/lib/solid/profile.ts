"use client";

import {
  getSolidDataset,
  getThing,
  getStringNoLocale,
  getUrl,
} from "@inrupt/solid-client";
import { getPlatform } from "@/lib/platform";
import type { AccountIdentity } from "@/lib/shell/types";

const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";
const VCARD_FN = "http://www.w3.org/2006/vcard/ns#fn";
const FOAF_IMG = "http://xmlns.com/foaf/0.1/img";
const VCARD_PHOTO = "http://www.w3.org/2006/vcard/ns#hasPhoto";
const SOLID_STORAGE = "http://www.w3.org/ns/pim/space#storage";

/** Path segments that are WebID-document boilerplate, never a useful label. */
const BOILERPLATE = new Set(["profile", "card", "me", "index", "ttl"]);

/**
 * Last-resort human label for a WebID when the profile has no foaf:name/vcard:fn.
 * Strips the fragment and the `profile/card` boilerplate so a WebID like
 * `https://pod.example/alice/profile/card#me` yields `alice`, not `card#me`.
 * Falls back to the host if nothing meaningful remains.
 */
export function webIdLabel(webId: string): string {
  try {
    const u = new URL(webId);
    const seg = u.pathname
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s && !BOILERPLATE.has(s.toLowerCase()));
    return seg[seg.length - 1] ?? u.hostname;
  } catch {
    // Not a parseable URL — strip a trailing #fragment and take the last segment.
    const noFrag = webId.split("#")[0];
    return noFrag.split("/").filter(Boolean).pop() ?? webId;
  }
}

/** Read display name + avatar + (best-effort) pod root for a WebID. */
export async function readProfile(webId: string): Promise<AccountIdentity> {
  const fetchFn = (await getPlatform()).pod.fetch;
  try {
    const ds = await getSolidDataset(webId, { fetch: fetchFn });
    const me = getThing(ds, webId);
    const displayName =
      (me && (getStringNoLocale(me, FOAF_NAME) ?? getStringNoLocale(me, VCARD_FN))) ??
      webIdLabel(webId);
    const avatarUrl =
      (me && (getUrl(me, VCARD_PHOTO) ?? getUrl(me, FOAF_IMG))) ?? undefined;
    return { webId, displayName: displayName ?? undefined, avatarUrl: avatarUrl ?? undefined };
  } catch {
    return { webId, displayName: webIdLabel(webId) };
  }
}

/**
 * Best-effort pod (workspace) root for a WebID: the `pim:storage` link in the
 * profile, falling back to the WebID's origin + first path segment.
 */
export async function readPodRoot(webId: string): Promise<string | null> {
  const fetchFn = (await getPlatform()).pod.fetch;
  try {
    const ds = await getSolidDataset(webId, { fetch: fetchFn });
    const me = getThing(ds, webId);
    const storage = me ? getUrl(me, SOLID_STORAGE) : null;
    if (storage) return storage.endsWith("/") ? storage : storage + "/";
  } catch {}
  try {
    const u = new URL(webId);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg) return `${u.origin}/${seg}/`;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}
