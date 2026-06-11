"use client";

/**
 * On-page email+password sign-in for an existing CSS account (PRD §1 — "no jump
 * to an external IdP"). The redirect-free counterpart to `MindLoginCard`: the
 * user types their account email+password right here and lands in /shell, no
 * full-page bounce to the IdP.
 *
 * Flow (all client-side — `src/lib/solid/account-login.ts`):
 *   loginToAccount → accountWebIds → mintClientCredentials → loginWithClientCredentials
 * then, if a wallet is unlocked, seal the minted credentials as a resumable
 * `client-credentials` passport so next visit resumes headlessly (background
 * resume). The typed password + account token are used once and dropped; the
 * durable creds live only in the encrypted wallet or this tab's memory — never on
 * a pod, never logged (AGENTS.md rules #2, #5).
 *
 * CSS-only: external OIDC issuers and native still use the redirect path below it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@mind-studio/ui";
import { rememberIssuer, storedIssuer } from "@/lib/solid/session";
import {
  loginToAccount,
  accountWebIds,
  mintClientCredentials,
  podRootFromWebId,
} from "@/lib/solid/account-login";
import { loginWithClientCredentials } from "@/lib/identity/passport-login";
import { getView, getDid, addPassport, newPassportId } from "@/lib/identity/wallet";

export default function PasswordLoginCard() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Lazy init: the last server actually signed into (WorkspaceRail does the
  // same), so a localhost/self-hosted user isn't silently sent back to prod.
  const [server, setServer] = useState(() => storedIssuer());
  const [showServer, setShowServer] = useState(false);
  // When an account links several WebIDs, we surface a picker instead of guessing.
  const [choices, setChoices] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(chosenWebId?: string) {
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your account email and password.");
      return;
    }
    setBusy(true);
    try {
      const token = await loginToAccount(email.trim(), password, server);

      let webId = chosenWebId;
      if (!webId) {
        const webIds = await accountWebIds(token, server);
        if (webIds.length === 0) {
          throw new Error("This account has no pod yet — create one first.");
        }
        if (webIds.length > 1) {
          setChoices(webIds); // let the user pick; signIn re-runs with the choice
          setBusy(false);
          return;
        }
        webId = webIds[0];
      }

      const creds = await mintClientCredentials(token, webId, server);
      const podRoot = podRootFromWebId(webId);
      const label = email.split("@")[0] || "Account";
      const passportId = newPassportId();

      await loginWithClientCredentials({
        passportId,
        server,
        webId,
        podRoot,
        label,
        id: creds.id,
        secret: creds.secret,
      });

      // Persist the issuer so every storedIssuer() consumer (workspace
      // provisioning, DID probe, next sign-in) targets the server this
      // session actually lives on — not the prod default.
      rememberIssuer(server);

      // If a wallet is unlocked, seal these credentials as a resumable passport so
      // the next visit resumes this identity headlessly. Best-effort: the session
      // is already active, so a sealing failure just means re-login next time.
      if (getView().status === "unlocked") {
        const did = getDid();
        if (did) {
          await addPassport({
            id: passportId,
            did,
            server: server.replace(/\/$/, ""),
            webId,
            podRoots: [podRoot],
            label,
            createdAt: new Date().toISOString(),
            creds: { kind: "client-credentials", id: creds.id, secret: creds.secret },
          }).catch(() => {
            /* sealing is best-effort; the session is already live */
          });
        }
      }

      router.replace("/shell");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  if (choices) {
    return (
      <Card>
        <Eyebrow>Choose a pod</Eyebrow>
        <h2 className="mt-1 text-lg font-semibold">This account has several pods</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the WebID to continue as.
        </p>
        <div className="mt-4 space-y-2">
          {choices.map((w) => {
            // Lead with the pod name (last path segment of the pod root, e.g.
            // "alice") — a raw WebID URL is hard to scan; keep it as a subline.
            const podName =
              podRootFromWebId(w).replace(/\/$/, "").split("/").pop() || w;
            return (
              <button
                key={w}
                type="button"
                disabled={busy}
                onClick={() => void signIn(w)}
                className="w-full rounded-lg border border-[color:var(--border)] bg-card px-3 py-2 text-left hover:border-primary/50"
              >
                <span className="block text-sm font-medium capitalize">{podName}</span>
                <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
                  {w}
                </span>
              </button>
            );
          })}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            onClick={() => {
              setChoices(null);
              setError(null);
            }}
            className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Back
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Eyebrow>Sign in</Eyebrow>
      <h2 className="mt-1 text-lg font-semibold">Use your pod password</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign in right here with your account email and password — no redirect.
      </p>
      {/* A real <form> so Enter submits from any field and the browser's
          password manager can offer to save/fill the credentials. */}
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <Field
          id="pw-email"
          label="Account email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
        />
        <Field
          id="pw-password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />

        <button
          type="button"
          onClick={() => setShowServer((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showServer ? "Hide server" : "Different server?"}
        </button>
        {showServer && (
          <div className="space-y-3 rounded-lg border border-[color:var(--border)] p-3">
            <Field id="pw-server" label="Server" value={server} onChange={setServer} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
