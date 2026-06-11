"use client";

/**
 * Wallet — your MIND balance, transactions, and payments (PRD-WALLET).
 *
 * An in-process, first-party app (like Vault): it reads the server-origin
 * `/.tokens` ledger with the shell's OWN authenticated session fetch (never the
 * bridge) and signs transfers by asking the sealed crypto core to `sign()` the
 * canonical payload — the Ed25519 private key never enters JS (AGENTS.md #1/#4).
 *
 * The server ledger is authoritative. The only pod write is a small derived
 * snapshot (`apps/wallet/snapshot.json`) so the sandboxed Balance Home widget
 * has something to render through the pod-only bridge (PRD-WALLET §3).
 *
 * Never logged: amounts, memos, transfer bodies (rule #5).
 *
 * Design language: "the ledger as a signed artifact" — tabular numerals, an
 * amber unit accent, transactions as a hash-chain timeline, and a Send review
 * framed as the canonical document about to be signed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Input, Label } from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { appZone } from "@/lib/shell/types";
import { readProfile } from "@/lib/solid/profile";
import { writeFileText, ensureContainerChain } from "@/lib/solid/pod-fs";
import { sign as walletSign, getDid } from "@/lib/identity/wallet";
import {
  fetchTokens,
  registerSigningDid,
  buildTransfer,
  canonicalTransfer,
  submitTransfer,
  ledgerOrigin,
  toSnapshot,
  type TokensResult,
  type TokensView,
  type LedgerEntry,
} from "@/lib/tokens/api";

// ---- presentation helpers ----------------------------------------------------

const AMBER = "#f59e0b";

const KIND_META: Record<
  string,
  { glyph: string; label: string; positive: boolean; tone: "credit" | "spend" | "meter" }
> = {
  mint: { glyph: "↓", label: "Top-up", positive: true, tone: "credit" },
  "transfer-in": { glyph: "↓", label: "Received", positive: true, tone: "credit" },
  "transfer-out": { glyph: "↑", label: "Sent", positive: false, tone: "spend" },
  meter: { glyph: "⚡", label: "LLM usage", positive: false, tone: "meter" },
  debit: { glyph: "−", label: "Debit", positive: false, tone: "spend" },
};

function kindMeta(kind: string, amount: number) {
  return (
    KIND_META[kind] ?? {
      glyph: "·",
      label: kind,
      positive: amount >= 0,
      tone: amount >= 0 ? ("credit" as const) : ("spend" as const),
    }
  );
}

const fmt = new Intl.NumberFormat("en-US");

function truncateId(id: string, head = 18, tail = 8): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Ease-out count-up toward `target`; honors prefers-reduced-motion. */
function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/** One-time keyframes for the staggered row/hero reveal. */
function WalletStyles() {
  return (
    <style>{`
      @keyframes wallet-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .wallet-rise { animation: none !important; } }
      .wallet-rise { animation: wallet-rise .45s cubic-bezier(.2,.7,.3,1) both; }
    `}</style>
  );
}

// ---- the app -------------------------------------------------------------------

export default function WalletApp() {
  const { webId, workspacePod, ready, fetch: authedFetch } = useShell();
  const origin = useMemo(() => (webId ? ledgerOrigin(webId) : null), [webId]);

  const [result, setResult] = useState<TokensResult | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!origin) return;
    const my = ++loadSeq.current;
    const r = await fetchTokens(authedFetch, origin);
    if (my !== loadSeq.current) return;
    setResult(r);
    setSyncedAt(new Date().toISOString());
    // Best-effort snapshot for the Balance widget — derived cache, never
    // authoritative; written to the canonical workspace zone (not per-project)
    // so the widget's ceiling always finds it.
    if (r.status === "ok" && workspacePod) {
      const zone = appZone(workspacePod, "wallet");
      try {
        await ensureContainerChain(zone, workspacePod);
        await writeFileText(
          `${zone}snapshot.json`,
          JSON.stringify(toSnapshot(r.view)),
          "application/json"
        );
      } catch {
        /* widget just shows its empty state */
      }
    }
  }, [origin, authedFetch, workspacePod]);

  useEffect(() => {
    if (ready && origin) void load();
  }, [ready, origin, load]);

  if (!ready || result === null) {
    return <Centered>Loading Wallet…</Centered>;
  }
  if (!webId || result.status === "unauthorized") {
    return (
      <Centered>
        <p className="text-muted-foreground">Sign in to see your MIND balance.</p>
      </Centered>
    );
  }
  if (result.status === "unsupported") {
    return (
      <Centered>
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-3xl" aria-hidden>💰</p>
          <p className="text-lg">This server doesn’t offer the MIND ledger.</p>
          <p className="text-sm text-muted-foreground">
            The token ledger is a <code>solid-server-rs</code> feature; your current
            identity lives on a server without it.
          </p>
        </div>
      </Centered>
    );
  }
  if (result.status === "disabled") {
    return (
      <Centered>
        <p className="text-muted-foreground">
          The token ledger is switched off on this server.
        </p>
      </Centered>
    );
  }
  if (result.status === "error") {
    return (
      <Centered>
        <div className="space-y-2 text-center">
          <p className="text-destructive">{result.detail}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <WalletView
      view={result.view}
      origin={origin!}
      syncedAt={syncedAt}
      authedFetch={authedFetch}
      onRefresh={load}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center p-8">
      {children}
    </div>
  );
}

// ---- main view -----------------------------------------------------------------

function WalletView({
  view,
  origin,
  syncedAt,
  authedFetch,
  onRefresh,
}: {
  view: TokensView;
  origin: string;
  syncedAt: string | null;
  authedFetch: typeof fetch;
  onRefresh: () => Promise<void>;
}) {
  const history = useMemo(
    () => [...view.history].sort((a, b) => b.seq - a.seq),
    [view.history]
  );

  return (
    <div className="relative h-full overflow-y-auto">
      <WalletStyles />
      {/* atmosphere: a faint amber bloom behind the balance, vignetting to the surface */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72"
        style={{
          background:
            "radial-gradient(60% 100% at 35% 0%, rgba(245,158,11,0.10), rgba(245,158,11,0.03) 45%, transparent 75%)",
        }}
      />
      <div className="relative mx-auto max-w-3xl space-y-8 p-6 pb-16">
        <BalanceHeader view={view} syncedAt={syncedAt} onRefresh={onRefresh} />
        {view.transfers_enabled && (
          <SendPanel view={view} origin={origin} authedFetch={authedFetch} onSent={onRefresh} />
        )}
        <ChainTimeline history={history} unit={view.unit} />
      </div>
    </div>
  );
}

function BalanceHeader({
  view,
  syncedAt,
  onRefresh,
}: {
  view: TokensView;
  syncedAt: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const did = getDid();
  const shown = useCountUp(view.balance);

  const { earned, spent } = useMemo(() => {
    let earned = 0;
    let spent = 0;
    for (const e of view.history) {
      if (e.amount >= 0) earned += e.amount;
      else spent += -e.amount;
    }
    return { earned, spent };
  }, [view.history]);

  return (
    <header className="wallet-rise space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            <span style={{ color: AMBER }}>●</span> Balance
          </p>
          <p className="mt-1 text-6xl font-semibold tracking-tight tabular-nums">
            {fmt.format(shown)}
            <span className="ml-3 align-baseline text-xl font-medium" style={{ color: AMBER }}>
              {view.unit}
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
          Refresh
        </Button>
      </div>

      {(earned > 0 || spent > 0) && (
        <div className="flex gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-emerald-400 tabular-nums">
            ↓ {fmt.format(earned)} in
          </span>
          <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 tabular-nums">
            ↑ {fmt.format(spent)} out
          </span>
          <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 tabular-nums">
            seq {view.seq}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono" title={view.owner}>
          {truncateId(view.owner, 32, 10)}
        </span>
        {did && (
          <button
            type="button"
            className="rounded px-1 underline-offset-2 hover:underline"
            title={did}
            onClick={() => {
              void navigator.clipboard.writeText(did).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "DID copied ✓" : `Copy my DID (${truncateId(did, 14, 6)})`}
          </button>
        )}
        {syncedAt && <span>· synced {timeAgo(syncedAt)}</span>}
      </div>
    </header>
  );
}

// ---- the chain timeline ----------------------------------------------------------

function ChainTimeline({ history, unit }: { history: LedgerEntry[]; unit: string }) {
  return (
    <section className="wallet-rise" style={{ animationDelay: "120ms" }}>
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        Transactions
        <span className="ml-2 normal-case tracking-normal opacity-60">
          · signed hash-chain, newest first
        </span>
      </h2>
      {history.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No transactions yet — the chain starts at <span className="font-mono">genesis</span>.
        </p>
      ) : (
        <ul className="relative">
          {/* the chain itself: a hairline threading every node */}
          <div
            aria-hidden
            className="absolute bottom-5 left-[19px] top-5 w-px bg-gradient-to-b from-border via-border to-transparent"
          />
          {history.map((e, i) => (
            <TxRow key={e.seq} entry={e} unit={unit} index={i} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TxRow({ entry, unit, index }: { entry: LedgerEntry; unit: string; index: number }) {
  const meta = kindMeta(entry.kind, entry.amount);
  const node =
    meta.tone === "credit"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
      : meta.tone === "meter"
        ? "border-amber-500/40 bg-amber-500/15 text-amber-400"
        : "border-border bg-muted text-muted-foreground";
  return (
    <li
      className="wallet-rise group relative flex items-center gap-4 rounded-lg px-1 py-2.5 transition-colors hover:bg-muted/30"
      style={{ animationDelay: `${Math.min(index, 12) * 45 + 160}ms` }}
    >
      <span
        aria-hidden
        className={`relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border text-sm ${node}`}
      >
        {meta.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {meta.label}
          {entry.counterparty && (
            <span className="text-muted-foreground" title={entry.counterparty}>
              {" "}· {truncateId(entry.counterparty, 24, 8)}
            </span>
          )}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          #{entry.seq}
          {entry.memo ? <span className="font-sans text-xs"> · {entry.memo}</span> : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={`text-sm font-medium tabular-nums ${meta.positive ? "text-emerald-400" : ""}`}
        >
          {entry.amount > 0 ? "+" : ""}
          {fmt.format(entry.amount)}{" "}
          <span className="text-xs font-normal text-muted-foreground">{unit}</span>
        </p>
        <p className="text-xs text-muted-foreground">{timeAgo(entry.ts)}</p>
      </div>
    </li>
  );
}

// ---- send ------------------------------------------------------------------------

type SendPhase =
  | { p: "form" }
  | { p: "review"; to: string; toName: string | undefined; amount: number; memo: string }
  | { p: "sending" }
  | { p: "sent"; seq: number }
  | { p: "error"; message: string; locked?: boolean };

function SendPanel({
  view,
  origin,
  authedFetch,
  onSent,
}: {
  view: TokensView;
  origin: string;
  authedFetch: typeof fetch;
  onSent: () => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [phase, setPhase] = useState<SendPhase>({ p: "form" });
  const [checking, setChecking] = useState(false);

  // A lingering "Sent ✓" / "Declined" from the previous attempt reads as a
  // verdict on what's being typed now — drop it as soon as any field changes.
  const clearVerdict = () => {
    setPhase((ph) => (ph.p === "sent" || ph.p === "error" ? { p: "form" } : ph));
  };

  const did = getDid();
  const amountNum = Number(amount);
  const validAmount = Number.isInteger(amountNum) && amountNum > 0;
  const withinBalance = amountNum <= view.balance;
  const validTo =
    (to.startsWith("http://") || to.startsWith("https://")) && to !== view.owner;
  const canReview = validAmount && withinBalance && validTo && did != null;
  // Name the blocker instead of silently disabling Review — but only once the
  // user has typed something invalid (an empty form needs no nagging).
  const hint =
    to && to === view.owner
      ? "That’s your own WebID — enter someone else’s."
      : to && !validTo
        ? "The recipient must be a WebID URL (starts with http:// or https://)."
        : amount && !validAmount
          ? `The amount must be a whole number of ${view.unit}, above zero.`
          : amount && !withinBalance
            ? `That’s more than your balance — you have ${fmt.format(view.balance)} ${view.unit}.`
            : null;

  // Transfers can't be recalled, and the ledger happily records a transfer to a
  // typo'd WebID — so prove someone actually answers at that address (and show
  // their profile name on the review card) before offering the signature.
  const review = useCallback(async () => {
    setChecking(true);
    try {
      const res = await authedFetch(to.split("#")[0], {
        headers: { Accept: "text/turtle" },
      });
      if (!res.ok) {
        setPhase({
          p: "error",
          message: `Nobody answers at that WebID (HTTP ${res.status}) — check it for typos. Transfers can’t be recalled.`,
        });
        return;
      }
      const toName = (await readProfile(to)).displayName;
      setPhase({ p: "review", to, toName, amount: amountNum, memo });
    } catch {
      setPhase({
        p: "error",
        message: "Couldn’t reach that WebID — check it for typos. Transfers can’t be recalled.",
      });
    } finally {
      setChecking(false);
    }
  }, [authedFetch, to, amountNum, memo]);

  const send = useCallback(
    async (recipient: string, amt: number, note: string) => {
      setPhase({ p: "sending" });
      // Always sign against a FRESHLY fetched head (replay safety, PRD-WALLET §4).
      const fresh = await fetchTokens(authedFetch, origin);
      if (fresh.status !== "ok") {
        setPhase({ p: "error", message: "Could not re-check the ledger before sending." });
        return;
      }
      const myDid = getDid();
      if (!myDid) {
        setPhase({ p: "error", message: "No wallet on this device — Send is unavailable." });
        return;
      }
      try {
        // Lazy one-time DID registration (PRD-WALLET §9.5).
        if (fresh.view.did !== myDid) {
          await registerSigningDid(authedFetch, origin, myDid);
        }
        let transfer = buildTransfer({
          amount: amt,
          from: fresh.view.owner,
          to: recipient,
          memo: note,
          headSeq: fresh.view.seq,
          headHash: fresh.view.head_hash,
        });
        let res = await submitTransfer(origin, transfer, await walletSign(canonicalTransfer(transfer)));
        if (res.status === "conflict") {
          // Stale head (a meter charge can land between fetch and submit):
          // rebuild against the server-reported head and re-sign — never
          // blind-retry the same bytes.
          transfer = {
            ...transfer,
            nonce: crypto.randomUUID(),
            prev_hash: res.expectedPrevHash,
            seq: res.expectedSeq,
          };
          res = await submitTransfer(origin, transfer, await walletSign(canonicalTransfer(transfer)));
        }
        if (res.status === "ok") {
          setPhase({ p: "sent", seq: res.seq });
          setTo("");
          setAmount("");
          setMemo("");
          await onSent();
        } else if (res.status === "declined") {
          setPhase({
            p: "error",
            message: `Declined — insufficient balance (you have ${fmt.format(res.balance)} ${view.unit}).`,
          });
        } else if (res.status === "conflict") {
          setPhase({
            p: "error",
            message: "The ledger moved twice while sending — refresh and try again.",
          });
        } else {
          setPhase({ p: "error", message: res.detail });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Signing failed.";
        if (msg.toLowerCase().includes("locked")) {
          setPhase({ p: "error", message: "Your wallet is locked.", locked: true });
        } else {
          setPhase({ p: "error", message: msg });
        }
      }
    },
    [authedFetch, origin, onSent, view.unit]
  );

  return (
    <section
      className="wallet-rise rounded-xl border bg-card/60 p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
      style={{ animationDelay: "60ms" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
          Send {view.unit}
        </h2>
        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-400">
          feeless
        </span>
      </div>

      {phase.p === "review" ? (
        <div className="space-y-4">
          {/* the document about to be signed */}
          <div className="rounded-lg border border-dashed border-amber-500/30 bg-background/60 p-4">
            <dl className="space-y-1.5 text-sm">
              {phase.toName && <Row k="To" v={phase.toName} />}
              <Row k={phase.toName ? "WebID" : "To"} v={phase.to} mono />
              <Row k="Amount" v={`${fmt.format(phase.amount)} ${view.unit}`} />
              {phase.memo && <Row k="Memo" v={phase.memo} />}
              <Row k="Fee" v="0 — feeless" />
            </dl>
            <p className="mt-3 border-t border-dashed border-border pt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Ed25519 · signed in the sealed core — the key never enters the page
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void send(phase.to, phase.amount, phase.memo)}>
              Sign &amp; send
            </Button>
            <Button variant="outline" onClick={() => setPhase({ p: "form" })}>
              Back
            </Button>
          </div>
        </div>
      ) : phase.p === "sending" ? (
        <p className="animate-pulse text-sm text-muted-foreground">Signing and submitting…</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div className="space-y-1">
              <Label htmlFor="wallet-send-to">Recipient WebID</Label>
              <Input
                id="wallet-send-to"
                placeholder="http://localhost:3061/their-pod/profile/card#me"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value.trim());
                  clearVerdict();
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wallet-send-amount">Amount ({view.unit})</Label>
              <Input
                id="wallet-send-amount"
                inputMode="numeric"
                placeholder="0"
                className="tabular-nums"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value.trim());
                  clearVerdict();
                }}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wallet-send-memo">Memo (optional)</Label>
            <Input
              id="wallet-send-memo"
              placeholder="What's it for?"
              value={memo}
              onChange={(e) => {
                setMemo(e.target.value);
                clearVerdict();
              }}
            />
          </div>

          {phase.p === "sent" && (
            <p className="text-sm text-emerald-400">
              Sent ✓ — recorded at <span className="font-mono">#{phase.seq}</span>.
            </p>
          )}
          {phase.p === "error" && (
            <p className="text-sm text-destructive">
              {phase.message}{" "}
              {phase.locked && (
                <Link href="/connect" className="underline">
                  Unlock at /connect
                </Link>
              )}
            </p>
          )}
          {hint && phase.p === "form" && (
            <p className="text-sm text-muted-foreground" role="status">
              {hint}
            </p>
          )}
          {!did && (
            <p className="text-sm text-muted-foreground">
              Sending needs a wallet identity on this device —{" "}
              <Link href="/connect" className="underline">
                set one up at /connect
              </Link>
              .
            </p>
          )}

          <Button disabled={!canReview || checking} onClick={() => void review()}>
            {checking ? "Checking recipient…" : "Review"}
          </Button>
        </div>
      )}
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
      <dd className={`min-w-0 break-all ${mono ? "font-mono text-xs leading-5" : ""}`}>{v}</dd>
    </div>
  );
}
