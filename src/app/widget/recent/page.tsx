"use client";

/**
 * Reference Home widget (PRD-DASHBOARD §7 — the bridge's first real child).
 *
 * A standalone, own-realm page loaded in a Home tile's iframe. It exists to prove
 * the capability bridge end-to-end and to be the copy-me shape for real app
 * widgets — it is DELETABLE once a sibling app ships its own widget URL.
 *
 * What it demonstrates, in order:
 *   1. handshake — post `mind:hello`, await `mind:welcome` (identity + theme);
 *   2. scoped read — `mind:readdir` its own zone (brokered, scope-checked);
 *   3. scope enforcement — a deliberate OUT-OF-SCOPE read that the host denies;
 *   4. self-sizing — `mind:resize` with measured content height (v2).
 *
 * It never sees a pod credential and never reads anything outside its ceiling.
 * Styling is inline so it renders correctly even in an opaque-origin sandbox
 * (no dependence on the shell's CSS or theme storage).
 */

import { useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeEntry, BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";

/** Entry names are URL path segments (e.g. `Shared%20Demo`); show them decoded. */
function displayName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name; // malformed escape → show as-is rather than throw
  }
}

export default function RecentWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [entries, setEntries] = useState<BridgeEntry[] | null>(null);
  const [scopeEnforced, setScopeEnforced] = useState<boolean | null>(null);
  const [note, setNote] = useState<string>("");
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);
  // Surface the scope self-check only when explicitly debugging the bridge.
  const debug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";

  useEffect(() => {
    const client = createWidgetClient();
    clientRef.current = client;
    let disposed = false;

    const off = client.onTheme((t) => t && setTheme(t));

    (async () => {
      try {
        const session = await client.connect();
        if (disposed) return;
        if (session.theme) setTheme(session.theme);
        setPhase("ready");

        // 2) Scoped read of the widget's own zone (best-effort — an empty/missing
        //    zone is a legitimate state, surfaced as "Nothing here yet").
        try {
          const list = await client.readdir("");
          if (!disposed) setEntries(list);
        } catch {
          if (!disposed) {
            setEntries([]);
            setNote("Your recent items will appear here.");
          }
        }

        // 3) Out-of-scope probe — a self-check that the host denies reads beyond
        //    this widget's zone. It's a developer assertion, NOT product chrome:
        //    the result is only surfaced when the widget is opened with `?debug=1`
        //    (otherwise a normal, working widget would show a scary "denied" badge).
        if (debug) {
          try {
            await client.readdir("../");
            if (!disposed) setScopeEnforced(false); // reached the pod → NOT enforced
          } catch (e) {
            if (!disposed) setScopeEnforced(Boolean((e as { denied?: boolean })?.denied));
          }
        }

        client.ready();
      } catch {
        if (!disposed) setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      off();
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  // 4) Self-size: report content height to the host whenever it changes, reusing
  //    the single connected client (no second listener).
  useEffect(() => {
    const el = rootRef.current;
    const client = clientRef.current;
    if (!el || !client || phase !== "ready") return;
    const report = () => client.resize(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, entries, scopeEnforced, note]);

  const dark = theme === "dark";
  const fg = dark ? "#e5e7eb" : "#111827";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0a0a0a" : "#ffffff";
  const hoverBg = dark ? "#1f1f23" : "#f3f4f6";

  return (
    <div
      ref={rootRef}
      style={{
        font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
        color: fg,
        background: bg,
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      {phase === "connecting" && <p style={{ color: sub }}>Connecting…</p>}

      {phase === "error" && <p style={{ color: "#ef4444" }}>Couldn’t reach the shell bridge.</p>}

      {phase === "ready" && (
        <>
          {entries && entries.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {entries.slice(0, 6).map((e) => (
                <li key={e.url}>
                  <button
                    type="button"
                    title="Open in the app"
                    onClick={() => clientRef.current?.open(e.url)}
                    onMouseEnter={() => setHover(e.url)}
                    onMouseLeave={() => setHover((h) => (h === e.url ? null : h))}
                    style={{
                      display: "flex",
                      gap: 8,
                      width: "100%",
                      padding: "4px 6px",
                      margin: "1px 0",
                      alignItems: "center",
                      border: "none",
                      borderRadius: 6,
                      font: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                      color: fg,
                      background: hover === e.url ? hoverBg : "transparent",
                    }}
                  >
                    <span aria-hidden>{e.kind === "container" ? "📁" : "📄"}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {displayName(e.name)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: sub, margin: 0 }}>{note || "Nothing here yet."}</p>
          )}

          {scopeEnforced !== null && (
            <p
              style={{
                marginTop: 10,
                fontSize: 11,
                color: scopeEnforced ? "#10b981" : "#ef4444",
              }}
            >
              {scopeEnforced
                ? "✓ Scope enforced — out-of-zone read denied"
                : "⚠ Scope NOT enforced"}
            </p>
          )}
        </>
      )}
    </div>
  );
}
