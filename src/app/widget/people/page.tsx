"use client";

/**
 * People — a read-only Home widget for the Contacts app (PRD-DASHBOARD §7).
 *
 * Reads the Contacts app's OWN pod zone (`apps/contacts/`, verified against the
 * Contacts sibling's config) through the capability bridge — scope-checked, never a
 * credential — and shows a few people as initial-avatars. Contacts are vCard Turtle
 * (`vcard:fn`), one resource per `.ttl`. Clicking opens the Contacts app. Deletable
 * demo, like `/widget/recent`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";
type Person = { name: string; fn: string };

const ACCENT = "#ec4899"; // contacts pink (mirrors the tile header accent)

/** Pull `vcard:fn`, tolerating both the prefix and full-IRI forms. */
function vcardFn(ttl: string): string | undefined {
  const re = /(?:vcard:fn|vcard\/ns#fn>)\s+"([^"]*)"/;
  return ttl.match(re)?.[1];
}

/** Up to two initials from a display name. */
function initials(fn: string): string {
  const parts = fn.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function PeopleWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    let entries;
    try {
      entries = await client.readdir("");
    } catch {
      setPeople([]);
      return;
    }
    const files = entries
      .filter((e) => e.kind === "resource" && e.name.endsWith(".ttl"))
      .slice(0, 8);
    const loaded = await Promise.all(
      files.map(async (f) => {
        try {
          const ttl = await client.read(f.name);
          return { name: f.name, fn: vcardFn(ttl) ?? "Unnamed" } as Person;
        } catch {
          return { name: f.name, fn: "Unnamed" } as Person;
        }
      })
    );
    loaded.sort((a, b) => a.fn.localeCompare(b.fn));
    setPeople(loaded);
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
  }, [phase, people]);

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
        (people === null ? (
          <p style={{ color: sub, margin: 0 }}>Loading…</p>
        ) : people.length === 0 ? (
          <p style={{ color: sub, margin: 0 }}>No contacts yet.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {people.map((p) => (
              <li key={p.name}>
                <button
                  type="button"
                  title="Open in Contacts"
                  onClick={() => clientRef.current?.open(p.name)}
                  onMouseEnter={() => setHover(p.name)}
                  onMouseLeave={() => setHover((h) => (h === p.name ? null : h))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "5px 6px",
                    margin: "1px 0",
                    border: "none",
                    borderRadius: 8,
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                    color: fg,
                    background: hover === p.name ? hoverBg : "transparent",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#fff",
                      background: ACCENT,
                    }}
                  >
                    {initials(p.fn)}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.fn}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
