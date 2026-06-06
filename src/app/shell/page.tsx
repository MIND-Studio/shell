"use client";

import { Suspense, useRef } from "react";
import { Button } from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { getAppComponent } from "@/apps/registry";
import { IframeHost } from "@/components/shell/IframeHost";
import type { HostedApp } from "@/lib/shell/types";

/**
 * The app body (PRD §3). Renders the active in-process app from the registry
 * inside a Suspense boundary (Vault is code-split + WASM-heavy). When the active
 * app is an external sibling (no in-process component), show a friendly panel
 * with a link to open it in its own tab.
 *
 * Iframe-hosted apps (PRD-APPS §3) are kept **alive across app switches** rather
 * than mounted only while active: once opened, each stays in the DOM and is just
 * hidden (`display:none`) when another app is foregrounded. Unmounting the iframe
 * on every switch tore down its in-frame state — and for a self-authenticating
 * app like drive (which can't silently restore its OIDC session; that
 * loops on CSS) that meant a full re-login + re-consent every time you came back
 * to it. Hiding instead of unmounting preserves the session, nav, and scroll, so
 * switching to Vault and back to Drive is instant and keeps you signed in.
 */
export default function ShellPage() {
  const { activeAppKey, apps } = useShell();
  const meta = apps.find((a) => a.key === activeAppKey);
  const activeIsIframe = meta?.embed === "iframe" && !!meta.url;

  // Append-only set of iframe apps the user has opened this shell session. Safe
  // to mutate during render (it's an idempotent cache, not reactive state), and
  // doing so means the just-activated iframe is included in *this* render — no
  // blank flash waiting for an effect.
  const openedRef = useRef<Set<string>>(new Set());
  if (activeIsIframe) openedRef.current.add(activeAppKey);
  const livingIframes = apps.filter(
    (a): a is HostedApp & { url: string } =>
      a.embed === "iframe" && !!a.url && openedRef.current.has(a.key),
  );

  // In-process app for the active key (Vault/Identity). Only resolved when the
  // foreground app isn't an iframe — iframe apps render from the layers below.
  const AppComponent = activeIsIframe ? null : getAppComponent(activeAppKey);

  return (
    <div className="relative h-full w-full">
      {livingIframes.map((a) => (
        <div
          key={a.key}
          className={a.key === activeAppKey ? "h-full w-full" : "hidden"}
        >
          <IframeHost app={a} />
        </div>
      ))}

      {!activeIsIframe &&
        (AppComponent ? (
          <Suspense fallback={<AppLoading label={meta?.label} />}>
            <AppComponent />
          </Suspense>
        ) : (
          <div className="grid h-full place-items-center p-8">
            <div className="max-w-sm rounded-2xl border border-[color:var(--border)] bg-card p-6 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-xl bg-primary/15 text-2xl">
                {meta?.icon ?? "▦"}
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                {meta?.label ?? "This app"}
              </h2>
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
        ))}
    </div>
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
