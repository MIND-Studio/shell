"use client";

import { useShell } from "@/lib/shell/context";

/**
 * The active app's left-nav region (wireframe "App Menu"). In v0 this is a thin
 * labelled column: it names the active app and leaves the substance of the
 * navigation to the app itself (Vault renders its own internal nav inside the
 * app body). It exists so the chrome matches the wireframe and gives apps a
 * stable place to grow their nav later.
 */
export function AppMenu() {
  const { apps, activeAppKey, project } = useShell();
  const active = apps.find((a) => a.key === activeAppKey);

  return (
    <aside
      aria-label="App menu"
      className="flex h-full flex-col gap-3 glass-panel px-3 py-4"
    >
      <div className="flex items-center gap-2 px-1">
        <span aria-hidden className="text-base">
          {active?.icon ?? "▦"}
        </span>
        <span className="text-sm font-semibold">{active?.label ?? "App"}</span>
      </div>

      <p className="px-1 text-xs text-muted-foreground">
        {project ? (
          <>
            Scoped to <span className="font-medium text-foreground">{project.name}</span>
          </>
        ) : (
          "Whole workspace"
        )}
      </p>

      <div className="mt-1 rounded-lg border border-dashed border-[color:var(--border)] px-3 py-3 text-xs text-muted-foreground">
        This app provides its own menu in the main view.
      </div>
    </aside>
  );
}
