"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import type { Workspace } from "@/lib/shell/types";
import { DEFAULT_ISSUER, storedIssuer } from "@/lib/solid/session";
import { serverSupportsDid } from "@/lib/solid/did-account";
import { getView as getWalletView } from "@/lib/identity/wallet";

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
            Join a pod you already have access to, or create a brand-new one —
            just name it and the shell handles the account. Either way it reuses
            your existing identity (no second WebID).
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

  // Default the server to the current issuer once mounted (localStorage is
  // client-only). The field stays editable so a workspace can target another CSS.
  useEffect(() => {
    setServer((s) => s || storedIssuer() || DEFAULT_ISSUER);
  }, []);

  // Probe DID support for the chosen server so we can show what will happen.
  const hasWallet = getWalletView().status !== "none";
  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    setDidAware(null);
    void serverSupportsDid(server).then((ok) => {
      if (!cancelled) setDidAware(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [server]);

  const ready = Boolean(name.trim());

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkspace({ name, server: server.trim() || undefined });
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
        <p className="text-xs text-muted-foreground">
          That&rsquo;s all we need — the shell creates the pod and saves its
          password for you.{" "}
          {didAware === true && hasWallet ? (
            <span className="text-primary">This server supports DID — it&rsquo;ll be linked.</span>
          ) : didAware === true && !hasWallet ? (
            <span>Set up a master identity to link a DID here.</span>
          ) : didAware === false ? (
            <span>This server has no DID — credentials are saved instead.</span>
          ) : null}
        </p>
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
            Where the pod lives. A DID-aware CSS links your identity; a stock one
            still works.
          </p>
        </div>
      )}

      {error && (
        <p id="ws-create-error" className="text-sm text-[color:var(--destructive)]">
          {error}
        </p>
      )}
      <DialogFooter className="mt-6">
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </DialogFooter>
    </form>
  );
}
