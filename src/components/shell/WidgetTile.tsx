"use client";

import { useCallback, useMemo, useState } from "react";
import { useShell } from "@/lib/shell/context";
import { IframeHost } from "./IframeHost";
import { appZone } from "@/lib/shell/types";
import type { HostedApp, WidgetDecl, WidgetSize } from "@/lib/shell/types";

/**
 * One Home tile (PRD-DASHBOARD §5/§6): an app's widget hosted in a sandboxed
 * iframe under the capability bridge. The tile is shell chrome (header + frame);
 * the *content* is the app's own page, served from its origin — never shell-local
 * code. The bridge hands the widget a scope ceiling of `appZone(owningApp)`
 * narrowed by `widget.scope`, so it can only read its own zone (out-of-scope →
 * `mind:denied`). No pod credential ever crosses (AGENTS.md rule #1).
 *
 * `mind:resize` (v2) lets the widget self-size; we clamp the requested height to
 * the tile's grid bounds so a hostile child can't grow unbounded.
 */

/** Column span by footprint: s=1, m/l=2 (the grid is 2 columns). The Home grid
 *  reads this to place the tile; exported so the layout owns placement. */
export function widgetColSpan(size: WidgetSize): number {
  return size === "s" ? 1 : 2;
}

/** Default tile body height (px) before any self-resize. */
function defaultHeight(size: WidgetSize): number {
  return size === "l" ? 300 : 150;
}

/** Max body height (px) the host will grow to, by the widget's `maxSize`. */
function maxHeight(size: WidgetSize): number {
  if (size === "l") return 460;
  if (size === "m") return 260;
  return 220;
}

const MIN_HEIGHT = 96;

/**
 * Per-app accent (the "refined" Home look): a soft, app-identifying tint on each
 * tile's header. Keyed by the OWNING app's key; falls back to the Mind indigo.
 * Pure chrome — it never reaches the sandboxed widget body.
 */
const APP_ACCENTS: Record<string, string> = {
  drive: "#3b82f6",
  notes: "#6366f1",
  contacts: "#ec4899",
  calendar: "#f97316",
  photos: "#8b5cf6",
  vault: "#f59e0b",
  slides: "#14b8a6",
};
function accentFor(key: string): string {
  return APP_ACCENTS[key] ?? "#6366f1";
}

export function WidgetTile({
  app,
  widget,
  size,
}: {
  app: HostedApp;
  widget: WidgetDecl;
  size: WidgetSize;
}) {
  const { workspacePod, project, setActiveApp } = useShell();
  const [height, setHeight] = useState<number | null>(null);

  // A widget item click asks to open the owning app. Bound to THIS widget's app
  // key, so a child can only navigate to its own app — the `path` hint is ignored
  // for now (sibling apps don't take a deep-link param yet). Stable so it doesn't
  // re-mount the bridge each render.
  const onOpen = useCallback(() => {
    setActiveApp(app.key);
  }, [setActiveApp, app.key]);

  // The widget's pod-scope ceiling: the owning app's zone (or a `podPath` override
  // for apps whose data lives outside the canonical `apps/{key}/` zone), narrowed
  // by its declared sub-path. The bridge's `isWithinPod` enforces it.
  const scope = useMemo(() => {
    if (!workspacePod) return undefined;
    let base: string;
    if (widget.podPath) {
      const root = workspacePod.endsWith("/") ? workspacePod : workspacePod + "/";
      const p = widget.podPath.replace(/^\/+/, "");
      base = `${root}${p.endsWith("/") ? p : p + "/"}`;
    } else {
      base = appZone(workspacePod, app.key, project);
    }
    const sub = widget.scope.replace(/^\/+/, "");
    return sub ? `${base}${sub.endsWith("/") ? sub : sub + "/"}` : base;
  }, [workspacePod, app.key, project, widget.scope, widget.podPath]);

  // A synthetic HostedApp so IframeHost loads the WIDGET's url/trust (distinct
  // from the parent app's own embed url). Widgets default to opaque-origin
  // isolation ("community") unless they declare otherwise.
  const widgetApp: HostedApp = useMemo(
    () => ({
      key: `${app.key}#${widget.id}`,
      label: widget.label,
      icon: widget.icon,
      url: widget.url,
      enabled: true,
      embed: "iframe",
      trust: widget.trust ?? "community",
    }),
    [app.key, widget.id, widget.label, widget.icon, widget.url, widget.trust]
  );

  const cap = maxHeight(widget.maxSize ?? size);
  const bodyHeight = Math.max(
    MIN_HEIGHT,
    Math.min(height ?? defaultHeight(size), cap)
  );
  const accent = accentFor(app.key);

  return (
    <section
      data-widget={widgetApp.key}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-[color:var(--border)] bg-card shadow-sm transition-shadow hover:shadow-md"
    >
      <header
        className="flex items-center gap-2 border-b border-[color:var(--border)] px-3 py-2"
        style={{ background: `linear-gradient(90deg, ${accent}1f, transparent 72%)` }}
      >
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-md text-sm leading-none"
          style={{ background: `${accent}26`, color: accent }}
        >
          {widget.icon}
        </span>
        <h3 className="truncate text-sm font-semibold">{widget.label}</h3>
        <span
          className="ml-auto truncate text-[11px] font-medium"
          style={{ color: accent, opacity: 0.85 }}
        >
          {app.label}
        </span>
      </header>
      <div style={{ height: bodyHeight }} className="relative w-full">
        <IframeHost
          app={widgetApp}
          scope={scope}
          allowWrite={widget.write ?? false}
          onResize={(h) => setHeight(Math.max(MIN_HEIGHT, Math.min(h, cap)))}
          onOpen={onOpen}
        />
      </div>
    </section>
  );
}
