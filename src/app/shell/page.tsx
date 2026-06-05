"use client";

import { Suspense } from "react";
import { Button } from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { getAppComponent } from "@/apps/registry";
import { IframeHost } from "@/components/shell/IframeHost";

/**
 * The app body (PRD §3). Renders the active in-process app from the registry
 * inside a Suspense boundary (Vault is code-split + WASM-heavy). When the active
 * app is an external sibling (no in-process component), show a friendly panel
 * with a link to open it in its own tab.
 */
export default function ShellPage() {
  const { activeAppKey, apps } = useShell();
  const meta = apps.find((a) => a.key === activeAppKey);

  // Pod-owned, iframe-hosted app (PRD-APPS §3): render it under the shell chrome
  // through the sandboxed capability bridge.
  if (meta?.embed === "iframe" && meta.url) {
    return <IframeHost app={meta} />;
  }

  const AppComponent = getAppComponent(activeAppKey);

  if (!AppComponent) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm rounded-2xl border border-[color:var(--border)] bg-card p-6 text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-xl bg-primary/15 text-2xl">
            {meta?.icon ?? "▦"}
          </div>
          <h2 className="mt-4 text-lg font-semibold">{meta?.label ?? "This app"}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {meta?.label ?? "This app"} opens in its own tab.
          </p>
          {meta?.url && (
            <Button asChild className="mt-4">
              <a href={meta.url} target="_blank" rel="noreferrer">
                Open {meta.label}
              </a>
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<AppLoading label={meta?.label} />}>
      <AppComponent />
    </Suspense>
  );
}

function AppLoading({ label }: { label?: string }) {
  return (
    <div className="grid h-full place-items-center">
      <p className="text-sm text-muted-foreground">
        Loading {label ?? "app"}…
      </p>
    </div>
  );
}
