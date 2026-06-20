"use client";

/**
 * MIND token ledger client (PRD-WALLET §3/§4) — the typed surface over the
 * server-origin `/.tokens` API that `solid-server-rs` ships (solidrs-ledger).
 *
 * `/.tokens` is a RESERVED server route, not a pod resource: it is reached with
 * the shell's own authenticated session fetch (passed in by the caller), never
 * through the capability bridge. The server ledger is authoritative — this
 * module only views it and submits user-signed transfers; it never invents
 * balances.
 *
 * Canonical signing contract (crates/solidrs-ledger/src/service.rs):
 * `canonical_transfer` is serde's serialization of `SignedTransfer`, whose
 * fields are declared ALPHABETICALLY — identical to `JSON.stringify` of an
 * object constructed with alphabetical key insertion order. {@link buildTransfer}
 * constructs exactly that; do not reorder its keys.
 *
 * Never logged here: amounts, memos, transfer bodies (AGENTS.md rule #5 /
 * PRD-WALLET §5). The caller may log route + status only.
 */

export interface LedgerEntry {
  /** 1-based position in the owner's chain. */
  seq: number;
  prev_hash: string;
  /** RFC 3339 record time (advisory). */
  ts: string;
  /** `mint` | `debit` | `meter` | `transfer-out` | `transfer-in`. */
  kind: string;
  /** The other party's WebID for transfers; absent for server/operator ops. */
  counterparty?: string;
  /** Signed balance delta (credits positive). */
  amount: number;
  memo: string;
  sig?: string;
  hash: string;
}

/** `GET /.tokens` — the caller's own account (owner-scoped). */
export interface TokensView {
  owner: string;
  unit: string;
  balance: number;
  /** Current chain seq (0 for an empty chain). */
  seq: number;
  /** Last entry's hash (`"genesis"` for an empty chain). */
  head_hash: string;
  /** The registered signing did:key, or null. */
  did: string | null;
  history: LedgerEntry[];
  transfers_enabled: boolean;
}

export type TokensResult =
  | { status: "ok"; view: TokensView }
  | { status: "unauthorized" }
  /** 404 — this server has no ledger routes at all (e.g. stock CSS). */
  | { status: "unsupported" }
  /** 503 — ledger supported but switched off (no `--ledger on`). */
  | { status: "disabled" }
  | { status: "error"; detail: string };

/**
 * The ledger lives on the SAME origin as the account's WebID (it is
 * account-scoped, not pod-scoped) — derive it from the WebID rather than the
 * stored issuer, which may point at a different server while a passport
 * session is active (PRD-WALLET §9.1).
 */
export function ledgerOrigin(webId: string): string {
  return new URL(webId).origin + "/";
}

/** Fetch the caller's balance + signed history. Never throws on HTTP errors. */
export async function fetchTokens(fetchFn: typeof fetch, origin: string): Promise<TokensResult> {
  let res: Response;
  try {
    res = await fetchFn(`${origin}.tokens`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return { status: "error", detail: "Can't reach the server." };
  }
  if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
  if (res.status === 404) return { status: "unsupported" };
  if (res.status === 503) return { status: "disabled" };
  if (!res.ok) return { status: "error", detail: `Ledger lookup failed (${res.status}).` };
  try {
    const view = (await res.json()) as TokensView;
    return { status: "ok", view };
  } catch {
    return { status: "error", detail: "Ledger returned an unreadable response." };
  }
}

/** `POST /.tokens/did` — register the caller's signing did:key (204 on success). */
export async function registerSigningDid(
  fetchFn: typeof fetch,
  origin: string,
  did: string,
): Promise<void> {
  const res = await fetchFn(`${origin}.tokens/did`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did }),
  });
  if (!res.ok) {
    throw new Error(`Could not register the signing DID (${res.status}).`);
  }
}

/**
 * A user-authorized transfer. Field order is ALPHABETICAL and load-bearing:
 * `JSON.stringify` of this object must byte-match the server's
 * `canonical_transfer` (serde, alphabetical declaration order).
 */
export interface SignedTransfer {
  amount: number;
  from: string;
  memo: string;
  nonce: string;
  prev_hash: string;
  purpose: "token-transfer";
  seq: number;
  to: string;
}

/**
 * Build a transfer pinned to a freshly fetched chain head. `headSeq`/`headHash`
 * are the CURRENT head from {@link fetchTokens} — the transfer carries the next
 * seq. Keys are inserted alphabetically; do not reorder.
 */
export function buildTransfer(opts: {
  amount: number;
  from: string;
  to: string;
  memo: string;
  headSeq: number;
  headHash: string;
}): SignedTransfer {
  return {
    amount: opts.amount,
    from: opts.from,
    memo: opts.memo,
    nonce: crypto.randomUUID(),
    prev_hash: opts.headHash,
    purpose: "token-transfer",
    seq: opts.headSeq + 1,
    to: opts.to,
  };
}

/** The exact byte string the signature must cover. */
export function canonicalTransfer(t: SignedTransfer): string {
  return JSON.stringify(t);
}

export type TransferResult =
  | { status: "ok"; seq: number }
  /** 409 — stale/replayed head; rebuild against the reported head, re-sign. */
  | { status: "conflict"; expectedSeq: number; expectedPrevHash: string }
  /** 402 — insufficient balance. */
  | { status: "declined"; balance: number }
  /** 403 — signature rejected, or transfers switched off server-side. */
  | { status: "forbidden"; detail: string }
  | { status: "error"; detail: string };

/**
 * `POST /.tokens/transfer`. The body is self-authenticating (the DID signature
 * IS the authorization), so a plain fetch suffices — no session attached.
 */
export async function submitTransfer(
  origin: string,
  transfer: SignedTransfer,
  proofB64: string,
): Promise<TransferResult> {
  let res: Response;
  try {
    res = await fetch(`${origin}.tokens/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transfer, proof: proofB64 }),
    });
  } catch {
    return { status: "error", detail: "Can't reach the server." };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { seq?: number };
    return { status: "ok", seq: body.seq ?? transfer.seq };
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    expected_seq?: number;
    expected_prev_hash?: string;
    balance?: number;
    detail?: string;
  };
  if (res.status === 409 && body.expected_seq != null) {
    return {
      status: "conflict",
      expectedSeq: body.expected_seq,
      expectedPrevHash: body.expected_prev_hash ?? "",
    };
  }
  if (res.status === 402) {
    return { status: "declined", balance: body.balance ?? 0 };
  }
  if (res.status === 403) {
    return {
      status: "forbidden",
      detail:
        body.error === "transfers_disabled"
          ? "Transfers are disabled on this server."
          : "The server rejected the transfer signature.",
    };
  }
  return { status: "error", detail: body.error ?? `Transfer failed (${res.status}).` };
}

// ---- pod snapshot (the Home widget's only data source) -----------------------

/**
 * The non-authoritative cache the Wallet writes to `{appZone}snapshot.json` so
 * the sandboxed Balance widget (pod-I/O-only bridge) has something to render.
 * Derived data only — no sigs, no keys, no memos (PRD-WALLET §3).
 */
export interface WalletSnapshot {
  balance: number;
  unit: string;
  recent: { kind: string; amount: number; counterparty?: string; ts: string }[];
  syncedAt: string;
}

export function toSnapshot(view: TokensView): WalletSnapshot {
  const recent = [...view.history]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 5)
    .map((e) => ({
      kind: e.kind,
      amount: e.amount,
      ...(e.counterparty ? { counterparty: e.counterparty } : {}),
      ts: e.ts,
    }));
  return {
    balance: view.balance,
    unit: view.unit,
    recent,
    syncedAt: new Date().toISOString(),
  };
}
