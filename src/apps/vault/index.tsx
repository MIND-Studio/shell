"use client";

/**
 * Vault — the flagship zero-knowledge password manager hosted inside the shell.
 *
 * States: loading → setup (no vault.ttl) | locked (vault.ttl exists, no handle)
 *   → unlocked (holds a SessionHandle + decrypted index in memory only).
 *
 * ZERO-KNOWLEDGE INVARIANT (PRD §4, §5.5, §8): the only thing JS ever holds for
 * unlocked key material is the opaque numeric SessionHandle; the master password
 * is passed straight into the Rust core and never stored. What crosses to the pod:
 *   - vault.ttl: KDF params, salt, wrapped data key, schema version, non-secret
 *     index (titles/urls/usernames cleartext for search by the v0 default).
 *   - items/{id}.enc: opaque AEAD blob (nonce || wrapped per-item key || ciphertext).
 * Decrypted secrets exist only transiently in component state, are dropped on lock,
 * and are never written to the pod, localStorage, or any log.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Label, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { appZone } from "@/lib/shell/types";
import { getPlatform, type AsyncCryptoCore } from "@/lib/platform";
import type { SessionHandle } from "@/lib/vault/crypto-contract";
import {
  loadVault,
  createVaultOnPod,
  saveItem,
  loadItemSecret,
  deleteItem,
  changeMasterPassword,
  newItemId,
  type LoadedVault,
  type VaultItemMeta,
  type VaultItemSecret,
  type VaultItemKind,
} from "@/lib/vault/model";
import { useAutoLock } from "@/lib/vault/autolock";
import { cancelAutoClear } from "@/lib/vault/clipboard";
import { ItemEditor, type EditorDraft } from "./ItemEditor";
import { ItemDetail } from "./ItemDetail";
import { PasswordGenerator } from "./PasswordGenerator";
import { PrototypeWarning } from "@/components/PrototypeWarning";

type Phase = "loading" | "setup" | "locked" | "unlocked";

export default function VaultApp() {
  const { workspacePod, project, ready } = useShell();
  const zone = useMemo(
    () => (workspacePod ? appZone(workspacePod, "vault", project) : null),
    [workspacePod, project]
  );

  const [core, setCore] = useState<AsyncCryptoCore | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [vault, setVault] = useState<LoadedVault | null>(null);
  const [handle, setHandle] = useState<SessionHandle | null>(null);

  // Load the platform crypto core once: web resolves the wasm core (wrapped
  // async), native forwards to Tauri commands. Same AsyncCryptoCore surface.
  useEffect(() => {
    getPlatform()
      .then((p) => p.crypto.getCore())
      .then(setCore)
      .catch((e) => setCoreError(e instanceof Error ? e.message : "crypto core failed to load"));
  }, []);

  // Determine setup vs locked once core + zone are ready.
  useEffect(() => {
    if (!core || !zone || !ready || !workspacePod) return;
    let cancelled = false;
    setPhase("loading");
    loadVault(zone, workspacePod)
      .then((v) => {
        if (cancelled) return;
        setVault(v);
        setPhase(v ? "locked" : "setup");
      })
      .catch(() => {
        if (!cancelled) setPhase("setup");
      });
    return () => {
      cancelled = true;
    };
  }, [core, zone, ready, workspacePod]);

  const lockNow = useCallback(() => {
    if (core && handle != null) {
      // Drop the session in the core (zeroizes key material). Fire-and-forget:
      // the UI locks immediately regardless; a failed lock is idempotent.
      void core.lock(handle).catch(() => {});
    }
    cancelAutoClear();
    setHandle(null);
    setPhase((p) => (p === "unlocked" ? "locked" : p));
  }, [core, handle]);

  useAutoLock(phase === "unlocked", lockNow);

  if (coreError) {
    return <Centered>Could not load the crypto core: {coreError}</Centered>;
  }
  if (!ready || !zone || !core || !workspacePod || phase === "loading") {
    return <Centered>Loading Vault…</Centered>;
  }

  if (phase === "setup") {
    return (
      <SetupScreen
        onCreate={async (pw) => {
          const v = await createVaultOnPod(core, zone, workspacePod, pw);
          setVault(v);
          // Unlock immediately with the just-set password.
          const h = await core.unlock(pw, v.bootstrap.salt_b64, v.bootstrap.kdf, v.bootstrap.wrapped_data_key_b64);
          setHandle(h);
          setPhase("unlocked");
        }}
      />
    );
  }

  if (phase === "locked" && vault) {
    return (
      <UnlockScreen
        onUnlock={async (pw) => {
          const h = await core.unlock(
            pw,
            vault.bootstrap.salt_b64,
            vault.bootstrap.kdf,
            vault.bootstrap.wrapped_data_key_b64
          );
          setHandle(h);
          setPhase("unlocked");
        }}
      />
    );
  }

  if (phase === "unlocked" && vault && handle != null) {
    return (
      <UnlockedVault
        core={core}
        zone={zone}
        handle={handle}
        vault={vault}
        // Copy the index array too: saveItem/deleteItem mutate vault.index in
        // place, so a shallow {...v} would keep the same array reference and the
        // `filtered` useMemo (keyed on vault.index) would never recompute — the
        // list would show "No matches" right after adding the first item.
        onVaultChange={(v) => setVault({ ...v, index: [...v.index] })}
        onLock={lockNow}
      />
    );
  }

  return <Centered>Loading Vault…</Centered>;
}

// ---------------------------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-sm text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function pwStrengthHint(pw: string): string {
  if (pw.length < 8) return "Too short — use 12+ characters.";
  if (pw.length < 12) return "Okay — longer is stronger.";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 && classes >= 3) return "Strong.";
  return "Good — mix in more character types for extra strength.";
}

function SetupScreen({ onCreate }: { onCreate: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (pw.length < 8) return setError("Use at least 8 characters.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await onCreate(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the vault.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <PrototypeWarning />
        <div className="text-center">
          <div className="text-4xl">🔒</div>
          <h2 className="mt-3 text-xl font-semibold">Create your vault</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your master password never leaves this device — it unlocks an encryption key that only
            you hold. There is no recovery if you forget it.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-pw">Master password</Label>
          <Input id="su-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {pw && <p className="text-xs text-muted-foreground">{pwStrengthHint(pw)}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-cf">Confirm</Label>
          <Input
            id="su-cf"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={busy} className="w-full">
          {busy ? "Creating…" : "Create vault"}
        </Button>
      </div>
    </div>
  );
}

function UnlockScreen({ onUnlock }: { onUnlock: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    // Yield so the spinner paints before the Argon2id stretch blocks the thread.
    await new Promise((r) => setTimeout(r, 0));
    try {
      await onUnlock(pw);
      setPw("");
    } catch {
      setError("Wrong master password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <PrototypeWarning />
        <div className="text-center">
          <div className="text-4xl">🔒</div>
          <h2 className="mt-3 text-xl font-semibold">Unlock your vault</h2>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ul-pw">Master password</Label>
          <Input
            id="ul-pw"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={busy || !pw} className="w-full">
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UnlockedVault({
  core,
  zone,
  handle,
  vault,
  onVaultChange,
  onLock,
}: {
  core: AsyncCryptoCore;
  zone: string;
  handle: SessionHandle;
  vault: LoadedVault;
  onVaultChange: (v: LoadedVault) => void;
  onLock: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secret, setSecret] = useState<VaultItemSecret | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [showGen, setShowGen] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);

  const selected = vault.index.find((m) => m.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = [...vault.index].sort((a, b) => a.title.localeCompare(b.title));
    if (!q) return items;
    return items.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        (m.url ?? "").toLowerCase().includes(q) ||
        (m.username ?? "").toLowerCase().includes(q)
    );
  }, [vault.index, query]);

  // Decrypt the selected item on demand (kept only in memory).
  useEffect(() => {
    if (!selected) {
      setSecret(null);
      return;
    }
    let cancelled = false;
    setSecret(null);
    setSecretError(null);
    loadItemSecret(core, zone, handle, selected)
      .then((s) => !cancelled && setSecret(s))
      .catch((e) => !cancelled && setSecretError(e instanceof Error ? e.message : "decrypt failed"));
    return () => {
      cancelled = true;
    };
  }, [core, zone, handle, selected]);

  const startNew = (kind: VaultItemKind = "login") => {
    setDraft({
      isNew: true,
      // version 0 → first save bumps to 1 (AAD binds id+version).
      meta: { id: newItemId(), kind, title: "", version: 0, updatedAt: new Date().toISOString() },
      secret: {},
    });
  };

  const startEdit = async () => {
    if (!selected) return;
    const s = secret ?? (await loadItemSecret(core, zone, handle, selected));
    setDraft({ isNew: false, meta: selected, secret: s });
  };

  const onSaveItem = async (meta: VaultItemMeta, sec: VaultItemSecret) => {
    const saved = await saveItem(core, zone, handle, vault, meta, sec);
    onVaultChange(vault);
    setDraft(null);
    setSelectedId(saved.id);
  };

  const onDeleteItem = async () => {
    if (!selected) return;
    if (!confirm(`Delete “${selected.title}”? This cannot be undone.`)) return;
    await deleteItem(zone, vault, selected.id);
    onVaultChange(vault);
    setSelectedId(null);
    setSecret(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Input
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Button size="sm" onClick={() => startNew("login")}>
          + Item
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowGen(true)}>
          Generator
        </Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowChangePw(true)}>
            Change master password
          </Button>
          <Button size="sm" variant="secondary" onClick={onLock}>
            Lock
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* list — full-width on mobile; on phones it yields to the detail pane
            once an item is selected (master-detail), and is always shown ≥md. */}
        <div
          className={`w-full shrink-0 overflow-y-auto border-r border-border md:block md:w-72 ${
            selected ? "hidden" : "block"
          }`}
        >
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {vault.index.length === 0 ? "No items yet. Add your first one." : "No matches."}
            </p>
          ) : (
            <ul>
              {filtered.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => setSelectedId(m.id)}
                    className={`w-full border-b border-border/50 px-4 py-3 text-left hover:bg-muted/50 ${
                      m.id === selectedId ? "bg-muted" : ""
                    }`}
                  >
                    <div className="truncate text-sm font-medium">{m.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {m.username || m.url || m.kind}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* detail — hidden on mobile until an item is picked; always shown ≥md. */}
        <div
          className={`min-w-0 flex-1 overflow-y-auto p-6 md:block ${
            selected ? "block" : "hidden"
          }`}
        >
          {selected && (
            <button
              onClick={() => setSelectedId(null)}
              className="mb-4 -ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary md:hidden"
            >
              ← All items
            </button>
          )}
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select an item to view it.</p>
          ) : secretError ? (
            <p className="text-sm text-destructive">Could not decrypt: {secretError}</p>
          ) : !secret ? (
            <p className="text-sm text-muted-foreground">Decrypting…</p>
          ) : (
            <ItemDetail
              core={core}
              meta={selected}
              secret={secret}
              onEdit={startEdit}
              onDelete={onDeleteItem}
            />
          )}
        </div>
      </div>

      <ItemEditor core={core} draft={draft} onSave={onSaveItem} onClose={() => setDraft(null)} />

      {showGen && (
        <Dialog open onOpenChange={(o) => !o && setShowGen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Generator</DialogTitle>
              <DialogDescription>Create a strong password or passphrase.</DialogDescription>
            </DialogHeader>
            <PasswordGenerator core={core} />
          </DialogContent>
        </Dialog>
      )}

      {showChangePw && (
        <ChangeMasterPwDialog
          onClose={() => setShowChangePw(false)}
          onChange={async (newPw) => {
            await changeMasterPassword(core, zone, handle, vault, newPw);
            onVaultChange(vault);
            setShowChangePw(false);
          }}
        />
      )}
    </div>
  );
}

function ChangeMasterPwDialog({
  onChange,
  onClose,
}: {
  onChange: (newPw: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (pw.length < 8) return setError("Use at least 8 characters.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await onChange(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change master password</DialogTitle>
          <DialogDescription>
            This re-wraps your vault key with the new password. Your items are not re-encrypted, so
            it&apos;s instant.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cp-pw">New master password</Label>
            <Input id="cp-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-cf">Confirm</Label>
            <Input
              id="cp-cf"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Changing…" : "Change"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
