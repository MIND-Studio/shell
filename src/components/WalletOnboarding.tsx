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

import { Button, Input, Label } from "@mind-studio/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { enterPassport, loginWithDidSession } from "@/lib/identity/passport-login";
import { provisionPassport } from "@/lib/identity/provision";
import { LAST_ACTIVE_PASSPORT_KEY, type Passport } from "@/lib/identity/types";
import {
  addPassport,
  createWallet,
  getDid,
  getPassports,
  getView,
  newPassportId,
  unlockWallet,
  sign as walletSign,
} from "@/lib/identity/wallet";
import { serverSupportsDid } from "@/lib/solid/did-account";
import { writeProfileName } from "@/lib/solid/profile";
import { rememberIssuer, storedIssuer } from "@/lib/solid/session";

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
  // Lazy init: the last server actually signed into (same as PasswordLoginCard),
  // so a localhost/self-hosted user's new identity isn't provisioned on prod.
  const [server, setServer] = useState(() => storedIssuer());
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
      if (s === "none") {
        await createWallet(pw);
      } else if (s === "locked") {
        // A wallet already lives on this device; a wrong password here would
        // otherwise surface as a baffling generic "could not create" dead end.
        try {
          await unlockWallet(pw);
        } catch {
          setError(
            "This device already holds an identity wallet, and that master password doesn't match it. Unlock your existing identity instead, or sign in with a different account below.",
          );
          setBusy("");
          return;
        }
      }
      const did = getDid();
      if (!did) throw new Error("Could not initialize your identity.");

      const name = label.trim() || "Personal";
      let passport = getPassports()[0];
      let provisioned = false;
      if (passport) {
        // Returning wallet on this device — resume its existing identity.
        await enterPassport(passport);
      } else if (await serverSupportsDid(server)) {
        // Server-side DID login (e.g. solid-server-rs): prove control of the
        // master DID by signing a challenge — the server auto-provisions the pod
        // on first login. No CSS account API, no stored password, no redirect.
        const origin = server.replace(/\/$/, "");
        const passportId = newPassportId();
        const { webId, podRoot } = await loginWithDidSession({
          passportId,
          server: origin,
          did,
          sign: walletSign,
          label: name,
        });
        passport = {
          id: passportId,
          did,
          server: origin,
          webId,
          podRoots: [podRoot],
          label: name,
          createdAt: new Date().toISOString(),
          didLinked: true,
          creds: { kind: "did" },
        };
        await addPassport(passport); // session already active + pod seeded
        provisioned = true;
      } else {
        // Stock CSS — provision a fresh-WebID passport via the account API, then
        // sign in headlessly with the minted client-credentials.
        passport = await provisionPassport({ did, server, label: name });
        await addPassport(passport);
        await enterPassport(passport);
        provisioned = true;
      }
      // Greet the user by the name they typed: stamp it on the fresh profile so
      // the rail and account switcher don't show the server's auto-generated
      // placeholder. Best-effort — onboarding must not fail on a cosmetic write.
      if (provisioned && label.trim()) {
        try {
          await writeProfileName(passport.webId, label.trim());
        } catch {}
      }
      // Persist the issuer the passport actually lives on so every storedIssuer()
      // consumer (workspace provisioning, DID probe, next sign-in) targets it.
      rememberIssuer(passport.server.endsWith("/") ? passport.server : passport.server + "/");
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
      // falling back to any headlessly-resumable passport, then the first one. A
      // passport resumes with no input when the unlocked wallet can re-establish
      // its session: client-credentials (re-mint a token) or DID (re-sign a
      // challenge — solid-server-rs). Manual/password logins can't.
      const lastId =
        typeof window !== "undefined" ? localStorage.getItem(LAST_ACTIVE_PASSPORT_KEY) : null;
      const canResume = (p: Passport) =>
        p.creds?.kind === "client-credentials" || p.creds?.kind === "did";
      const resumable =
        (lastId && passports.find((p) => p.id === lastId && canResume(p))) ||
        passports.find(canResume) ||
        passports[0];
      if (!resumable) {
        // Unlocked, but no pod yet — let them provision their first.
        setMode("create");
        setBusy("");
        return;
      }
      if (!canResume(resumable)) {
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
          Your master key lives on this device. Enter your master password to continue into your pod
          — no server password needed.
        </p>
        {/* A real <form> so Enter submits and password managers can fill. */}
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void unlockAndContinue();
          }}
        >
          <Field
            id="ob-unlock-pw"
            label="Master password"
            type="password"
            value={pw}
            onChange={setPw}
            autoComplete="current-password"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy !== ""} className="w-full">
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
            Finish setting up your identity instead
          </button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <Eyebrow>New to Mind</Eyebrow>
      <h2 className="mt-1 text-lg font-semibold">Create a new identity</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We generate your keys on this device and create your first pod — with a strong password the
        shell stores for you (you never type or see one).
      </p>
      {/* A real <form> so Enter submits and password managers can fill. */}
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void createIdentity();
        }}
      >
        <Field
          id="ob-label"
          label="Name this identity"
          value={label}
          onChange={setLabel}
          placeholder="Personal"
          autoComplete="off"
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

        {status === "locked" && (
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-700 dark:text-amber-200">
            This device already holds an identity wallet (one per device for now). Your master
            password must match it — this form finishes its setup or resumes it, rather than
            starting over.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy !== ""} className="w-full">
          {busy === "create" ? "Creating your identity & pod…" : "Create my identity"}
        </Button>
        <p className="rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
          Your master password is the one thing to remember — it unlocks this identity and every pod
          the shell creates for you. It never leaves your device.
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
      </form>
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
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
      />
    </div>
  );
}
