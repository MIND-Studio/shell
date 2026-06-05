"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mind-studio/ui";
import { MindAppLauncher } from "@mind-studio/core/launcher";
import { useShell } from "@/lib/shell/context";

/**
 * The current-app label + the app-switcher "waffle" (wireframe "👤 Drive [⊞]").
 *
 * Two ways to jump apps without leaving the shell:
 *   - the built-in (in-process) apps — clicking one calls `setActiveApp(key)` so
 *     it renders right here in the app body;
 *   - the external sibling apps — opened by `MindAppLauncher` (the shared waffle),
 *     which links out to their hosted subdomains.
 */
export function AppSwitcher() {
  const { apps, activeAppKey, setActiveApp, workspacePod, fetch: podFetch } =
    useShell();

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
            <DropdownMenuItem
              key={app.key}
              onClick={() => setActiveApp(app.key)}
            >
              <span aria-hidden className="mr-1">
                {app.icon}
              </span>
              <span className="truncate">{app.label}</span>
              {app.key === activeAppKey && (
                <span className="ml-auto text-xs text-primary">●</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            More apps live in the grid →
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The waffle: external sibling apps (links), pod-driven. */}
      <MindAppLauncher
        podRoot={workspacePod ?? undefined}
        podFetch={podFetch}
      />
    </div>
  );
}
