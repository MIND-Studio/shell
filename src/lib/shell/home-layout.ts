"use client";

/**
 * Home layout persistence (PRD-DASHBOARD §8b). The order + size of a workspace's
 * Home tiles live in the shell's own state zone at `{podRoot}apps/shell/home.ttl`
 * — shell-owned chrome state, NOT app data, so it sits in `apps/shell/` like the
 * rest of the shell's state (layout.ttl, recents.ttl).
 *
 * Hand-written + parsed Turtle (the same robust block-split approach as
 * `src/lib/vault/model.ts`), using the listing-gated pod-fs helpers so a fresh
 * pod neither 404s nor logs on the read path. v0 persists the workspace-wide Home;
 * project-scoped layouts are a P3 follow-on.
 *
 * Nothing here is secret — it stores widget *references* (`appKey#widgetId`),
 * order, and size. No widget content ever passes through this file.
 */

import {
  ensureContainerChain,
  readFileText,
  resourceExistsByListing,
  writeFileText,
} from "@/lib/solid/pod-fs";
import type { HomeLayoutItem, WidgetSize } from "./types";
import { shellZone } from "./types";

const MIND_NS = "https://mind.dev/ns/v1#";

function homeTtlUrl(podRoot: string): string {
  return `${shellZone(podRoot)}home.ttl`;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function unesc(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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

function asSize(v: string | undefined): WidgetSize | undefined {
  return v === "s" || v === "m" || v === "l" ? v : undefined;
}

function serializeHomeTtl(items: HomeLayoutItem[]): string {
  const lines: string[] = [];
  lines.push(`@prefix mind: <${MIND_NS}> .`);
  lines.push("");
  lines.push(`<#home> a mind:HomeLayout .`);
  lines.push("");
  items.forEach((it, i) => {
    lines.push(`<#item-${i}> a mind:HomeItem ;`);
    lines.push(`  mind:ref "${esc(it.ref)}" ;`);
    lines.push(`  mind:order ${it.order} ;`);
    lines.push(`  mind:size "${esc(it.size)}" .`);
    lines.push("");
  });
  return lines.join("\n");
}

function parseHomeTtl(ttl: string): HomeLayoutItem[] {
  const blocks = ttl
    .split(/(?=<#)/)
    .map((b) => b.trim())
    .filter(Boolean);
  const items: HomeLayoutItem[] = [];
  for (const block of blocks) {
    if (!block.startsWith("<#item-")) continue;
    const ref = literal(block, "ref");
    const order = intLit(block, "order");
    const size = asSize(literal(block, "size"));
    if (ref && order != null && size) items.push({ ref, order, size });
  }
  items.sort((a, b) => a.order - b.order);
  return items;
}

/**
 * Read the persisted Home layout for a workspace, or `null` when none exists yet
 * (so the caller can fall back to a default Home). Never throws — any read error
 * resolves to `null` and Home renders its default.
 */
export async function readHomeLayout(podRoot: string): Promise<HomeLayoutItem[] | null> {
  try {
    const url = homeTtlUrl(podRoot);
    if (!(await resourceExistsByListing(url, podRoot))) return null;
    return parseHomeTtl(await readFileText(url));
  } catch {
    return null;
  }
}

/**
 * Persist the Home layout, creating `apps/shell/` (and any missing parent) first
 * so a fresh pod stays console-clean. Re-numbers `order` from the array order so
 * the on-pod order is always canonical.
 */
export async function writeHomeLayout(podRoot: string, items: HomeLayoutItem[]): Promise<void> {
  const normalized = items.map((it, i) => ({ ...it, order: i }));
  await ensureContainerChain(shellZone(podRoot), podRoot);
  await writeFileText(homeTtlUrl(podRoot), serializeHomeTtl(normalized), "text/turtle");
}
