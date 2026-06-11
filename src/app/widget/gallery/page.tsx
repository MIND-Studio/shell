"use client";

/**
 * Gallery — a read-only Home widget for the Photos app (PRD-DASHBOARD §7).
 *
 * Reads the Photos app's OWN pod zone (`apps/photos/`, verified against the Photos
 * sibling's config) through the capability bridge — scope-checked, never a
 * credential. Photos are raw binary image resources, so this is the bridge's first
 * BINARY child: it `readdir`s the zone, then brokers a `fetch` per image and frames
 * the bytes as a base64 data URL for a `<img>` thumbnail (the host base64-encodes
 * non-text bodies so they survive postMessage). Clicking opens the Photos app.
 * Deletable demo, like `/widget/recent`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";
type Thumb = { name: string; src: string };

const MAX_THUMBS = 6;

export default function GalleryWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [thumbs, setThumbs] = useState<Thumb[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    let entries;
    try {
      entries = await client.readdir("");
    } catch {
      setThumbs([]);
      return;
    }
    const candidates = entries.filter((e) => e.kind === "resource").slice(0, MAX_THUMBS);
    const loaded = await Promise.all(
      candidates.map(async (e) => {
        try {
          const res = await client.fetch(e.url);
          const ct = res.headers["content-type"] ?? "";
          if (res.status >= 400 || !ct.startsWith("image/")) return null;
          const src =
            res.encoding === "base64"
              ? `data:${ct};base64,${res.body}`
              : `data:${ct};utf8,${encodeURIComponent(res.body)}`;
          return { name: e.name, src } as Thumb;
        } catch {
          return null;
        }
      })
    );
    setThumbs(loaded.filter((t): t is Thumb => t !== null));
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
  }, [phase, thumbs]);

  const dark = theme === "dark";
  const fg = dark ? "#e5e7eb" : "#111827";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0a0a0a" : "#ffffff";
  const border = dark ? "#27272a" : "#e5e7eb";

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
        (thumbs === null ? (
          <p style={{ color: sub, margin: 0 }}>Loading…</p>
        ) : thumbs.length === 0 ? (
          <p style={{ color: sub, margin: 0 }}>No photos yet.</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 6,
            }}
          >
            {thumbs.map((t) => (
              <button
                key={t.name}
                type="button"
                title="Open in Photos"
                onClick={() => clientRef.current?.open(t.name)}
                onMouseEnter={() => setHover(t.name)}
                onMouseLeave={() => setHover((h) => (h === t.name ? null : h))}
                style={{
                  position: "relative",
                  aspectRatio: "1 / 1",
                  padding: 0,
                  border: `1px solid ${border}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  cursor: "pointer",
                  background: "transparent",
                  transform: hover === t.name ? "scale(1.03)" : "none",
                  transition: "transform 120ms ease",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.src}
                  alt={t.name}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
