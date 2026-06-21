"use client";

/**
 * Quick Note — the bridge's first INTERACTIVE child (PRD-DASHBOARD §7).
 *
 * Where `/widget/recent` only reads, this one *does something*: it composes a note
 * and writes it into the owning app's pod zone via `mind:write`, then lists the
 * notes back. It proves the write half of the capability bridge end-to-end and is
 * the copy-me shape for any app that wants an interactive Home widget — DELETABLE
 * once a real app ships its own widget URL.
 *
 * SHARED DATA with the real Notes app: this widget reads/writes the SAME pod zone
 * (`{pod}apps/notes/`) in the SAME format the Notes sibling uses — plain Markdown
 * `*.md` files (title = first non-empty line; see notes' `notesContainerFor` +
 * `titleFromBody`). So a note added here shows up in the Notes app and vice-versa;
 * the pod is the shared source of truth (PRD §6), no code is unified.
 *
 * It is granted write because its `WidgetDecl` declares `write:true`; the host
 * denies `mind:write` from any widget that didn't (read-first posture). It still
 * never sees a pod credential and can only touch its own `appZone()` ceiling — an
 * out-of-zone path returns `mind:denied`. Styling is inline so it renders in an
 * opaque-origin sandbox without the shell's CSS.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createWidgetClient, type WidgetClient } from "@/lib/shell/bridge-client";
import type { BridgeTheme } from "@/lib/shell/bridge-protocol";

type Phase = "connecting" | "ready" | "error";
type Note = { name: string; title: string; body: string };

/** Title = first non-empty line, `#` stripped (mirrors notes' `titleFromBody`). */
function titleFromBody(body: string): string {
  const first = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^#+\s*/, "").trim() || "Untitled";
}

export default function QuickNoteWidget() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [theme, setTheme] = useState<BridgeTheme>("dark");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<WidgetClient | null>(null);

  // Read the widget's own zone (shared with the Notes app) and hydrate the most
  // recent notes. We list every `*.md` in `apps/notes/` — the Notes app's own
  // files included — newest-first. Our writes embed a sortable `note-{stamp}-…`
  // name; Notes' files use random UUIDs, so for a stable chronological order we'd
  // need server mtimes (not on the bridge yet) — name sort is a good-enough proxy
  // that keeps freshly-added notes on top.
  const loadNotes = useCallback(async (client: WidgetClient) => {
    let entries;
    try {
      entries = await client.readdir("");
    } catch {
      // Empty/missing zone is a legitimate first-run state, not an error.
      setNotes([]);
      return;
    }
    const files = entries
      .filter((e) => e.kind === "resource" && e.name.endsWith(".md"))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
      .slice(0, 5);
    const loaded = await Promise.all(
      files.map(async (f) => {
        try {
          const body = await client.read(f.name);
          return { name: f.name, title: titleFromBody(body), body } as Note;
        } catch {
          return { name: f.name, title: "(unreadable note)", body: "" } as Note;
        }
      }),
    );
    setNotes(loaded);
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
        await loadNotes(client);
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
  }, [loadNotes]);

  const onAdd = useCallback(async () => {
    const client = clientRef.current;
    const body = text.trim();
    if (!client || !body || saving) return;
    setSaving(true);
    setError(null);
    // Sortable, collision-resistant filename. (localhost is a secure context, so
    // crypto.randomUUID is available; Date.now() drives the lexical ordering.)
    const stamp = String(Date.now()).padStart(15, "0");
    const name = `note-${stamp}-${crypto.randomUUID().slice(0, 8)}.md`;
    try {
      // Plain Markdown, exactly as the Notes app stores it — so the two share data.
      await client.write(name, body, "text/markdown");
      setText("");
      // Optimistic prepend, then reconcile against the pod.
      setNotes((prev) => [{ name, title: titleFromBody(body), body }, ...(prev ?? [])].slice(0, 5));
      await loadNotes(client);
    } catch (e) {
      const denied = Boolean((e as { denied?: boolean })?.denied);
      setError(denied ? "Write denied — out of this widget's scope." : "Couldn’t save the note.");
    } finally {
      setSaving(false);
    }
  }, [text, saving, loadNotes]);

  // Self-size: report content height to the host whenever the layout changes.
  useEffect(() => {
    const el = rootRef.current;
    const client = clientRef.current;
    if (!el || !client || phase !== "ready") return;
    const report = () => client.resize(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, notes, text, saving, error]);

  const dark = theme === "dark";
  const fg = dark ? "#e5e7eb" : "#111827";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const bg = dark ? "#0a0a0a" : "#ffffff";
  const border = dark ? "#27272a" : "#e5e7eb";
  const fieldBg = dark ? "#18181b" : "#f9fafb";
  const hoverBg = dark ? "#1f1f23" : "#f3f4f6";
  const accent = "#16b88a";

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
      {phase === "connecting" && <p style={{ color: sub, margin: 0 }}>Connecting…</p>}

      {phase === "error" && (
        <p style={{ color: "#ef4444", margin: 0 }}>Couldn’t reach the shell bridge.</p>
      )}

      {phase === "ready" && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter to add — quick to fire without leaving the field.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void onAdd();
                }
              }}
              placeholder="Write a quick note…"
              rows={2}
              style={{
                resize: "none",
                width: "100%",
                color: fg,
                background: fieldBg,
                border: `1px solid ${border}`,
                borderRadius: 8,
                padding: "6px 8px",
                font: "inherit",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => void onAdd()}
                disabled={saving || !text.trim()}
                style={{
                  background: accent,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "5px 12px",
                  font: "inherit",
                  fontWeight: 600,
                  cursor: saving || !text.trim() ? "default" : "pointer",
                  opacity: saving || !text.trim() ? 0.6 : 1,
                }}
              >
                {saving ? "Saving…" : "Add note"}
              </button>
              {error && <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span>}
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            {notes === null ? (
              <p style={{ color: sub, margin: 0 }}>Loading…</p>
            ) : notes.length === 0 ? (
              <p style={{ color: sub, margin: 0 }}>No notes yet — add one above.</p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {notes.map((n) => (
                  <li key={n.name} style={{ borderTop: `1px solid ${border}` }}>
                    <button
                      type="button"
                      title="Open in Notes"
                      onClick={() => clientRef.current?.open(n.name)}
                      onMouseEnter={() => setHover(n.name)}
                      onMouseLeave={() => setHover((h) => (h === n.name ? null : h))}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "6px",
                        border: "none",
                        borderRadius: 6,
                        font: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                        color: fg,
                        background: hover === n.name ? hoverBg : "transparent",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {n.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
