"use client";

import type { SolidDataset } from "@inrupt/solid-client";
import {
  getInteger,
  getSolidDataset,
  getStringNoLocale,
  getThingAll,
  getUrl,
} from "@inrupt/solid-client";
import { resourceExistsByListing } from "@/lib/solid/pod-fs";
import type { AppEmbed, AppTrust, HostedApp, WidgetDecl, WidgetSize } from "./types";

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
// Widget predicates (PRD-DASHBOARD §8). A widget is its own `mind:Widget` thing
// linked back to its app by `mind:app "<appKey>"` — solid-client's named-node API
// reads this cleanly (vs. the spec's blank-node sugar), and the seed writer in
// `@mind-studio/core` is the only producer, so the shape is ours to settle on.
const MIND_WIDGET = `${VOC}Widget`;
const MIND_APP_REF = `${VOC}app`;
const MIND_ID = `${VOC}id`;
const MIND_SIZE = `${VOC}size`;
const MIND_MAXSIZE = `${VOC}maxSize`;
const MIND_SCOPE = `${VOC}scope`;

function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

function asEmbed(v: string | null): AppEmbed | undefined {
  return v === "iframe" || v === "inprocess" || v === "link" ? v : undefined;
}

function asTrust(v: string | null): AppTrust | undefined {
  return v === "first-party" || v === "community" || v === "untrusted" ? v : undefined;
}

function asSize(v: string | null): WidgetSize | undefined {
  return v === "s" || v === "m" || v === "l" ? v : undefined;
}

/**
 * Collect every `mind:Widget` thing in the dataset, grouped by its owning app key
 * (`mind:app`). A widget needs an id + a render URL to be usable; malformed ones
 * are skipped. Never throws — a bad widget just doesn't appear on Home.
 */
function collectWidgets(ds: SolidDataset): Map<string, WidgetDecl[]> {
  const byApp = new Map<string, WidgetDecl[]>();
  for (const thing of getThingAll(ds)) {
    const types = thing.predicates[RDF_TYPE]?.namedNodes ?? [];
    if (!types.includes(MIND_WIDGET)) continue;
    const appKey = getStringNoLocale(thing, MIND_APP_REF);
    const id = getStringNoLocale(thing, MIND_ID);
    const url = getStringNoLocale(thing, MIND_URL) ?? getUrl(thing, MIND_URL) ?? undefined;
    if (!appKey || !id || !url) continue;
    const decl: WidgetDecl = {
      id,
      label: getStringNoLocale(thing, MIND_LABEL) ?? id,
      icon: getStringNoLocale(thing, MIND_ICON) ?? "▦",
      size: asSize(getStringNoLocale(thing, MIND_SIZE)) ?? "m",
      maxSize: asSize(getStringNoLocale(thing, MIND_MAXSIZE)),
      scope: getStringNoLocale(thing, MIND_SCOPE) ?? "",
      url,
      trust: asTrust(getStringNoLocale(thing, MIND_TRUST)),
    };
    const list = byApp.get(appKey) ?? [];
    list.push(decl);
    byApp.set(appKey, list);
  }
  return byApp;
}

/**
 * Returns the catalog entries, or `[]` when there's no `apps.ttl` yet / it can't
 * be read. Gated on a container listing so a fresh pod doesn't 404 (and log).
 * Never throws — the shell falls back to its built-ins on any failure.
 */
export async function readCatalog(podRoot: string, fetchFn: typeof fetch): Promise<HostedApp[]> {
  const base = ensureSlash(podRoot);
  const docUrl = `${base}home/apps.ttl`;
  try {
    if (!(await resourceExistsByListing(docUrl, base))) return [];
    const ds = await getSolidDataset(docUrl, {
      fetch: ((url: RequestInfo | URL, init?: RequestInit) =>
        fetchFn(url, { ...init, cache: "no-store" })) as typeof fetch,
    });
    const widgetsByApp = collectWidgets(ds);
    const rows: { app: HostedApp; order: number }[] = [];
    for (const thing of getThingAll(ds)) {
      const types = thing.predicates[RDF_TYPE]?.namedNodes ?? [];
      if (!types.includes(MIND_APP)) continue;
      const hash = thing.url.indexOf("#");
      const key = hash >= 0 ? thing.url.slice(hash + 1) : thing.url.slice(base.length);
      if (!key) continue;
      const url = getStringNoLocale(thing, MIND_URL) ?? getUrl(thing, MIND_URL) ?? undefined;
      rows.push({
        app: {
          key,
          label: getStringNoLocale(thing, MIND_LABEL) ?? key,
          icon: getStringNoLocale(thing, MIND_ICON) ?? "▦",
          url: url ?? undefined,
          enabled: true,
          embed: asEmbed(getStringNoLocale(thing, MIND_EMBED)),
          trust: asTrust(getStringNoLocale(thing, MIND_TRUST)),
          widgets: widgetsByApp.get(key),
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
