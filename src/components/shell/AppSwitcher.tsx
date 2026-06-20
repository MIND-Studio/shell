"use client";

import { type AppEntry, DEFAULT_APPS, readApps } from "@mind-studio/core/apps";
import { MindAppLauncher } from "@mind-studio/core/launcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mind-studio/ui";
import { useEffect, useState } from "react";
import { useShell } from "@/lib/shell/context";
import { resourceExistsByListing } from "@/lib/solid/pod-fs";

/**
 * The current-app label + the app-switcher "waffle" (wireframe "👤 Drive [⊞]").
 *
 * Two ways to jump apps without leaving the shell:
 *   - the built-in (in-process) apps — clicking one calls `setActiveApp(key)` so
 *     it renders right here in the app body;
 *   - the external sibling apps — opened by `MindAppLauncher` (the shared waffle),
 *     which links out to their hosted subdomains.
 *
 * We compute the waffle list HERE and pass it to the launcher as an explicit
 * `apps` prop, instead of letting the launcher's own `ensureSeeded` read+write
 * the pod. Two reasons: (1) `ensureSeeded` lazily WRITES `home/apps.ttl`, which
 * under React StrictMode's double-invoke races itself (one create wins, the
 * other 412s and throws) and leaves the waffle stuck on loading skeletons on a
 * fresh/unseeded pod; (2) we don't want to write to the user's pod just to show
 * a launcher. So: gated, read-only catalog read → the user's own list when it
 * exists, the shipped `DEFAULT_APPS` otherwise. No blind GET (the gate lists the
 * container first), no write, no skeleton-lock.
 */
export function AppSwitcher() {
  const { apps, activeAppKey, setActiveApp, workspacePod, fetch: podFetch } = useShell();

  // The waffle's tiles. Seeded with the shipped suite so it renders instantly
  // (no skeleton flash), then upgraded to the pod's own list if one exists.
  const [waffleApps, setWaffleApps] = useState<AppEntry[]>(DEFAULT_APPS);

  useEffect(() => {
    if (!workspacePod) return;
    let alive = true;
    (async () => {
      const doc = `${workspacePod.replace(/\/?$/, "/")}home/apps.ttl`;
      // Gate on a listing so a pod without apps.ttl never blind-GETs (and 404s
      // in the console) — fall straight back to the shipped suite.
      if (!(await resourceExistsByListing(doc, workspacePod))) return;
      const podApps = await readApps(workspacePod, podFetch);
      if (alive && podApps && podApps.length) setWaffleApps(podApps);
    })().catch(() => {
      /* read-only and best-effort — DEFAULT_APPS already stands */
    });
    return () => {
      alive = false;
    };
  }, [workspacePod, podFetch]);

  // Apps the shell can host in the app body: built-in in-process apps (no url)
  // and pod-owned iframe apps (PRD-APPS §4). Pure-link apps stay in the waffle.
  const hosted = apps.filter((a) => !a.url || a.embed === "iframe");
  const active = apps.find((a) => a.key === activeAppKey);

  return (
    <div className="flex items-center gap-1">
      {/* Current app + dropdown of the shell's built-in apps. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
            <span aria-hidden>{active?.icon ?? "▦"}</span>
            <span className="max-w-40 truncate">{active?.label ?? "App"}</span>
            <span className="text-muted-foreground">▾</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Apps in this workspace</DropdownMenuLabel>
          {hosted.map((app) => (
            <DropdownMenuItem key={app.key} onClick={() => setActiveApp(app.key)}>
              <span aria-hidden className="mr-1">
                {app.icon}
              </span>
              <span className="truncate">{app.label}</span>
              {app.key === activeAppKey && <span className="ml-auto text-xs text-primary">●</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            More apps live in the grid →
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The waffle: external sibling apps (links). We pass the list explicitly
          (computed above) so the launcher renders it directly and never runs its
          own pod read+seed. */}
      <MindAppLauncher apps={waffleApps} />
    </div>
  );
}
