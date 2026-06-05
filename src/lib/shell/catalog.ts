"use client";

import {
  getSolidDataset,
  getThingAll,
  getStringNoLocale,
  getInteger,
  getUrl,
} from "@inrupt/solid-client";
import { resourceExistsByListing } from "@/lib/solid/pod-fs";
import type { HostedApp, AppEmbed, AppTrust } from "./types";

/**
 * Read the pod-owned app catalog at `{podRoot}home/apps.ttl` (PRD-APPS §4) into
 * `HostedApp[]`, INCLUDING the new hosting predicates `mind:embed` / `mind:trust`.
 *
 * This is the shell's own read path. The shared `@mind-studio/core` launcher
 * writes/reads the same file (label/url/icon/order) for the waffle, but its
 * `AppEntry` type doesn't carry embed/trust — so the shell parses the Turtle
 * itself to learn which apps it can *host* (vs. merely link to). Read-only:
 * seeding + writing stay in core (no `sync.sh` tarball churn).
 *
 * Vocab matches core's `registry.ts`: `http://mind.example/voc#`.
 */

const VOC = "http://mind.example/voc#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MIND_APP = `${VOC}App`;
const MIND_LABEL = `${VOC}label`;
const MIND_URL = `${VOC}url`;
const MIND_ICON = `${VOC}icon`;
const MIND_ORDER = `${VOC}order`;
const MIND_EMBED = `${VOC}embed`;
const MIND_TRUST = `${VOC}trust`;

function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

function asEmbed(v: string | null): AppEmbed | undefined {
  return v === "iframe" || v === "inprocess" || v === "link" ? v : undefined;
}

function asTrust(v: string | null): AppTrust | undefined {
  return v === "first-party" || v === "community" || v === "untrusted"
    ? v
    : undefined;
}

/**
 * Returns the catalog entries, or `[]` when there's no `apps.ttl` yet / it can't
 * be read. Gated on a container listing so a fresh pod doesn't 404 (and log).
 * Never throws — the shell falls back to its built-ins on any failure.
 */
export async function readCatalog(
  podRoot: string,
  fetchFn: typeof fetch
): Promise<HostedApp[]> {
  const base = ensureSlash(podRoot);
  const docUrl = `${base}home/apps.ttl`;
  try {
    if (!(await resourceExistsByListing(docUrl, base))) return [];
    const ds = await getSolidDataset(docUrl, {
      fetch: ((url: RequestInfo | URL, init?: RequestInit) =>
        fetchFn(url, { ...init, cache: "no-store" })) as typeof fetch,
    });
    const rows: { app: HostedApp; order: number }[] = [];
    for (const thing of getThingAll(ds)) {
      const types = thing.predicates[RDF_TYPE]?.namedNodes ?? [];
      if (!types.includes(MIND_APP)) continue;
      const hash = thing.url.indexOf("#");
      const key =
        hash >= 0 ? thing.url.slice(hash + 1) : thing.url.slice(base.length);
      if (!key) continue;
      const url =
        getStringNoLocale(thing, MIND_URL) ?? getUrl(thing, MIND_URL) ?? undefined;
      rows.push({
        app: {
          key,
          label: getStringNoLocale(thing, MIND_LABEL) ?? key,
          icon: getStringNoLocale(thing, MIND_ICON) ?? "▦",
          url: url ?? undefined,
          enabled: true,
          embed: asEmbed(getStringNoLocale(thing, MIND_EMBED)),
          trust: asTrust(getStringNoLocale(thing, MIND_TRUST)),
        },
        order: getInteger(thing, MIND_ORDER) ?? 0,
      });
    }
    rows.sort((a, b) => a.order - b.order);
    return rows.map((r) => r.app);
  } catch {
    return [];
  }
}
