"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, useMindTheme } from "@mind-studio/ui";
import { getPlatform } from "@/lib/platform";
import { readProfile, readPodRoot, writeProfileName } from "@/lib/solid/profile";

/**
 * Settings — a lean surface outside the /shell chrome (so no ShellProvider). It
 * reads the current session directly, shows the account + workspace, a theme
 * toggle, and an "Account & pods" section that links out (CSS v7 has no
 * app-revoke API, so — like dock — we link to the pod's own account page).
 */

const DOCK_URL = process.env.NEXT_PUBLIC_APP_DOCK_URL ?? "https://dock.mindpods.org";

export default function SettingsPage() {
  const { resolvedMode, setMode } = useMindTheme();
  // `resolvedMode` reads the persisted theme on the client, but SSR / first paint
  // uses the layout's defaultTheme ("dark"). Render the theme-dependent label only
  // after mount so the first client render matches the server — otherwise the
  // "Currently dark/light" text hydration-mismatches when the stored theme is light.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted ? resolvedMode !== "light" : true;

  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [webId, setWebId] = useState<string | null>(null);
  const [podRoot, setPodRoot] = useState<string | null>(null);
  // Only some servers have an account UI: CSS answers GET /.account/ with the
  // account index; a DID-login server (solidrs) has no such page — don't link
  // users to a plain-text 401.
  const [hasAccountPage, setHasAccountPage] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const platform = await getPlatform();
      const info = await platform.auth.ensureSession();
      if (!alive) return;
      if (info.isLoggedIn && info.webId) {
        setWebId(info.webId);
        const [profile, pod] = await Promise.all([
          readProfile(info.webId),
          readPodRoot(info.webId),
        ]);
        if (!alive) return;
        setName(profile.displayName ?? null);
        setPodRoot(pod);
        if (pod) {
          try {
            const res = await fetch(new URL("/.account/", pod).href, {
              headers: { Accept: "application/json" },
            });
            if (alive) setHasAccountPage(res.ok);
          } catch {}
        }
      }
      setLoaded(true);
    })().catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const saveName = async () => {
    const next = draftName.trim();
    if (!webId || !next || next === name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      await writeProfileName(webId, next);
      setName(next);
      setEditingName(false);
    } catch {
      setNameError("Couldn’t save the name to your profile.");
    } finally {
      setSavingName(false);
    }
  };

  // Root-relative: the CSS account UI lives at the server origin (/.account/),
  // not under the pod path — {pod}/.account/ just 401s.
  const accountPage = podRoot ? new URL("/.account/", podRoot).href : undefined;

  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              Mind Shell
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1>
          </div>
          <Button asChild variant="outline">
            <Link href="/shell">Back to shell</Link>
          </Button>
        </div>

        {/* Your account */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-muted-foreground">Your account</h2>
          <div className="mt-3 rounded-xl border border-[color:var(--border)] bg-card p-5">
            {!loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : webId ? (
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="font-medium">
                    {editingName ? (
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveName();
                        }}
                      >
                        <input
                          autoFocus
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onKeyDown={(e) => e.key === "Escape" && setEditingName(false)}
                          aria-label="Display name"
                          data-testid="settings-name-input"
                          className="rounded-md border border-[color:var(--border)] bg-background px-2 py-1 text-sm"
                        />
                        <Button type="submit" size="sm" disabled={savingName || !draftName.trim()}>
                          {savingName ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingName(false)}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        {name ?? "—"}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          data-testid="settings-rename"
                          onClick={() => {
                            setDraftName(name ?? "");
                            setNameError(null);
                            setEditingName(true);
                          }}
                        >
                          Rename
                        </Button>
                      </span>
                    )}
                    {nameError && <p className="mt-1 text-xs text-red-400">{nameError}</p>}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Your ID</dt>
                  <dd className="break-all font-mono text-xs">{webId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Workspace</dt>
                  <dd className="break-all font-mono text-xs">{podRoot ?? "—"}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                You are signed out.{" "}
                <Link href="/connect" className="text-primary underline">
                  Sign in
                </Link>
                .
              </p>
            )}
          </div>
        </section>

        {/* Appearance */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">Appearance</h2>
          <div className="mt-3 flex items-center justify-between rounded-xl border border-[color:var(--border)] bg-card p-5">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">
                Currently {dark ? "dark" : "light"}.
              </p>
            </div>
            <Button variant="outline" onClick={() => setMode(dark ? "light" : "dark")}>
              {dark ? "Switch to light" : "Switch to dark"}
            </Button>
          </div>
        </section>

        {/* Account & pods */}
        <section className="mt-8 mb-12">
          <h2 className="text-sm font-semibold text-muted-foreground">Account &amp; pods</h2>
          <div className="mt-3 space-y-3 rounded-xl border border-[color:var(--border)] bg-card p-5">
            <p className="text-sm text-muted-foreground">
              {hasAccountPage
                ? "Manage your apps, pods and linked identities in the Dock, or open your private account page to change credentials and connected apps."
                : "Manage your apps, pods and linked identities in the Dock. This server has no separate account page — you sign in with the identity in your wallet."}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <a href={DOCK_URL} target="_blank" rel="noreferrer">
                  Open Dock
                </a>
              </Button>
              {hasAccountPage && accountPage && (
                <Button asChild variant="outline">
                  <a href={accountPage} target="_blank" rel="noreferrer">
                    Your account page
                  </a>
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
