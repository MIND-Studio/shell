"use client";

/**
 * Up Next — a read-only Home widget for the Calendar app (PRD-DASHBOARD §7).
 *
 * It reads the Calendar app's OWN pod zone (`apps/calendar/`, verified against the
 * Calendar sibling's config) through the capability bridge — scope-checked, never a
 * credential — and surfaces the next few upcoming events. Events are schema.org
 * Turtle (`schema:name` + `schema:startDate`), one resource per `.ttl`. Clicking a
 * row asks the host to open the Calendar app. Deletable demo, like `/widget/recent`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";
type Event = { name: string; title: string; start: Date | null };

const ACCENT = "#f97316"; // calendar orange (mirrors the tile header accent)

/** Pull a schema.org literal, tolerating both `schema:pred` and full-IRI forms. */
function schemaLit(ttl: string, pred: string): string | undefined {
  const re = new RegExp(`(?:schema:${pred}|schema\\.org/${pred}>)\\s+"([^"]*)"`);
  return ttl.match(re)?.[1];
}

/** Human date chip, e.g. "Wed 11 · 14:00" (or "All day" / "—" when no time). */
function fmt(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime
    ? `${day} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : day;
}

export default function UpNextWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [events, setEvents] = useState<Event[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    let entries;
    try {
      entries = await client.readdir("");
    } catch {
      setEvents([]);
      return;
    }
    const files = entries.filter((e) => e.kind === "resource" && e.name.endsWith(".ttl"));
    const all = await Promise.all(
      files.map(async (f) => {
        try {
          const ttl = await client.read(f.name);
          const startStr = schemaLit(ttl, "startDate");
          return {
            name: f.name,
            title: schemaLit(ttl, "name") ?? "Untitled event",
            start: startStr ? new Date(startStr) : null,
          } as Event;
        } catch {
          return { name: f.name, title: "(unreadable event)", start: null } as Event;
        }
      })
    );
    // Upcoming only (anything from the start of today), soonest first.
    const floor = new Date();
    floor.setHours(0, 0, 0, 0);
    const upcoming = all
      .filter((e) => e.start && e.start.getTime() >= floor.getTime())
      .sort((a, b) => (a.start!.getTime() - b.start!.getTime()))
      .slice(0, 4);
    setEvents(upcoming);
  }, []);

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
        await load(client);
        if (!disposed) client.ready();
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
  }, [load]);

  useEffect(() => {
    const el = rootRef.current;
    const client = clientRef.current;
    if (!el || !client || phase !== "ready") return;
    const report = () => client.resize(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, events]);

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
        padding: 10,
        boxSizing: "border-box",
      }}
    >
      {phase === "connecting" && <p style={{ color: sub, margin: 0 }}>Connecting…</p>}
      {phase === "error" && (
        <p style={{ color: "#ef4444", margin: 0 }}>Couldn’t reach the shell bridge.</p>
      )}
      {phase === "ready" &&
        (events === null ? (
          <p style={{ color: sub, margin: 0 }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ color: sub, margin: 0 }}>No upcoming events.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {events.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  title="Open in Calendar"
                  onClick={() => clientRef.current?.open(e.name)}
                  onMouseEnter={() => setHover(e.name)}
                  onMouseLeave={() => setHover((h) => (h === e.name ? null : h))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "6px",
                    margin: "1px 0",
                    border: "none",
                    borderRadius: 8,
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                    color: fg,
                    background: hover === e.name ? hoverBg : "transparent",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      minWidth: 78,
                      fontSize: 11,
                      fontWeight: 600,
                      color: ACCENT,
                      borderLeft: `2px solid ${ACCENT}`,
                      paddingLeft: 8,
                    }}
                  >
                    {fmt(e.start)}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
