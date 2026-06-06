"use client";

import { useEffect, useRef, useState } from "react";
import { useShell } from "@/lib/shell/context";
import { createBridge } from "@/lib/shell/bridge";
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
export function IframeHost({ app }: { app: HostedApp }) {
  const { webId, workspacePod, project, fetch: podFetch } = useShell();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // first-party apps may run their OWN OIDC inside the frame (e.g. mind-drive-v0,
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
  // self-authenticating app (mind-drive-v0) never sends `mind:ready` to clear it.
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
        workspacePod,
        project: project ? { id: project.id, name: project.name } : null,
      },
      fetch: podFetch,
      onReady: () => setPhase("ready"),
      onAppError: (message) => {
        setErrorMsg(message);
        setPhase("error");
      },
    });
    return () => bridge.dispose();
  }, [app, app.url, app.trust, webId, workspacePod, project, podFetch]);

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
        // apps (e.g. mind-drive-v0) never speak the bridge, so also clear it on
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
