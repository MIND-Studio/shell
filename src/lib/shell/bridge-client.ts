"use client";

/**
 * The CHILD side of the capability bridge (PRD-APPS §5 / PRD-DASHBOARD §7) — the
 * minimal shape any app copies to serve a Home widget from its own origin. It is
 * the mirror of the host `bridge.ts`: it posts `mind:hello`, awaits `mind:welcome`
 * (identity + theme — never a credential), then makes scope-checked pod requests
 * (`readdir`/`read`/`fetch`) whose results the host brokers, and finally reports
 * its content height with `mind:resize` (v2) so the host can fit its tile.
 *
 * The reference widget at `/widget/recent` is its only consumer today; it lives
 * in the shell repo purely so the bridge has a real end-to-end child. Real apps
 * reimplement this on their own origin.
 */

import {
  PROTOCOL_VERSION,
  type BridgeIdentity,
  type BridgeTheme,
  type BridgeEntry,
} from "./bridge-protocol";

export interface WidgetSession {
  identity: BridgeIdentity;
  theme?: BridgeTheme;
}

/** Result of a brokered raw {@link WidgetClient.fetch} (binary-safe). */
export interface BridgeFetchResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  /** Text body, or base64 bytes when `encoding === "base64"` (binary resources). */
  body: string;
  encoding: "utf8" | "base64";
}

/** Thrown when the host denies a request (out of the widget's scope ceiling). */
export class BridgeDeniedError extends Error {
  readonly denied = true;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface WidgetClient {
  /** Handshake: post hello (re-posting until welcome) and resolve identity+theme. */
  connect(): Promise<WidgetSession>;
  /** List a container relative to the widget's scope ceiling. */
  readdir(path: string): Promise<BridgeEntry[]>;
  /** Read a resource as text, relative to the widget's scope ceiling. */
  read(path: string): Promise<string>;
  /**
   * Brokered, scope-checked raw fetch for BINARY resources (e.g. images): pass an
   * absolute pod URL inside the widget's ceiling — a `readdir` entry's `url`. The
   * result's `body` is base64 when `encoding === "base64"`. Rejects on out-of-scope.
   */
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string> }
  ): Promise<BridgeFetchResult>;
  /**
   * Write text to a resource (whole-file PUT), relative to the scope ceiling.
   * Rejects with {@link BridgeDeniedError} if the widget wasn't granted write
   * (`write:true`) or the path is out of scope.
   */
  write(path: string, body: string, contentType?: string): Promise<void>;
  /** Self-size: ask the host to fit the tile to `height` px (host-clamped). */
  resize(height: number): void;
  /**
   * Ask the host to open this widget's OWNING app (e.g. a tile item was clicked).
   * `path` is an optional, untrusted hint at which resource — the host may ignore
   * it. Fire-and-forget; the host can only navigate to this widget's own app.
   */
  open(path?: string): void;
  /** Lifecycle: signal the widget has rendered (clears the host spinner). */
  ready(): void;
  /** Subscribe to theme changes the host pushes (re-broadcast welcomes). */
  onTheme(listener: (theme?: BridgeTheme) => void): () => void;
  dispose(): void;
}

export function createWidgetClient(): WidgetClient {
  let seq = 0;
  const pending = new Map<string, Pending>();
  const themeListeners = new Set<(theme?: BridgeTheme) => void>();
  let session: WidgetSession | null = null;
  let onWelcome: ((s: WidgetSession) => void) | null = null;

  function post(msg: Record<string, unknown>): void {
    // The host validates by source-binding + origin, so a "*" target is safe.
    window.parent.postMessage(msg, "*");
  }

  function request<T>(t: string, extra: Record<string, unknown>): Promise<T> {
    const id = `w${++seq}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      post({ t, v: PROTOCOL_VERSION, id, ...extra });
    });
  }

  function onMessage(event: MessageEvent): void {
    const d = event.data as { t?: unknown; id?: unknown } | null;
    if (!d || typeof d !== "object" || typeof d.t !== "string") return;
    const id = typeof d.id === "string" ? d.id : undefined;
    const p = id ? pending.get(id) : undefined;
    switch (d.t) {
      case "mind:welcome": {
        const w = d as unknown as WidgetSession;
        session = { identity: w.identity, theme: w.theme };
        onWelcome?.(session);
        themeListeners.forEach((l) => l(session?.theme));
        break;
      }
      case "mind:readdir:result":
        p?.resolve((d as { entries: BridgeEntry[] }).entries);
        break;
      case "mind:read:result":
        p?.resolve((d as { body: string }).body);
        break;
      case "mind:write:result":
        p?.resolve(undefined);
        break;
      case "mind:fetch:result":
        p?.resolve(d);
        break;
      case "mind:denied":
        p?.reject(new BridgeDeniedError((d as { reason?: string }).reason ?? "denied"));
        break;
      case "mind:fail":
        p?.reject(new Error((d as { message?: string }).message ?? "request failed"));
        break;
      default:
        return;
    }
    if (id) pending.delete(id);
  }

  window.addEventListener("message", onMessage);

  return {
    connect() {
      if (session) return Promise.resolve(session);
      return new Promise<WidgetSession>((resolve) => {
        // Re-post hello until welcome arrives — the host attaches its listener on
        // mount but may not be ready on our first post; this is race-free.
        const handshake = setInterval(() => {
          if (session) clearInterval(handshake);
          else post({ t: "mind:hello", v: PROTOCOL_VERSION });
        }, 200);
        onWelcome = (s) => {
          clearInterval(handshake);
          resolve(s);
        };
        post({ t: "mind:hello", v: PROTOCOL_VERSION });
      });
    },
    readdir: (path) => request<BridgeEntry[]>("mind:readdir", { path }),
    read: (path) => request<string>("mind:read", { path }),
    fetch: (url, init) => request<BridgeFetchResult>("mind:fetch", { url, init }),
    write: (path, body, contentType) =>
      request<void>("mind:write", { path, body, contentType }),
    resize(height) {
      post({ t: "mind:resize", v: PROTOCOL_VERSION, height: Math.round(height) });
    },
    open(path) {
      post({ t: "mind:open", v: PROTOCOL_VERSION, ...(path ? { path } : {}) });
    },
    ready() {
      post({ t: "mind:ready", v: PROTOCOL_VERSION });
    },
    onTheme(listener) {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    dispose() {
      window.removeEventListener("message", onMessage);
      pending.clear();
      themeListeners.clear();
    },
  };
}
