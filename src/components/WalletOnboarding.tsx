"use client";

/**
 * Wallet-first onboarding (PRD-DID — the new-user "zero-to-pod" flow).
 *
 * The DID-rooted alternative to signing into a pre-existing account: a brand-new
 * user creates a master identity (a local `did:key`) and the shell mints their
 * FIRST passport — a fresh account + WebID + pod on a stock server — with a
 * password the shell generates and they never see. No pre-existing account, no
 * server-password typed, no redirect.
 *
 * It needs NO OIDC session to run: account creation is the unauthenticated CSS
 * account API ({@link provisionPassport}), the wallet is local crypto, and
 * {@link loginAsPassport} establishes a headless passport session that the
 * platform reports as "logged in" — so the SPA navigation to /shell lands the
 * user inside as their new identity (the shell's auth guard is satisfied without
 * ever touching `handleIncomingRedirect`).
 *
 * Two modes, chosen by wallet state:
 *   - none  → "Create a new identity" (create wallet → provision first passport).
 *   - locked→ "Unlock & continue" (returning wallet user resumes headlessly into
 *             their passport — keeps the wallet-rooted flow coherent across a
 *             hard reload, which otherwise drops the in-memory passport session).
 *
 * Security: the master password goes straight to the audited core (never stored/
 * logged); the generated account password is used once and dropped; the durable
 * passport key is sealed in the encrypted registry (AGENTS.md rules #1, #5).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@mind-studio/ui";
import { DEFAULT_ISSUER } from "@/lib/solid/session";
import {
  getView,
  getDid,
  getPassports,
  createWallet,
  unlockWallet,
  addPassport,
} from "@/lib/identity/wallet";
import { provisionPassport } from "@/lib/identity/provision";
import { enterPassport } from "@/lib/identity/passport-login";
import { LAST_ACTIVE_PASSPORT_KEY, type Passport } from "@/lib/identity/types";

type WalletStatus = "unknown" | "none" | "locked" | "unlocked";

export default function WalletOnboarding() {
  const router = useRouter();
  const [status, setStatus] = useState<WalletStatus>("unknown");
  const [mode, setMode] = useState<"create" | "unlock">("create");

  // Read wallet state AFTER mount (localStorage is client-only) to stay
  // hydration-safe; pick the mode that fits a returning vs. brand-new device.
  useEffect(() => {
    const s = getView().status;
    setStatus(s);
    setMode(s === "none" ? "create" : "unlock");
  }, []);

  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [label, setLabel] = useState("");
  const [server, setServer] = useState(DEFAULT_ISSUER);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "unlock">("");
  const [error, setError] = useState<string | null>(null);

  // Create (or finish creating) a DID-rooted identity and land in the shell.
  // Idempotent: a retry after a provisioning hiccup reuses the existing wallet
  // and only re-attempts the parts that didn't finish.
  const createIdentity = async () => {
    setError(null);
    if (pw.length < 8) return setError("Use at least 8 characters for your master password.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setBusy("create");
    try {
      const s = getView().status;
      if (s === "none") await createWallet(pw);
      else if (s === "locked") await unlockWallet(pw);
      const did = getDid();
      if (!did) throw new Error("Could not initialize your identity.");

      let passport = getPassports()[0];
      if (!passport) {
        passport = await provisionPassport({ did, server, label: label.trim() || "Personal" });
        await addPassport(passport);
      }
      await enterPassport(passport); // headless sign-in + initialize the new pod
      router.replace("/shell"); // SPA nav keeps the in-memory passport session
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your identity.");
      setBusy("");
    }
  };

  // Returning wallet user: unlock and resume headlessly into a passport.
  const unlockAndContinue = async () => {
    setError(null);
    setBusy("unlock");
    try {
      await unlockWallet(pw); // throws on a wrong password (core AEAD tag check)
      const passports = getPassports();
      // Resume the SAME identity the user last used (background-resume pointer),
      // falling back to any client-credentials passport, then the first one.
      const lastId =
        typeof window !== "undefined"
          ? localStorage.getItem(LAST_ACTIVE_PASSPORT_KEY)
          : null;
      const isCc = (p: Passport) => p.creds?.kind === "client-credentials";
      const resumable =
        (lastId && passports.find((p) => p.id === lastId && isCc(p))) ||
        passports.find(isCc) ||
        passports[0];
      if (!resumable) {
        // Unlocked, but no pod yet — let them provision their first.
        setMode("create");
        setBusy("");
        return;
      }
      if (resumable.creds?.kind !== "client-credentials") {
        setError('This pod needs a manual sign-in — use "Continue with Mind" below.');
        setBusy("");
        return;
      }
      await enterPassport(resumable);
      router.replace("/shell");
    } catch {
      setError("That master password didn't unlock your identity.");
      setBusy("");
    }
  };

  if (status === "unknown") {
    return <div className="h-40 rounded-2xl border border-[color:var(--border)] bg-card/50" />;
  }

  if (mode === "unlock") {
    return (
      <Card>
        <Eyebrow>Welcome back</Eyebrow>
        <h2 className="mt-1 text-lg font-semibold">Unlock your identity</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your master key lives on this device. Enter your master password to
          continue into your pod — no server password needed.
        </p>
        <div className="mt-4 space-y-3">
          <Field
            id="ob-unlock-pw"
            label="Master password"
            type="password"
            value={pw}
            onChange={setPw}
            onEnter={() => void unlockAndContinue()}
            autoComplete="current-password"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={() => void unlockAndContinue()} disabled={busy !== ""} className="w-full">
            {busy === "unlock" ? "Unlocking…" : "Unlock & continue"}
          </Button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("create");
            }}
            className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Create a different identity instead
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Eyebrow>New to Mind</Eyebrow>
      <h2 className="mt-1 text-lg font-semibold">Create a new identity</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We generate your keys on this device and create your first pod — with a
        strong password the shell stores for you (you never type or see one).
      </p>
      <div className="mt-4 space-y-3">
        <Field
          id="ob-label"
          label="Name this identity"
          value={label}
          onChange={setLabel}
          placeholder="Personal"
        />
        <Field
          id="ob-pw"
          label="Master password"
          type="password"
          value={pw}
          onChange={setPw}
          autoComplete="new-password"
        />
        <Field
          id="ob-confirm"
          label="Confirm master password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          onEnter={() => void createIdentity()}
          autoComplete="new-password"
        />

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showAdvanced ? "Hide options" : "Options (server)"}
        </button>
        {showAdvanced && (
          <div className="space-y-3 rounded-lg border border-[color:var(--border)] p-3">
            <Field id="ob-server" label="Server" value={server} onChange={setServer} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => void createIdentity()} disabled={busy !== ""} className="w-full">
          {busy === "create" ? "Creating your identity & pod…" : "Create my identity"}
        </Button>
        <p className="rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
          Your master password is the one thing to remember — it unlocks this
          identity and every pod the shell creates for you. It never leaves your
          device.
        </p>
        {status === "locked" && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("unlock");
            }}
            className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Unlock my existing identity instead
          </button>
        )}
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[color:var(--border)] bg-card p-5 shadow-sm">
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">{children}</p>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  placeholder,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  onEnter?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
    </div>
  );
}
