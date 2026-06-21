"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@mind-studio/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isValidEmail, suggestPlusAlias } from "@/lib/identity/email";
import { willSealWorkspaceLogin } from "@/lib/identity/provider-entry";
import { getView as getWalletView } from "@/lib/identity/wallet";
import { useShell } from "@/lib/shell/context";
import type { Workspace } from "@/lib/shell/types";
import { serverSupportsAccountCreation } from "@/lib/solid/account";
import { serverSupportsDid } from "@/lib/solid/did-account";
import { serverRequiresEmailVerification } from "@/lib/solid/email-verification";
import { DEFAULT_ISSUER, storedIssuer } from "@/lib/solid/session";

/**
 * The vertical workspace rail (wireframe far-left column). Each workspace the
 * account owns or joined is a rounded tile; the active one wears the
 * `.shell-active-ring`. A `+` opens the "add a workspace" dialog (join an
 * existing pod by URL — PRD-IDENTITY.md B3), and a ⚙ links to /settings.
 */
export function WorkspaceRail() {
  const { workspaces, workspacePod, switchWorkspace } = useShell();

  return (
    <TooltipProvider delayDuration={150}>
      <nav
        aria-label="Your workspaces"
        className="flex h-full w-16 shrink-0 flex-col items-center gap-2 border-r border-[color:var(--border)] glass-panel py-3"
      >
        <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
          {workspaces.map((ws) => (
            <WorkspaceTile
              key={ws.podRoot}
              workspace={ws}
              active={ws.podRoot === workspacePod}
              onClick={() => switchWorkspace(ws.podRoot)}
            />
          ))}
          <NewWorkspaceButton />
        </div>

        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className="grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <span className="text-lg">⚙</span>
        </Link>
      </nav>
    </TooltipProvider>
  );
}

function WorkspaceTile({
  workspace,
  active,
  onClick,
}: {
  workspace: Workspace;
  active: boolean;
  onClick: () => void;
}) {
  const initial = (workspace.name || "W").slice(0, 1).toUpperCase();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={workspace.name}
          aria-current={active ? "true" : undefined}
          className={`grid size-11 shrink-0 place-items-center rounded-xl text-sm font-semibold transition ${
            active
              ? "bg-primary text-primary-foreground shell-active-ring"
              : "bg-muted text-foreground hover:bg-muted/70"
          }`}
        >
          {initial}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{workspace.name}</TooltipContent>
    </Tooltip>
  );
}

function NewWorkspaceButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          aria-label="Add a workspace"
          title="Add a workspace"
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-dashed border-[color:var(--border)] text-lg text-muted-foreground transition hover:border-primary hover:text-foreground"
        >
          +
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a workspace</DialogTitle>
          <DialogDescription>
            Join a pod you already have access to, or create a brand-new one — just name it and the
            shell handles the account. Either way it reuses your existing identity (no second
            WebID).
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="join" className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="join">Join existing</TabsTrigger>
            <TabsTrigger value="create">Create new</TabsTrigger>
          </TabsList>
          <TabsContent value="join">
            <JoinWorkspaceForm onDone={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="create">
            <CreateWorkspaceForm onDone={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Join an existing pod by URL (B3). */
function JoinWorkspaceForm({ onDone }: { onDone: () => void }) {
  const { addWorkspace } = useShell();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addWorkspace(url);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that workspace.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-2">
      <Label htmlFor="ws-url">Pod URL</Label>
      <Input
        id="ws-url"
        type="url"
        inputMode="url"
        autoFocus
        placeholder="https://pod.example.org/team/"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "ws-url-error" : undefined}
      />
      <p className="text-xs text-muted-foreground">
        It joins your rail and your identity remembers it.
      </p>
      {error && (
        <p id="ws-url-error" className="text-sm text-[color:var(--destructive)]">
          {error}
        </p>
      )}
      <DialogFooter className="mt-6">
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? "Adding…" : "Add workspace"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Provision a brand-new pod (B4 / PRD-DID §5.7 hybrid). The user types ONLY a
 * name — the shell auto-generates the CSS account login, provisions a pod owned by
 * the signed-in WebID, seals the login in the wallet, and binds the master DID
 * when the server supports it. The optional Server field targets a stock CSS or a
 * DID-aware one; a live badge shows whether DID will be linked there.
 */
function CreateWorkspaceForm({ onDone }: { onDone: () => void }) {
  const { createWorkspace } = useShell();
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [didAware, setDidAware] = useState<boolean | null>(null);
  // Whether the server has an account-creation API at all. A DID-only server
  // (one pod per identity, made at sign-in) doesn't — creating would just 401.
  const [canCreate, setCanCreate] = useState<boolean | null>(null);
  // Bring-your-own-email branch (PRD-PROVIDER-ACCOUNTS §6). Off by default (the
  // shell mints a throwaway placeholder); auto-enabled when the server verifies.
  const [useOwnEmail, setUseOwnEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [verifies, setVerifies] = useState<boolean | null>(null);

  // Default the server to the current issuer once mounted (localStorage is
  // client-only). The field stays editable so a workspace can target another CSS.
  useEffect(() => {
    setServer((s) => s || storedIssuer() || DEFAULT_ISSUER);
  }, []);

  // Probe DID support AND email-verification policy for the chosen server so we
  // can show what will happen and pre-arm the bring-your-own-email branch.
  const walletStatus = getWalletView().status;
  const hasWallet = walletStatus !== "none";
  // P1: the login is sealed only into an UNLOCKED wallet — say so honestly rather
  // than promise a Vault entry we won't write.
  const willStoreLogin = willSealWorkspaceLogin(walletStatus);
  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    setDidAware(null);
    setVerifies(null);
    setCanCreate(null);
    void serverSupportsDid(server).then((ok) => {
      if (!cancelled) setDidAware(ok);
    });
    void serverSupportsAccountCreation(server).then((ok) => {
      if (!cancelled) setCanCreate(ok);
    });
    void serverRequiresEmailVerification(server).then((req) => {
      if (cancelled) return;
      setVerifies(req);
      if (req) setUseOwnEmail(true); // provider verifies → need a real inbox
    });
    return () => {
      cancelled = true;
    };
  }, [server]);

  const emailOk = !useOwnEmail || isValidEmail(email.trim());
  const ready = Boolean(name.trim()) && emailOk;

  // Cross-issuer caveat: a pod on another server is WAC-owned by this WebID but
  // the current session's token is only honoured by the identity's own issuer —
  // every read/write of the new pod 401s until you sign in to that server
  // directly. Creation still works; warn so the dead-looking workspace isn't a
  // surprise.
  const crossIssuer = (() => {
    try {
      const issuer = storedIssuer();
      if (!issuer || !server) return false;
      return new URL(server).origin !== new URL(issuer).origin;
    } catch {
      return false;
    }
  })();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkspace({
        name,
        server: server.trim() || undefined,
        email: useOwnEmail ? email.trim() : undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that workspace.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3">
      <div className="space-y-2">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input
          id="ws-name"
          autoFocus
          placeholder="Family"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "ws-create-error" : undefined}
        />
        {canCreate === false ? (
          <p className="rounded-md border border-warning/50 bg-warning/10 p-2 text-xs leading-snug text-warning">
            This server can&rsquo;t create extra pods — it makes one pod per identity, at sign-in.
            Use &ldquo;Join existing&rdquo; to add a pod you already have access to, or choose a
            different server below.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {willStoreLogin ? (
              <>
                That&rsquo;s all we need — the shell creates the pod and saves its login to your
                Vault (under &ldquo;Provider accounts&rdquo;), so you can sign in to it directly
                later.
              </>
            ) : (
              <>
                That&rsquo;s all we need — the shell creates the pod.{" "}
                <span className="text-[color:var(--destructive)]">
                  {hasWallet
                    ? "Unlock your master identity to also save its login to your Vault."
                    : "Set up a master identity to save its login to your Vault for direct sign-in."}
                </span>
              </>
            )}{" "}
            {didAware === true && hasWallet ? (
              <span className="text-primary">
                This server supports DID — it&rsquo;ll be linked.
              </span>
            ) : didAware === true && !hasWallet ? (
              <span>Set up a master identity to link a DID here.</span>
            ) : didAware === false && willStoreLogin ? (
              <span>This server has no DID — credentials are saved instead.</span>
            ) : null}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={useOwnEmail}
            onChange={(e) => setUseOwnEmail(e.target.checked)}
            className="size-3.5 accent-[color:var(--primary)]"
          />
          Use my own email
          {verifies === true && (
            <span className="text-primary">— this provider verifies email</span>
          )}
        </label>
        {useOwnEmail && (
          <div className="space-y-1.5 rounded-lg border border-[color:var(--border)] p-3">
            <Label htmlFor="ws-email">Email</Label>
            <Input
              id="ws-email"
              type="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email && !emailOk ? "true" : undefined}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                A real inbox keeps this account recoverable and passes verification. Tip: a{" "}
                <code>+alias</code> lets one inbox cover many accounts.
              </p>
              {isValidEmail(email.trim()) && name.trim() && (
                <button
                  type="button"
                  onClick={() => setEmail(suggestPlusAlias(email.trim(), name))}
                  className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
                >
                  +alias
                </button>
              )}
            </div>
            {email && !emailOk && (
              <p className="text-xs text-[color:var(--destructive)]">
                That doesn&rsquo;t look like a valid email.
              </p>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowServer((v) => !v)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {showServer ? "Hide server" : "Choose server"}
      </button>
      {showServer && (
        <div className="space-y-2 rounded-lg border border-[color:var(--border)] p-3">
          <Label htmlFor="ws-server">Server</Label>
          <Input
            id="ws-server"
            type="url"
            inputMode="url"
            placeholder="http://localhost:3101/"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Where the pod lives. A DID-aware CSS links your identity; a stock one still works.
          </p>
          {crossIssuer && canCreate !== false && (
            <p
              data-testid="ws-cross-issuer-warning"
              className="rounded-md border border-warning/50 bg-warning/10 p-2 text-xs leading-snug text-warning"
            >
              Heads-up: your sign-in lives on a different server, so this workspace will look empty
              here — its pod only answers a session from its own server. Its login is saved to your
              Vault for signing in there directly.
            </p>
          )}
        </div>
      )}

      {error && (
        <p id="ws-create-error" className="text-sm text-[color:var(--destructive)]">
          {error}
        </p>
      )}
      <DialogFooter className="mt-6">
        <Button type="submit" disabled={busy || !ready || canCreate === false}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </DialogFooter>
    </form>
  );
}
