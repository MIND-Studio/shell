"use client";

/**
 * Identity — the wallet surface for the DID layer (PRD-DID C1–C4).
 *
 * Hosts the master `did:key` identity and its per-server passports:
 *   - C1: create / unlock / lock the master identity (seed wrapped in the audited
 *     crypto-core envelope; only the public did + signatures ever leave the core).
 *   - C2: provision a passport on a stock CSS server (a FRESH WebID + pod) or
 *     capture one manually; it lands in the ENCRYPTED registry.
 *   - C3: write a signed binding document (did controls WebID) and verify it with
 *     ZERO server support ("prove control").
 *   - C4: passports feed the account switcher + the workspace rail.
 *
 * Zero-knowledge: the master password goes straight into the Rust core and is
 * never stored or logged; the seed never crosses the FFI. The web build keeps the
 * unlocked seed in WASM memory for the session — a documented XSS tradeoff for
 * the prototype (the caveat is shown in the UI).
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@mind-studio/ui";
import { useCallback, useEffect, useState } from "react";
import { readAndVerify, writeBinding } from "@/lib/identity/binding";
import { enterPassport, logoutPassport } from "@/lib/identity/passport-login";
import { captureManualPassport, provisionPassport } from "@/lib/identity/provision";
import { type Passport, walletBackupUrl } from "@/lib/identity/types";
import {
  addPassport,
  createWallet,
  exportBlob,
  lockWallet,
  unlockWallet,
  updatePassport,
  sign as walletSign,
} from "@/lib/identity/wallet";
import { useShell } from "@/lib/shell/context";
import { loginWithDid, serverSupportsDid } from "@/lib/solid/did-account";
import { getActivePassportSession, subscribePassportSession } from "@/lib/solid/passport-session";
import { ensureContainerChain, writeFileText } from "@/lib/solid/pod-fs";
import { useWallet } from "./useWallet";

/** Subscribe to the active passport-session id (null when on the main WebID). */
function useActivePassportId(): string | null {
  const [id, setId] = useState<string | null>(() => getActivePassportSession()?.passportId ?? null);
  useEffect(() => {
    const sync = () => setId(getActivePassportSession()?.passportId ?? null);
    sync();
    return subscribePassportSession(sync);
  }, []);
  return id;
}

export default function IdentityApp() {
  const view = useWallet();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <header className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Mind Shell · Identity
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Your wallet</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A portable master identity (a <code>did:key</code>) that controls your per-server
            passports — without replacing any WebID or changing any server.
          </p>
        </header>

        {view.status === "none" && <CreateScreen />}
        {view.status === "locked" && <UnlockScreen did={view.did!} />}
        {view.status === "unlocked" && (
          <Dashboard
            did={view.did!}
            // Hybrid-workspace records live in the registry only so their
            // generated login stays sealed — they reuse the master WebID, so
            // they're workspaces in the rail, not identities. Listing them here
            // miscounts "Passports" and dead-ends on "Sign in as this passport"
            // (the user never saw the generated password).
            passports={(view.passports ?? []).filter((p) => !p.workspace)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Unlock
// ---------------------------------------------------------------------------

function CreateScreen() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    if (pw.length < 8) return setError("Use at least 8 characters for the master password.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await createWallet(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your identity.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">Create your master identity</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We generate an Ed25519 key inside the audited crypto core and wrap its seed under this
        master password. The seed never leaves the core.
      </p>
      <div className="mt-5 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="id-pw">Master password</Label>
          <Input
            id="id-pw"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="id-pw2">Confirm</Label>
          <Input
            id="id-pw2"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => void create()} disabled={busy} className="w-full">
          {busy ? "Generating…" : "Generate identity"}
        </Button>
        <XssCaveat />
      </div>
    </Card>
  );
}

function UnlockScreen({ did }: { did: string }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    setError(null);
    setBusy(true);
    try {
      await unlockWallet(pw);
    } catch {
      setError("That master password didn't unlock your identity.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">Unlock your identity</h2>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{did}</p>
      <div className="mt-5 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="id-unlock">Master password</Label>
          <Input
            id="id-unlock"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void unlock()}
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => void unlock()} disabled={busy} className="w-full">
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ did, passports }: { did: string; passports: Passport[] }) {
  const { webId, workspacePod, reloadIdentity } = useShell();
  const activePassportId = useActivePassportId();
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const backToMain = async () => {
    setSwitching(true);
    try {
      logoutPassport();
      await reloadIdentity();
    } finally {
      setSwitching(false);
    }
  };

  const copyDid = async () => {
    try {
      await navigator.clipboard.writeText(did);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  // Optional: back up the ENCRYPTED wallet blob to the pod (ciphertext only).
  const backup = async () => {
    setBackupMsg(null);
    const blob = exportBlob();
    if (!blob || !workspacePod) return;
    try {
      const base = workspacePod.endsWith("/") ? workspacePod : workspacePod + "/";
      await ensureContainerChain(`${base}apps/shell/`, workspacePod);
      await writeFileText(walletBackupUrl(workspacePod), blob, "application/json");
      setBackupMsg("Encrypted backup written to your pod.");
    } catch {
      setBackupMsg("Couldn't write the backup (check pod access).");
    }
  };

  const activePassport = passports.find((p) => p.id === activePassportId);

  return (
    <div className="space-y-5">
      {/* Active-passport banner: you're acting as a passport, not your main WebID */}
      {activePassport && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-medium">
              🪪 Signed in as {activePassport.label || hostOf(activePassport.server)}
            </p>
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {activePassport.webId}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              No password typed — the shell signed in for you with this passport&apos;s stored key.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void backToMain()}
            disabled={switching}
          >
            {switching ? "…" : "Back to my account"}
          </Button>
        </div>
      )}

      {/* Master DID */}
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-muted-foreground">Master identity</h2>
            <p data-testid="master-did" className="mt-1 break-all font-mono text-sm font-medium">
              {did}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void lockWallet()}>
            Lock
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void copyDid()}>
            {copied ? "Copied ✓" : "Copy DID"}
          </Button>
          {workspacePod && (
            <Button variant="outline" size="sm" onClick={() => void backup()}>
              Back up to pod (encrypted)
            </Button>
          )}
        </div>
        {backupMsg && <p className="mt-2 text-xs text-muted-foreground">{backupMsg}</p>}
        <XssCaveat />
      </Card>

      {/* This session — bind the currently signed-in WebID to the master DID */}
      {webId && workspacePod && (
        <SessionBindingCard did={did} webId={webId} podRoot={workspacePod} />
      )}

      {/* Passports */}
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Passports ({passports.length})
          </h2>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add passport
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Each passport is a fresh WebID + pod on a server, all controlled by your one master DID.
        </p>
        <div className="mt-4 space-y-3">
          {passports.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No passports yet. Add one to mint a fresh identity on a server.
            </p>
          )}
          {passports.map((p) => (
            <PassportRow
              key={p.id}
              did={did}
              passport={p}
              currentWebId={webId}
              isActiveSession={p.id === activePassportId}
            />
          ))}
        </div>
      </Card>

      {adding && <AddPassportDialog did={did} onClose={() => setAdding(false)} />}
    </div>
  );
}

function SessionBindingCard({
  did,
  webId,
  podRoot,
}: {
  did: string;
  webId: string;
  podRoot: string;
}) {
  const [busy, setBusy] = useState<"" | "bind" | "verify">("");
  const [status, setStatus] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<"ok" | "fail" | null>(null);

  const bind = async () => {
    setBusy("bind");
    setStatus(null);
    setVerdict(null);
    try {
      let server: string;
      try {
        server = new URL(webId).origin;
      } catch {
        server = podRoot;
      }
      await writeBinding({ podRoot, webId, controller: did, server });
      setStatus("Signed binding written to your pod.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not write the binding.");
    } finally {
      setBusy("");
    }
  };

  const verify = async () => {
    setBusy("verify");
    setStatus(null);
    setVerdict(null);
    try {
      const { result } = await readAndVerify(podRoot, did);
      setVerdict(result.ok ? "ok" : "fail");
      setStatus(
        result.ok
          ? "Verified: this WebID is controlled by your DID — checked locally, no server."
          : `Not verified: ${result.reason ?? "unknown"}.`,
      );
    } catch (e) {
      setVerdict("fail");
      setStatus(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setBusy("");
    }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-muted-foreground">This session</h2>
      <p className="mt-1 break-all font-mono text-xs">{webId}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Prove your master DID controls the WebID you're signed in as, by writing a signed binding
        into this pod.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void bind()} disabled={busy !== ""}>
          {busy === "bind" ? "Signing…" : "Bind to my DID"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void verify()}
          disabled={busy !== ""}
          data-testid="verify-session"
        >
          {busy === "verify" ? "Verifying…" : "Verify control"}
        </Button>
        {verdict === "ok" && (
          <span data-testid="verdict-ok" className="text-sm font-medium text-emerald-500">
            ✓ verified
          </span>
        )}
        {verdict === "fail" && (
          <span className="text-sm font-medium text-destructive">✗ not verified</span>
        )}
      </div>
      {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
    </Card>
  );
}

function PassportRow({
  did,
  passport,
  currentWebId,
  isActiveSession,
}: {
  did: string;
  passport: Passport;
  currentWebId: string | null;
  isActiveSession: boolean;
}) {
  const { addWorkspace, reloadIdentity } = useShell();
  const [busy, setBusy] = useState<"" | "bind" | "verify" | "open" | "switch" | "did">("");
  const [status, setStatus] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<"ok" | "fail" | null>(null);
  // DID-login feedback is kept separate from the bind/verify `status` so the two
  // actions don't clobber each other's messages, and so it can be colour-coded.
  const [didMsg, setDidMsg] = useState<string | null>(null);
  const [didVerdict, setDidVerdict] = useState<"ok" | "fail" | null>(null);
  // Whether this passport's server is DID-aware. A known link (`didLinked`) is a
  // definite yes; otherwise we probe once so the UI only offers DID login where
  // it can actually work — no dead-end clicks against stock CSS. null = checking.
  const [didSupported, setDidSupported] = useState<boolean | null>(
    passport.didLinked ? true : null,
  );
  const podRoot = passport.podRoots[0];

  useEffect(() => {
    if (didSupported !== null) return;
    let cancelled = false;
    void serverSupportsDid(passport.server).then((ok) => {
      if (!cancelled) setDidSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [passport.server, didSupported]);

  // A passport's pod is owned (WAC) by ITS WebID, so its actions only work when
  // the active session IS that WebID. The shell can now MAKE that true with no
  // typing and no redirect: a provisioned passport carries client-credentials,
  // so "Switch to this passport" mints a headless session as it (C4). Once
  // active, currentWebId === passport.webId and the bind/verify/open actions
  // light up. Manually-captured passports (no creds) still use /connect.
  const isActive = !!currentWebId && passport.webId === currentWebId;
  const canSwitch =
    !isActive && passport.creds?.kind === "client-credentials" && !!passport.creds.id;

  const switchTo = async () => {
    setBusy("switch");
    setStatus(null);
    try {
      await enterPassport(passport);
      await reloadIdentity();
      setStatus("Signed in as this passport — no password needed.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't sign in as this passport.");
    } finally {
      setBusy("");
    }
  };

  const bind = async () => {
    setBusy("bind");
    setStatus(null);
    try {
      await writeBinding({
        podRoot,
        webId: passport.webId,
        controller: did,
        server: passport.server,
      });
      await updatePassport(passport.id, { bound: true });
      setStatus("Binding written.");
    } catch (e) {
      // The passport's pod is owned by its fresh WebID; the current session may
      // not have write access until you sign in as that passport. Honest note.
      setStatus(
        e instanceof Error
          ? `Couldn't write the binding: ${e.message} (sign in as this passport to bind it).`
          : "Couldn't write the binding.",
      );
    } finally {
      setBusy("");
    }
  };

  const verify = async () => {
    setBusy("verify");
    setStatus(null);
    setVerdict(null);
    try {
      const { result } = await readAndVerify(podRoot, did);
      setVerdict(result.ok ? "ok" : "fail");
      setStatus(
        result.ok ? "Verified — controlled by your DID." : `Not verified: ${result.reason}.`,
      );
    } catch (e) {
      setVerdict("fail");
      setStatus(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setBusy("");
    }
  };

  // Server-side DID login (SOLID_DID.md US-2): prove control of the master DID by
  // signing a server challenge and receive a CSS-Account-Token — no password. The
  // signature is produced by the audited wallet core (HARD rule #4). We confirm
  // success by checking the token unlocks the account controls (authed-only).
  const didLogin = async () => {
    setBusy("did");
    setDidMsg(null);
    setDidVerdict(null);
    try {
      const { token, webId } = await loginWithDid({
        did,
        sign: walletSign,
        server: passport.server,
      });
      // Positive confirmation, server-agnostically: a DID-session server
      // (solid-server-rs) returns the authenticated WebID directly; the CSS
      // DID-fork returns no WebID, so we confirm the token unlocks the account
      // controls (authed-only) instead.
      let authed = Boolean(webId);
      if (!authed) {
        const root = passport.server.endsWith("/") ? passport.server : passport.server + "/";
        const res = await fetch(`${root}.account/`, {
          headers: { Authorization: `CSS-Account-Token ${token}`, Accept: "application/json" },
        });
        authed = res.ok && Boolean((await res.json())?.controls?.account);
      }
      if (authed) {
        setDidVerdict("ok");
        setDidMsg(
          webId
            ? `Authenticated as ${webId} by signing a challenge — no password.`
            : "Authenticated to this account by signing a challenge — no password. A fresh account token was minted.",
        );
        // A successful login proves the DID is linked; remember it for the badge.
        if (!passport.didLinked) await updatePassport(passport.id, { didLinked: true });
      } else {
        setDidVerdict("fail");
        setDidMsg("DID login returned a token, but the account-session check was inconclusive.");
      }
    } catch (e) {
      setDidVerdict("fail");
      setDidMsg(e instanceof Error ? e.message : "DID login failed.");
    } finally {
      setBusy("");
    }
  };

  const open = async () => {
    setBusy("open");
    setStatus(null);
    try {
      await addWorkspace(podRoot, { name: passport.label });
      setStatus("Opened in the rail.");
    } catch (e) {
      setStatus(
        e instanceof Error ? `Couldn't open: ${e.message}` : "Couldn't open this passport's pod.",
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {passport.label || hostOf(passport.server)}
            {isActiveSession && (
              <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                active
              </span>
            )}
            {passport.bound && (
              <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                bound
              </span>
            )}
            {passport.didLinked && (
              <span
                className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                title="Your master DID is linked to this account — you can log in by signing a challenge, no password"
              >
                DID login ✓
              </span>
            )}
          </p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
            {passport.webId}
          </p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{podRoot}</p>
        </div>
        {verdict === "ok" && <span className="text-sm text-emerald-500">✓</span>}
        {verdict === "fail" && <span className="text-sm text-destructive">✗</span>}
      </div>
      {isActive ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void bind()} disabled={busy !== ""}>
            {busy === "bind" ? "…" : "Write binding"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void verify()} disabled={busy !== ""}>
            {busy === "verify" ? "…" : "Verify control"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void open()} disabled={busy !== ""}>
            {busy === "open" ? "…" : "Open as workspace"}
          </Button>
        </div>
      ) : canSwitch ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Sign in as this passport — the shell holds its key, so no password and no redirect. Then
            you can write its binding or open its pod.
          </p>
          <Button size="sm" onClick={() => void switchTo()} disabled={busy !== ""}>
            {busy === "switch" ? "Signing in…" : "Switch to this passport"}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            This passport was captured manually (no stored key). Sign in as it the usual way to
            write its binding or open its pod.
          </p>
          <Button size="sm" variant="outline" asChild>
            <a href="/connect">Sign in as this passport</a>
          </Button>
        </div>
      )}
      {status && <p className="mt-2 text-[11px] text-muted-foreground">{status}</p>}

      {/* Server-side DID login (SOLID_DID.md US-2): authenticate to this account
          by signing a server challenge with the master DID — no password. Only
          surfaced where the server actually supports it, so there are no
          dead-end clicks against stock CSS. */}
      <div className="mt-3 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-foreground">Server-side DID login</p>
          {didSupported === null && (
            <span className="text-[10px] text-muted-foreground">checking…</span>
          )}
        </div>
        {didSupported === false ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            This server is stock CSS — it doesn&apos;t accept DID login. The shell signs you in here
            with this passport&apos;s stored key instead.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Prove control of your master DID by signing a one-time challenge and get a fresh
              account session — no password, no redirect.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void didLogin()}
                disabled={busy !== "" || didSupported === null}
                title="Authenticate to this server's account by signing a challenge with your master DID"
              >
                {busy === "did" ? "Signing challenge…" : "Log in with DID"}
              </Button>
              {didVerdict === "ok" && (
                <span className="text-sm font-medium text-emerald-500">✓ signed in</span>
              )}
              {didVerdict === "fail" && (
                <span className="text-sm font-medium text-destructive">✗ failed</span>
              )}
            </div>
            {didMsg && (
              <p
                className={`mt-2 text-[11px] ${
                  didVerdict === "ok"
                    ? "text-emerald-500"
                    : didVerdict === "fail"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {didMsg}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add passport
// ---------------------------------------------------------------------------

function AddPassportDialog({ did, onClose }: { did: string; onClose: () => void }) {
  const { reloadIdentity } = useShell();
  const [mode, setMode] = useState<"provision" | "manual">("provision");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // provision fields
  const [server, setServer] = useState("http://localhost:3101");
  const [label, setLabel] = useState("");
  const [signInAfter, setSignInAfter] = useState(true);
  // manual fields
  const [mWebId, setMWebId] = useState("");
  const [mPod, setMPod] = useState("");

  // Live capability hint: does the entered server support server-side DID login?
  // Debounced so we don't probe on every keystroke. Lets the user see up-front
  // whether their master DID will be linkable here before they provision.
  const [serverDid, setServerDid] = useState<"checking" | "yes" | "no" | null>(null);
  useEffect(() => {
    if (mode !== "provision" || !server.trim()) {
      setServerDid(null);
      return;
    }
    setServerDid("checking");
    let cancelled = false;
    const t = setTimeout(() => {
      void serverSupportsDid(server.trim()).then((ok) => {
        if (!cancelled) setServerDid(ok ? "yes" : "no");
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [server, mode]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let p: Passport;
      if (mode === "provision") {
        if (!server.trim()) throw new Error("A server URL is required.");
        // No email/password from the user — the shell generates a strong account
        // password and captures a durable key (PRD-DID §5.6, "close the gap").
        p = await provisionPassport({ did, server, label });
      } else {
        p = captureManualPassport({ did, webId: mWebId, podRoot: mPod, label });
      }
      await addPassport(p);
      // Provisioned passports carry a key — optionally sign in as it right away,
      // so the very next thing you do happens in the new pod with no extra step.
      if (mode === "provision" && signInAfter && p.creds?.kind === "client-credentials") {
        await enterPassport(p);
        await reloadIdentity();
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the passport.");
    } finally {
      setBusy(false);
    }
  }, [mode, server, label, signInAfter, mWebId, mPod, did, onClose, reloadIdentity]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a passport</DialogTitle>
          <DialogDescription>
            Mint a fresh WebID + pod on a server, or capture an existing one. Either way your one
            master DID controls it.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "provision" ? "default" : "outline"}
            onClick={() => setMode("provision")}
          >
            Provision (CSS)
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "manual" ? "default" : "outline"}
            onClick={() => setMode("manual")}
          >
            Capture existing
          </Button>
        </div>

        {mode === "provision" ? (
          <div className="space-y-3">
            <div>
              <Field label="Server" id="pp-server" value={server} onChange={setServer} />
              {serverDid === "checking" && (
                <p className="mt-1 text-[11px] text-muted-foreground">Checking DID support…</p>
              )}
              {serverDid === "yes" && (
                <p className="mt-1 text-[11px] text-emerald-500">
                  ✓ Supports DID login — your master DID will be linked automatically.
                </p>
              )}
              {serverDid === "no" && (
                <p className="mt-1 text-[11px] text-amber-500">
                  Stock CSS — no DID login here. The passport still works via its stored key
                  (password-less switch).
                </p>
              )}
            </div>
            <Field label="Label (optional)" id="pp-label" value={label} onChange={setLabel} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={signInAfter}
                onChange={(e) => setSignInAfter(e.target.checked)}
                className="size-4 accent-[color:var(--primary)]"
              />
              Sign in as this passport after creating it
            </label>
            <p className="rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
              The shell creates a brand-new account on the server with a fresh WebID,
              <strong> generates a strong password for you</strong> (you never type or see one), and
              stores a key so it can sign you in later with no password and no redirect. The key is
              sealed in your encrypted wallet — never written to a pod.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="WebID" id="pp-webid" value={mWebId} onChange={setMWebId} />
            <Field label="Pod root" id="pp-podroot" value={mPod} onChange={setMPod} />
            <Field label="Label (optional)" id="pp-mlabel" value={label} onChange={setLabel} />
          </div>
        )}

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Working…" : mode === "provision" ? "Provision" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[color:var(--border)] bg-card p-5">{children}</div>
  );
}

function Field({
  label,
  id,
  value,
  onChange,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  );
}

function XssCaveat() {
  return (
    <p className="mt-3 rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
      Prototype note: in the browser, your unlocked seed lives in memory for the session (a
      documented XSS tradeoff). The hardened native build custodies it in the OS keychain.
    </p>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
