"use client";

/**
 * Vault — At a glance: a read-only Home widget for the (zero-knowledge) Vault.
 *
 * HARD privacy rule (AGENTS.md #1/#5): the Vault stores only CIPHERTEXT on the pod.
 * This widget reads ONLY the directory LISTING of `apps/vault/items/` to show a
 * COUNT of secured items — it never reads an item body, a key, or any plaintext,
 * and nothing secret crosses the bridge. It surfaces metadata (how many items),
 * nothing more. Clicking opens the Vault app. Deletable demo, like `/widget/recent`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";

const ACCENT = "#f59e0b"; // vault amber (mirrors the tile header accent)

export default function VaultGlanceWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [count, setCount] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    try {
      // ONLY the listing — count ciphertext resources, never read a body.
      const entries = await client.readdir("items/");
      setCount(entries.filter((e) => e.kind === "resource" && e.name.endsWith(".enc")).length);
    } catch {
      // No items container yet ⇒ an empty Vault (a legitimate first-run state).
      setCount(0);
    }
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
  }, [phase, count]);

  const dark = theme === "dark";
  const fg = dark ? "#e5e7eb" : "#111827";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0a0a0a" : "#ffffff";
  const hoverBg = dark ? "#141417" : "#fafafa";

  const label =
    count === null
      ? "…"
      : count === 0
        ? "Vault is empty"
        : count === 1
          ? "item secured"
          : "items secured";

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
      {phase === "ready" && (
        <button
          type="button"
          title="Open the Vault"
          onClick={() => clientRef.current?.open()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "10px 12px",
            border: "none",
            borderRadius: 12,
            font: "inherit",
            textAlign: "left",
            cursor: "pointer",
            color: fg,
            background: hover ? hoverBg : "transparent",
          }}
        >
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              width: 40,
              height: 40,
              borderRadius: 12,
              fontSize: 20,
              color: ACCENT,
              background: `${ACCENT}22`,
            }}
          >
            🔒
          </span>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>
              {count === null ? "—" : count === 0 ? "" : count}
            </span>
            <span style={{ fontSize: 12, color: sub }}>{label}</span>
          </span>
        </button>
      )}
    </div>
  );
}
