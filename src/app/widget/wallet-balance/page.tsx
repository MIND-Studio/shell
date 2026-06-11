"use client";

/**
 * Balance — the Wallet's read-only Home widget (PRD-WALLET §2/§3).
 *
 * Runs in a sandboxed tile; the bridge brokers ONLY pod I/O, so this never
 * touches `/.tokens`. It renders the NON-AUTHORITATIVE snapshot the in-process
 * Wallet app writes to its zone (`apps/wallet/snapshot.json`) on each load —
 * last-synced balance + a few recent rows, no sigs/keys/memos. Clicking opens
 * the Wallet app (where the live ledger is fetched).
 *
 * Inline styles (not Tailwind) because the tile theme arrives at runtime over
 * the bridge — same pattern as /widget/recent and /widget/decks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";

type Snapshot = {
  balance: number;
  unit: string;
  recent: { kind: string; amount: number; counterparty?: string; ts: string }[];
  syncedAt: string;
};

const ACCENT = "#f59e0b"; // wallet amber (mirrors the 💰 tile header)
const GREEN = "#10b981";

const KIND_GLYPH: Record<string, string> = {
  mint: "↓",
  "transfer-in": "↓",
  "transfer-out": "↑",
  meter: "⚡",
  debit: "−",
};

const KIND_LABEL: Record<string, string> = {
  mint: "top-up",
  "transfer-in": "received",
  "transfer-out": "sent",
  meter: "llm usage",
  debit: "debit",
};

const fmt = new Intl.NumberFormat("en-US");

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function WalletBalanceWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [snap, setSnap] = useState<Snapshot | null | "none">(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  const load = useCallback(async (client: WidgetClient) => {
    try {
      const parsed = JSON.parse(await client.read("snapshot.json")) as Snapshot;
      setSnap(parsed);
    } catch {
      // No snapshot yet — the Wallet app hasn't been opened on this workspace.
      setSnap("none");
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
  }, [phase, snap]);

  const dark = theme === "dark";
  const fg = dark ? "#e5e7eb" : "#111827";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0a0a0a" : "#ffffff";
  const hoverBg = dark ? "#1f1f23" : "#f3f4f6";
  const line = dark ? "#27272a" : "#e5e7eb";

  return (
    <div
      ref={rootRef}
      style={{
        font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
        color: fg,
        background: dark
          ? `radial-gradient(120% 90% at 20% 0%, ${ACCENT}14, transparent 60%), ${bg}`
          : `radial-gradient(120% 90% at 20% 0%, ${ACCENT}10, transparent 60%), ${bg}`,
        padding: 10,
        boxSizing: "border-box",
      }}
    >
      {phase === "connecting" && <p style={{ color: sub, margin: 0 }}>Connecting…</p>}
      {phase === "error" && (
        <p style={{ color: "#ef4444", margin: 0 }}>Couldn’t reach the shell bridge.</p>
      )}
      {phase === "ready" &&
        (snap === null ? (
          <p style={{ color: sub, margin: 0 }}>Loading…</p>
        ) : snap === "none" ? (
          <button
            type="button"
            onClick={() => clientRef.current?.open()}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 6px",
              border: `1px dashed ${line}`,
              borderRadius: 8,
              font: "inherit",
              textAlign: "center",
              cursor: "pointer",
              color: sub,
              background: "transparent",
            }}
          >
            Open the Wallet once to sync your balance.
          </button>
        ) : (
          <button
            type="button"
            title="Open Wallet"
            onClick={() => clientRef.current?.open()}
            onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            style={{
              display: "block",
              width: "100%",
              padding: 6,
              border: "none",
              borderRadius: 8,
              font: "inherit",
              textAlign: "left",
              cursor: "pointer",
              color: fg,
              background: "transparent",
              transition: "background .15s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span
                style={{
                  fontSize: 26,
                  fontWeight: 650,
                  letterSpacing: "-0.02em",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmt.format(snap.balance)}
              </span>
              <span
                style={{
                  color: ACCENT,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                }}
              >
                {snap.unit}
              </span>
              <span style={{ marginLeft: "auto", color: sub, fontSize: 11 }}>
                {timeAgo(snap.syncedAt)}
              </span>
            </div>
            {snap.recent.length > 0 && (
              <ul
                style={{
                  margin: "8px 0 0",
                  padding: "6px 0 0",
                  listStyle: "none",
                  borderTop: `1px solid ${line}`,
                }}
              >
                {snap.recent.slice(0, 3).map((r, i) => {
                  const positive = r.amount > 0;
                  return (
                    <li
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "3px 0",
                        color: sub,
                        fontSize: 12,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          fontSize: 11,
                          color: positive ? GREEN : r.kind === "meter" ? ACCENT : sub,
                          background: positive
                            ? `${GREEN}22`
                            : r.kind === "meter"
                              ? `${ACCENT}22`
                              : `${sub}22`,
                        }}
                      >
                        {KIND_GLYPH[r.kind] ?? "·"}
                      </span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          flexShrink: 0,
                          fontVariantNumeric: "tabular-nums",
                          color: positive ? GREEN : fg,
                        }}
                      >
                        {positive ? "+" : ""}
                        {fmt.format(r.amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </button>
        ))}
    </div>
  );
}
