"use client";

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mind-studio/ui";
import { useEffect, useState } from "react";
import type { AsyncCryptoCore } from "@/lib/platform";
import type { VaultItemKind, VaultItemMeta, VaultItemSecret } from "@/lib/vault/model";
import { PasswordGenerator } from "./PasswordGenerator";

export interface EditorDraft {
  meta: VaultItemMeta;
  secret: VaultItemSecret;
  isNew: boolean;
}

/**
 * Create/edit dialog for a vault item. Collects the non-secret index fields
 * (title/url/username/kind) and the secret payload (password/notes/totp/card).
 * On save it hands both back to the parent, which encrypts + persists.
 */
export function ItemEditor({
  core,
  draft,
  onSave,
  onClose,
}: {
  core: AsyncCryptoCore;
  draft: EditorDraft | null;
  onSave: (meta: VaultItemMeta, secret: VaultItemSecret) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<VaultItemKind>("login");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [cardholder, setCardholder] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [showGen, setShowGen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) return;
    setKind(draft.meta.kind);
    setTitle(draft.meta.title);
    setUrl(draft.meta.url ?? "");
    setUsername(draft.meta.username ?? "");
    setPassword(draft.secret.password ?? "");
    setNotes(draft.secret.notes ?? "");
    setTotpSecret(draft.secret.totpSecret ?? "");
    setCardNumber(draft.secret.cardNumber ?? "");
    setCardholder(draft.secret.cardholder ?? "");
    setExpiry(draft.secret.expiry ?? "");
    setCvv(draft.secret.cvv ?? "");
    setShowGen(false);
    setError(null);
  }, [draft]);

  if (!draft) return null;

  // Dirty = any field diverges from the draft we loaded. Used to guard against
  // losing edits when the dialog is dismissed (X / Cancel / click-away / Esc).
  const isDirty =
    kind !== draft.meta.kind ||
    title !== draft.meta.title ||
    url !== (draft.meta.url ?? "") ||
    username !== (draft.meta.username ?? "") ||
    password !== (draft.secret.password ?? "") ||
    totpSecret !== (draft.secret.totpSecret ?? "") ||
    notes !== (draft.secret.notes ?? "") ||
    cardNumber !== (draft.secret.cardNumber ?? "") ||
    cardholder !== (draft.secret.cardholder ?? "") ||
    expiry !== (draft.secret.expiry ?? "") ||
    cvv !== (draft.secret.cvv ?? "");

  const requestClose = () => {
    if (isDirty && !confirm("Discard your unsaved changes?")) return;
    onClose();
  };

  // TOTP secrets are base32 (RFC 4648: A–Z, 2–7, optional `=` padding). Flag a
  // malformed seed up front instead of letting code generation silently fail.
  const totpNorm = totpSecret.replace(/\s+/g, "").toUpperCase();
  const totpValid = totpNorm.length === 0 || /^[A-Z2-7]+=*$/.test(totpNorm);

  const save = async () => {
    setError(null);
    if (!title.trim()) {
      setError("A title is required.");
      return;
    }
    setBusy(true);
    try {
      const meta: VaultItemMeta = {
        ...draft.meta,
        kind,
        title: title.trim(),
        url: kind === "login" && url.trim() ? url.trim() : undefined,
        username: kind === "login" && username.trim() ? username.trim() : undefined,
      };
      const secret: VaultItemSecret = {};
      if (kind === "login") {
        if (password) secret.password = password;
        // Store the normalized base32 (despaced, uppercased) so a pasted
        // "GEZD GNBV …" seed still generates codes.
        if (totpNorm) secret.totpSecret = totpNorm;
      }
      if (kind === "card") {
        if (cardNumber.trim()) secret.cardNumber = cardNumber.trim();
        if (cardholder.trim()) secret.cardholder = cardholder.trim();
        if (expiry.trim()) secret.expiry = expiry.trim();
        if (cvv.trim()) secret.cvv = cvv.trim();
      }
      if (notes.trim()) secret.notes = notes.trim();
      await onSave(meta, secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && requestClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{draft.isNew ? "New item" : "Edit item"}</DialogTitle>
          <DialogDescription>
            Title, URL and username are stored in a searchable index. Passwords, notes and TOTP
            seeds are always encrypted before leaving this device.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as VaultItemKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="login">Login</SelectItem>
                <SelectItem value="note">Secure note</SelectItem>
                <SelectItem value="card">Card</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="it-title">Title</Label>
            <Input id="it-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          {kind === "login" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="it-url">URL</Label>
                <Input id="it-url" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="it-user">Username</Label>
                <Input
                  id="it-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="it-pw">Password</Label>
                <div className="flex gap-2">
                  <Input
                    id="it-pw"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-expanded={showGen}
                    onClick={async () => {
                      if (showGen) {
                        setShowGen(false);
                        return;
                      }
                      // Fill the field right away so the button does what it
                      // says; the panel below opens for tweaking/regenerating.
                      // Defaults mirror PasswordGenerator's initial options.
                      try {
                        setPassword(
                          await core.generatePassword({
                            length: 20,
                            upper: true,
                            lower: true,
                            digits: true,
                            symbols: true,
                            avoidAmbiguous: true,
                          }),
                        );
                      } catch {
                        // Panel still opens; its own Generate surfaces errors.
                      }
                      setShowGen(true);
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </div>
              {showGen && (
                <div className="rounded-md border border-border p-3">
                  <PasswordGenerator
                    core={core}
                    onUse={(v) => {
                      setPassword(v);
                      setShowGen(false);
                    }}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="it-totp">TOTP secret (base32, optional)</Label>
                <Input
                  id="it-totp"
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  className="font-mono"
                  aria-invalid={!totpValid}
                />
                {!totpValid && (
                  <p className="text-xs text-destructive">
                    Doesn&apos;t look like a base32 secret (A–Z and 2–7 only).
                  </p>
                )}
              </div>
            </>
          )}

          {kind === "card" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="it-cardno">Card number</Label>
                <Input
                  id="it-cardno"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="it-holder">Cardholder</Label>
                <Input
                  id="it-holder"
                  value={cardholder}
                  onChange={(e) => setCardholder(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="it-exp">Expiry</Label>
                  <Input id="it-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="it-cvv">CVV</Label>
                  <Input
                    id="it-cvv"
                    value={cvv}
                    onChange={(e) => setCvv(e.target.value)}
                    className="font-mono"
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="it-notes">Notes</Label>
            <textarea
              id="it-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={kind === "note" ? 6 : 3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
