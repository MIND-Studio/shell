"use client";

/**
 * Home — a workspace's default surface (PRD-DASHBOARD §1/§9). It is the shell's
 * own in-process *grid container*; every TILE inside it is an app's widget hosted
 * in a sandboxed iframe under the capability bridge (see {@link WidgetTile}). So
 * Home itself is shell code, but it contains NO app widget code — that all lives
 * behind the iframe boundary, served by each app from its own origin.
 *
 * Layout (tile order + size) persists per workspace in `apps/shell/home.ttl`
 * ({@link readHomeLayout}/{@link writeHomeLayout}). With none stored, Home derives
 * a default: every enabled app's first declared widget. With no widgets at all,
 * Home is a launcher (app tiles that open their app) so it's never a dead end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/lib/shell/context";
import { WidgetTile, widgetColSpan } from "@/components/shell/WidgetTile";
import { readHomeLayout, writeHomeLayout } from "@/lib/shell/home-layout";
import type { HostedApp, WidgetDecl, HomeLayoutItem } from "@/lib/shell/types";

/** Default Home: every enabled app's FIRST declared widget (PRD-DASHBOARD §8b). */
function defaultLayout(apps: HostedApp[]): HomeLayoutItem[] {
  const items: HomeLayoutItem[] = [];
  for (const app of apps) {
    if (app.key === "__home__" || !app.enabled) continue;
    const w = app.widgets?.[0];
    if (!w) continue;
    items.push({ ref: `${app.key}#${w.id}`, order: items.length, size: w.size });
  }
  return items;
}

/** Resolve an `"appKey#widgetId"` ref against the live app list. */
function resolveRef(
  ref: string,
  apps: HostedApp[]
): { app: HostedApp; widget: WidgetDecl } | null {
  const i = ref.indexOf("#");
  if (i < 0) return null;
  const app = apps.find((a) => a.key === ref.slice(0, i));
  const widget = app?.widgets?.find((w) => w.id === ref.slice(i + 1));
  return app && widget ? { app, widget } : null;
}

export default function HomeApp() {
  const { apps, workspacePod, setActiveApp } = useShell();
  // null = still loading the layout; [] = loaded, no tiles.
  const [items, setItems] = useState<HomeLayoutItem[] | null>(null);
  const dragIndex = useRef<number | null>(null);

  // Load the persisted layout for the active workspace, falling back to the
  // default. Dropped refs (a widget that no longer exists) are filtered out; any
  // newly-shipped default widget not already placed is APPENDED — without an
  // add/remove picker yet (P3), a saved layout shouldn't permanently hide a freshly
  // added app widget. (Reorder still persists; the merge is idempotent per load.)
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    (async () => {
      const stored = workspacePod ? await readHomeLayout(workspacePod) : null;
      if (cancelled) return;
      const usable = stored?.filter((it) => resolveRef(it.ref, apps)) ?? [];
      const have = new Set(usable.map((it) => it.ref));
      const additions = defaultLayout(apps).filter((it) => !have.has(it.ref));
      const merged = [...usable, ...additions].map((it, i) => ({ ...it, order: i }));
      setItems(merged.length ? merged : defaultLayout(apps));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePod, apps]);

  const persist = useCallback(
    (next: HomeLayoutItem[]) => {
      const renumbered = next.map((it, i) => ({ ...it, order: i }));
      setItems(renumbered);
      if (workspacePod) void writeHomeLayout(workspacePod, renumbered).catch(() => {});
    },
    [workspacePod]
  );

  const onDrop = useCallback(
    (target: number) => {
      const from = dragIndex.current;
      dragIndex.current = null;
      if (from == null || from === target || !items) return;
      const next = items.slice();
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      persist(next);
    },
    [items, persist]
  );

  const tiles = useMemo(
    () =>
      (items ?? [])
        .map((it) => ({ it, r: resolveRef(it.ref, apps) }))
        .filter((t): t is { it: HomeLayoutItem; r: NonNullable<typeof t.r> } => !!t.r),
    [items, apps]
  );

  if (items === null) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-sm text-muted-foreground">Loading Home…</p>
      </div>
    );
  }

  // No widgets anywhere → a launcher so Home is never empty/dead.
  if (tiles.length === 0) {
    const launchable = apps.filter((a) => a.enabled && a.key !== "__home__");
    return (
      <div className="h-full overflow-auto p-6">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-lg font-semibold">Home</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            No widgets yet. Open an app to get started.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {launchable.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setActiveApp(a.key)}
                className="flex flex-col items-center gap-2 rounded-2xl border border-[color:var(--border)] bg-card p-5 text-center transition hover:bg-accent"
              >
                <span className="text-2xl">{a.icon}</span>
                <span className="text-sm font-medium">{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-lg font-semibold">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drag tiles to rearrange. Each widget is sandboxed in its app.
        </p>
        {/* One column on phones — two fixed columns crush 1-col tiles to ~140px. */}
        <div className="mt-5 grid auto-rows-min grid-cols-1 gap-4 sm:grid-cols-2">
          {tiles.map(({ it, r }, idx) => (
            <div
              key={it.ref}
              draggable
              onDragStart={() => {
                dragIndex.current = idx;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(idx)}
              className={widgetColSpan(it.size) === 2 ? "sm:col-span-2" : undefined}
            >
              <WidgetTile app={r.app} widget={r.widget} size={it.size} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
