"use client";

import { useEffect, useRef, useState } from "react";
import { useMindTheme } from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { createBridge, type Bridge } from "@/lib/shell/bridge";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";
import type { HostedApp } from "@/lib/shell/types";

/**
 * Hosts an `embed:"iframe"` app in the shell's app body (PRD-APPS §3). Renders a
 * sandboxed iframe and wires it to the capability bridge: the app gets identity +
 * brokered, scope-checked pod I/O via postMessage — and NEVER the pod credential.
 *
 * Sandbox by trust tier (PRD-APPS §5.5):
 *   - first-party        → allow-scripts allow-same-origin (cooperative, perf)
 *   - community/untrusted → allow-scripts (opaque origin — free isolation)
 *
 * The bridge listener is attached on mount (before the child finishes loading);
 * the child re-posts `mind:hello` until it gets `mind:welcome`, so the handshake
 * is race-free regardless of ordering.
 */
/**
 * @param scope    Optional pod-scope ceiling handed to the bridge as the app's
 *                 `workspacePod`. Widgets pass their owning app's `appZone()` so
 *                 the bridge's `isWithinPod` narrows them to that zone (anything
 *                 outside → `mind:denied`). Absent ⇒ the whole workspace pod.
 * @param onResize Optional v2 self-sizing callback (host-clamped px height).
 * @param allowWrite Whether the host honors `mind:write` from this frame. Plain
 *                 apps omit it (⇒ full `pod:workspace-rw`); read-first widgets pass
 *                 `false` unless they declared `write:true`.
 */
export function IframeHost({
  app,
  scope,
  onResize,
  onOpen,
  allowWrite,
}: {
  app: HostedApp;
  scope?: string;
  onResize?: (height: number) => void;
  onOpen?: (path?: string) => void;
  allowWrite?: boolean;
}) {
  const { webId, workspacePod, project, fetch: podFetch } = useShell();
  const { resolvedMode } = useMindTheme();
  const theme: BridgeTheme = resolvedMode === "light" ? "light" : "dark";
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  // Read the live theme inside the bridge effect without making it a dep — the
  // bridge is created once per identity/app, then theme updates are pushed to the
  // live bridge via setTheme (below), so toggling theme doesn't re-mount the frame.
  const themeRef = useRef<BridgeTheme>(theme);
  themeRef.current = theme;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // first-party apps may run their OWN OIDC inside the frame (e.g. drive,
  // which is not a bridge client and self-authenticates). The CSS consent page is
  // a real <form> POST and the IdP redirect navigates the frame itself, so the
  // trusted tier needs allow-forms + allow-popups on top of same-origin. The
  // community/untrusted tier stays opaque (allow-scripts only) — no self-auth.
  const sandbox =
    app.trust === "first-party"
      ? "allow-scripts allow-same-origin allow-forms allow-popups"
      : "allow-scripts";

  // Reset to the loading overlay ONLY when the iframe will actually (re)load —
  // i.e. its `src` changes. The bridge effect below re-runs on every identity /
  // project rebind, but those do NOT reload the iframe, so resetting the phase
  // there would strand the overlay forever: `onLoad` won't fire again and a
  // self-authenticating app (drive) never sends `mind:ready` to clear it.
  // Since iframe apps are now kept alive across app switches (see ShellPage),
  // that stranding is exactly what happened when scoping to a project.
  useEffect(() => {
    setPhase("loading");
    setErrorMsg(null);
  }, [app.url]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !webId || !workspacePod || !app.url) return;

    const bridge = createBridge({
      target: win,
      app,
      identity: {
        webId,
        // Widgets get a NARROWED ceiling (their app zone); plain apps get the
        // whole workspace pod. Either way the bridge scope-checks against this.
        workspacePod: scope ?? workspacePod,
        project: project ? { id: project.id, name: project.name } : null,
      },
      // The TRUE pod root (un-narrowed) is the container-creation floor for writes;
      // the scope check above still uses the narrowed `workspacePod` ceiling.
      podRoot: workspacePod,
      allowWrite,
      theme: themeRef.current,
      fetch: podFetch,
      onReady: () => setPhase("ready"),
      onAppError: (message) => {
        setErrorMsg(message);
        setPhase("error");
      },
      onResize,
      onOpen,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [app, app.url, app.trust, webId, workspacePod, scope, allowWrite, project, podFetch, onResize, onOpen]);

  // Push shell theme changes to the live bridge so the embedded app's chrome
  // tracks the shell without re-mounting the iframe.
  useEffect(() => {
    bridgeRef.current?.setTheme(theme);
  }, [theme]);

  if (!app.url) {
    return (
      <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">
        {app.label} has no hosting URL.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        src={app.url}
        title={app.label}
        sandbox={sandbox}
        // Bridge apps clear the spinner with `mind:ready`; self-authenticating
        // apps (e.g. drive) never speak the bridge, so also clear it on
        // the iframe's own `load` — whichever fires first. `mind:error` still wins.
        onLoad={() => setPhase((p) => (p === "loading" ? "ready" : p))}
        className="h-full w-full border-0 bg-background"
      />
      {phase === "loading" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/60">
          <p className="text-sm text-muted-foreground">Loading {app.label}…</p>
        </div>
      )}
      {phase === "error" && (
        <div className="absolute inset-0 grid place-items-center p-8">
          <div className="max-w-sm rounded-2xl border border-[color:var(--border)] bg-card p-6 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-xl bg-destructive/15 text-2xl">
              ⚠️
            </div>
            <h2 className="mt-4 text-lg font-semibold">{app.label} hit an error</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {errorMsg ?? "The app reported a problem."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
