"use client";

/**
 * Decks — a read-only Home widget for the Slides app (PRD-DASHBOARD §7).
 *
 * Reads the Slides app's OWN pod zone (`mind-slides/decks/`, verified against the
 * Slides sibling's config — NOT the canonical `apps/slides/`, so the WidgetDecl
 * overrides `podPath`) through the capability bridge — scope-checked, never a
 * credential. Each deck is a CONTAINER `{id}/` holding `meta.json` ({title,
 * updatedAt, …}); this lists the containers and reads each `meta.json` for the
 * title, newest-first. Clicking opens the Slides app. Deletable demo, like
 * `/widget/recent`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";
type Deck = { id: string; title: string; updatedAt: string };

const ACCENT = "#14b8a6"; // slides teal (mirrors the tile header accent)

export default function DecksWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    let entries;
    try {
      entries = await client.readdir("");
    } catch {
      setDecks([]);
      return;
    }
    const containers = entries.filter((e) => e.kind === "container").slice(0, 12);
    const loaded = await Promise.all(
      containers.map(async (c) => {
        const id = c.name.replace(/\/$/, "");
        try {
          const meta = JSON.parse(await client.read(`${id}/meta.json`)) as {
            title?: string;
            updatedAt?: string;
          };
          return {
            id,
            title: meta.title?.trim() || id,
            updatedAt: meta.updatedAt ?? "",
          } as Deck;
        } catch {
          return null; // a container without a readable meta.json isn't a deck
        }
      })
    );
    setDecks(
      loaded
        .filter((d): d is Deck => d !== null)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 6)
    );
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
  }, [phase, decks]);

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
        (decks === null ? (
          <p style={{ color: sub, margin: 0 }}>Loading…</p>
        ) : decks.length === 0 ? (
          <p style={{ color: sub, margin: 0 }}>No decks yet.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {decks.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  title="Open in Slides"
                  onClick={() => clientRef.current?.open(d.id)}
                  onMouseEnter={() => setHover(d.id)}
                  onMouseLeave={() => setHover((h) => (h === d.id ? null : h))}
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
                    background: hover === d.id ? hoverBg : "transparent",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      fontSize: 13,
                      color: ACCENT,
                      background: `${ACCENT}22`,
                    }}
                  >
                    🖥️
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
