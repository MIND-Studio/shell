"use client";

/**
 * Provider accounts — read-only viewer (PRD-PROVIDER-ACCOUNTS P0).
 *
 * Surfaces the account logins the shell already SEALED for secondary pod
 * providers (hybrid workspaces) so you can sign in to that provider's own app
 * (e.g. drive.mindpods.org) as the same user. The secret is NOT copied into the
 * Vault's pod store — it's read live from the unlocked wallet registry (one
 * source of truth) and shown here. The MAIN IDENTITY never appears (it has no
 * stored password — see provider-accounts.ts).
 *
 * Reads the wallet singleton directly; renders nothing when the wallet is locked
 * or holds no viewable logins. Reveal is opt-in, copy auto-clears, and every row
 * carries the reusable-login warning (PRD-PROVIDER-ACCOUNTS §3 tradeoff).
 */

import { useEffect, useState } from "react";
import { Button, Input, Separator } from "@mind-studio/ui";
import {
  getView,
  getPassports,
  subscribe,
  markEmailVerified,
  addManualProviderAccount,
} from "@/lib/identity/wallet";
import {
  projectProviderAccounts,
  type ProviderAccount,
} from "@/lib/identity/provider-accounts";
import {
  validateManualAccount,
  isManualAccountValid,
  type ManualAccountDraft,
} from "@/lib/identity/manual-account";
import { planProviderEntry } from "@/lib/identity/provider-entry";
import { brokeredHandoffAvailable } from "@/lib/shell/brokered-bridge";
import { useShell } from "@/lib/shell/context";
import { copyWithAutoClear } from "@/lib/vault/clipboard";

export function ProviderAccounts() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [open, setOpen] = useState(false);

  // Subscribe to the wallet: project whenever it unlocks / changes. The wallet
  // is a process-wide singleton shared with the account switcher and Identity.
  useEffect(() => {
    const refresh = () => {
      setUnlocked(getView().status === "unlocked");
      setAccounts(projectProviderAccounts(getPassports()));
    };
    refresh();
    return subscribe(refresh);
  }, []);

  // Wallet locked → render nothing. When unlocked we show the section even with
  // zero accounts (P3): the "Add a login" affordance must be reachable to capture
  // a provider you registered yourself.
  if (!unlocked) return null;

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="font-medium">Provider accounts</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {accounts.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          logins for your other pods
        </span>
      </button>

      {open && (
        <div className="max-h-96 space-y-3 overflow-y-auto px-3 pb-3">
          <p className="text-xs text-muted-foreground">
            These reusable logins let you sign in to each provider directly. Anyone who unlocks this
            device can read them — your main identity is never stored here.
          </p>
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
          {accounts.length === 0 && (
            <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
              No saved logins yet. Add one for a provider you registered yourself
              (e.g. Inrupt PodSpaces) to keep its login here.
            </p>
          )}
          <AddLoginForm />
        </div>
      )}
    </div>
  );
}

/**
 * Capture a login you set up yourself at a provider the shell can't provision
 * headlessly (PRD-PROVIDER-ACCOUNTS P3). Seals it as the same viewable provider
 * account; it carries no key card, so it's never auto-resumed — a stored,
 * reusable credential only.
 */
function AddLoginForm() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ManualAccountDraft>({
    label: "",
    server: "",
    email: "",
    password: "",
    webId: "",
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validateManualAccount(draft);
  const ready = isManualAccountValid(draft);
  const set = (patch: Partial<ManualAccountDraft>) => setDraft((d) => ({ ...d, ...patch }));

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
        + Add a provider login
      </Button>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addManualProviderAccount(draft);
      setOpen(false);
      setDraft({ label: "", server: "", email: "", password: "", webId: "" });
      setTouched(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this login.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-2 rounded-md border border-border/70 p-3"
    >
      <p className="text-xs font-medium">Add a provider login</p>
      <p className="text-xs text-muted-foreground">
        For a pod you registered yourself. The password is saved to your Vault —
        the shell never signs you in automatically with it.
      </p>

      <Field label="Name" error={touched ? errors.label : undefined}>
        <Input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="Inrupt PodSpaces"
        />
      </Field>
      <Field label="Provider" error={touched ? errors.server : undefined}>
        <Input
          value={draft.server}
          inputMode="url"
          onChange={(e) => set({ server: e.target.value })}
          placeholder="https://pods.mindpods.org"
        />
      </Field>
      <Field label="Email" error={touched ? errors.email : undefined}>
        <Input
          value={draft.email}
          inputMode="email"
          autoCapitalize="none"
          onChange={(e) => set({ email: e.target.value })}
          placeholder="you@example.com"
        />
      </Field>
      <Field label="Password" error={touched ? errors.password : undefined}>
        <Input
          value={draft.password}
          type="password"
          onChange={(e) => set({ password: e.target.value })}
          placeholder="the password you set"
        />
      </Field>
      <Field label="WebID (optional)" error={touched ? errors.webId : undefined}>
        <Input
          value={draft.webId ?? ""}
          inputMode="url"
          onChange={(e) => set({ webId: e.target.value })}
          placeholder="https://…/profile/card#me"
        />
      </Field>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={draft.verified === false}
          onChange={(e) => set({ verified: e.target.checked ? false : undefined })}
          className="size-3.5 accent-[color:var(--primary)]"
        />
        I haven&rsquo;t confirmed this email yet (mark pending)
      </label>

      {error && <p className="text-xs text-[color:var(--destructive)]">{error}</p>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy ? "Saving…" : "Save login"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
      {error && <p className="text-xs text-[color:var(--destructive)]">{error}</p>}
    </div>
  );
}

function AccountRow({ account }: { account: ProviderAccount }) {
  const [revealed, setRevealed] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const { apps } = useShell();

  // P4: how you'll get in. Brokered handoff over the capability bridge (PRD-APPS)
  // is preferred when this provider also ships an in-shell first-party iframe app
  // (read live from the shell catalog) — you're signed in with no typed credential.
  // Otherwise this resolves to the stored-login path and the saved credential below
  // is how you sign in. Both coexist; the login stays viewable either way.
  const entry = planProviderEntry({
    server: account.server,
    accounts: [account],
    brokered: brokeredHandoffAvailable(account.server, apps),
  });

  return (
    <div className="rounded-md border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{account.label}</span>
        {account.didLinked && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-500">
            DID
          </span>
        )}
        {account.pending && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-500">
            Pending
          </span>
        )}
        {account.manual && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Added by you
          </span>
        )}
        <a
          href={account.server}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs text-primary underline"
        >
          {entry.mode === "brokered" ? "Open in shell ↗" : "Open provider ↗"}
        </a>
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.server}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{entry.reason}</p>

      {account.pending && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <span className="min-w-0 flex-1">
            Confirm this email at the provider, then mark it verified to re-enable
            automatic sign-in.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={async () => {
              setVerifyError(null);
              try {
                await markEmailVerified(account.id);
              } catch (err) {
                setVerifyError(
                  err instanceof Error ? err.message : "Couldn't mark this verified."
                );
              }
            }}
          >
            Mark verified
          </Button>
        </div>
      )}
      {verifyError && (
        <p className="mt-1 text-xs text-[color:var(--destructive)]">{verifyError}</p>
      )}

      <Separator className="my-2" />

      <Row label="Email" value={account.email} mono />
      <Row
        label="Password"
        value={account.password}
        mono
        secret
        revealed={revealed}
        onToggle={() => setRevealed((r) => !r)}
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  secret,
  revealed,
  onToggle,
}: {
  label: string;
  value: string;
  mono?: boolean;
  secret?: boolean;
  revealed?: boolean;
  onToggle?: () => void;
}) {
  const shown = secret && !revealed ? "••••••••••••" : value;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm ${mono ? "font-mono" : ""}`}>{shown}</span>
      {secret && (
        <Button size="sm" variant="outline" onClick={onToggle}>
          {revealed ? "Hide" : "Reveal"}
        </Button>
      )}
      <CopyBtn value={value} />
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
