"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Separator } from "@mind-studio/ui";
import type { AsyncCryptoCore } from "@/lib/platform";
import type { VaultItemMeta, VaultItemSecret } from "@/lib/vault/model";
import { copyWithAutoClear } from "@/lib/vault/clipboard";

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const REVEAL_TTL_MS = 30_000;

type BreachState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "safe" }
  | { status: "pwned"; count: number }
  | { status: "error"; message: string };

/**
 * Read-only detail of a decrypted item: reveal/copy password (copy auto-clears),
 * a live TOTP code, and a HIBP k-anonymity breach check. The full password
 * NEVER leaves the device — only the 5-char SHA-1 prefix is queried.
 */
export function ItemDetail({
  core,
  meta,
  secret,
  onEdit,
  onDelete,
}: {
  core: AsyncCryptoCore;
  meta: VaultItemMeta;
  secret: VaultItemSecret;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [totp, setTotp] = useState<string | null>(null);
  const [totpRemaining, setTotpRemaining] = useState(TOTP_PERIOD);
  const [breach, setBreach] = useState<BreachState>({ status: "idle" });

  // Reset transient state when switching items.
  useEffect(() => {
    setRevealed(false);
    setBreach({ status: "idle" });
  }, [meta.id]);

  // Display values are short-lived (crypto contract): a revealed password
  // re-masks after 30s, matching the clipboard's auto-clear window.
  useEffect(() => {
    if (!revealed) return;
    const id = setTimeout(() => setRevealed(false), REVEAL_TTL_MS);
    return () => clearTimeout(id);
  }, [revealed]);

  // TOTP tick.
  useEffect(() => {
    if (!secret.totpSecret) {
      setTotp(null);
      return;
    }
    let cancelled = false;
    const update = async () => {
      const now = Math.floor(Date.now() / 1000);
      try {
        const code = await core.totpAt(secret.totpSecret as string, now, TOTP_PERIOD, TOTP_DIGITS);
        if (!cancelled) setTotp(code);
      } catch {
        if (!cancelled) setTotp(null);
      }
      if (!cancelled) setTotpRemaining(TOTP_PERIOD - (now % TOTP_PERIOD));
    };
    void update();
    const id = setInterval(() => void update(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [core, secret.totpSecret]);

  const checkBreach = useCallback(async () => {
    if (!secret.password) return;
    setBreach({ status: "checking" });
    try {
      const { prefix, suffix } = await core.hibpPrefix(secret.password);
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
      if (!res.ok) throw new Error(`HIBP ${res.status}`);
      const body = await res.text();
      const want = suffix.toUpperCase();
      let count = 0;
      for (const line of body.split("\n")) {
        const [sfx, c] = line.trim().split(":");
        if (sfx && sfx.toUpperCase() === want) {
          count = parseInt(c ?? "0", 10) || 0;
          break;
        }
      }
      setBreach(count > 0 ? { status: "pwned", count } : { status: "safe" });
    } catch (e) {
      setBreach({ status: "error", message: e instanceof Error ? e.message : "check failed" });
    }
  }, [core, secret.password]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">{meta.title}</h3>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{meta.kind}</p>
      </div>
      <Separator />

      {meta.url && (
        <Field label="URL">
          <a
            href={meta.url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-sm text-primary underline"
          >
            {meta.url}
          </a>
        </Field>
      )}

      {meta.username && (
        <Field label="Username">
          <div className="flex items-center gap-2">
            <span className="break-all font-mono text-sm">{meta.username}</span>
            <CopyBtn value={meta.username} />
          </div>
        </Field>
      )}

      {/* A login with no password renders an explicit "not set" row rather than
          omitting the field — so an empty password reads as a deliberate state,
          not a missing UI. Notes/cards have no password concept, so skip them. */}
      {!secret.password && meta.kind === "login" && (
        <Field label="Password">
          <span className="text-sm text-muted-foreground">— No password set</span>
        </Field>
      )}

      {secret.password && (
        <Field label="Password">
          <div className="flex items-center gap-2">
            <span className="break-all font-mono text-sm">
              {revealed ? secret.password : "••••••••••••"}
            </span>
            <Button size="sm" variant="outline" onClick={() => setRevealed((r) => !r)}>
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <CopyBtn value={secret.password} />
          </div>
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={checkBreach}>
              {breach.status === "checking" ? "Checking…" : "Check breaches"}
            </Button>
            {breach.status === "safe" && (
              <span className="ml-2 text-sm text-emerald-500">Not found in known breaches.</span>
            )}
            {breach.status === "pwned" && (
              <span className="ml-2 text-sm text-destructive">
                Seen in {breach.count.toLocaleString()} breaches — change it.
              </span>
            )}
            {breach.status === "error" && (
              <span className="ml-2 text-sm text-destructive">Check failed: {breach.message}</span>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Only the first 5 characters of the password&apos;s SHA-1 hash are sent (HIBP
              k-anonymity). The password never leaves this device.
            </p>
          </div>
        </Field>
      )}

      {secret.totpSecret && (
        <Field label="One-time code (TOTP)">
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg tracking-widest">{totp ?? "------"}</span>
            {totp && <CopyBtn value={totp} />}
            <span className="text-xs text-muted-foreground">{totpRemaining}s</span>
          </div>
        </Field>
      )}

      {secret.cardNumber && (
        <Field label="Card number">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{secret.cardNumber}</span>
            <CopyBtn value={secret.cardNumber} />
          </div>
        </Field>
      )}
      {secret.cardholder && <Field label="Cardholder">{secret.cardholder}</Field>}
      {(secret.expiry || secret.cvv) && (
        <Field label="Expiry / CVV">
          {secret.expiry ?? "—"} {secret.cvv ? `· ${secret.cvv}` : ""}
        </Field>
      )}

      {secret.notes && (
        <Field label="Notes">
          <p className="whitespace-pre-wrap text-sm">{secret.notes}</p>
        </Field>
      )}

      <Separator />
      <div className="flex gap-2">
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        await copyWithAutoClear(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}
