"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MindLoginCard,
  writeLastIdentity,
  clearLastIdentity,
} from "@mind-studio/core";
import { Button } from "@mind-studio/ui";
import { DEFAULT_ISSUER } from "@/lib/solid/session";
import { getPlatform } from "@/lib/platform";
import { hasWallet, getView } from "@/lib/identity/wallet";
import WalletOnboarding from "@/components/WalletOnboarding";
import PasswordLoginCard from "@/components/PasswordLoginCard";
import type { ISessionInfo } from "@inrupt/solid-client-authn-browser";

const APP_NAME = "Shell";
// Indigo accent — distinguishes the shell from its teal siblings (PRD §7).
const SHELL_ACCENT = "#6366f1";

export default function ConnectForm() {
  const router = useRouter();
  const [webId, setWebId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Returning" = a wallet exists but is locked (a hard reload dropped the
  // in-memory session). We lead with the one-tap unlock hero and tuck the other
  // ways in behind a link. Read after mount (localStorage is client-only).
  const [returning, setReturning] = useState(false);
  const [showOthers, setShowOthers] = useState(false);

  useEffect(() => {
    setReturning(hasWallet() && getView().status === "locked");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenCallback: (() => void) | undefined;
    let onFocus: (() => void) | undefined;

    // Record a logged-in session. On NATIVE we navigate straight to the shell
    // (the OIDC redirect came back out-of-band to the app, so there is no
    // page reload to route us there — without this the connect page just sits
    // here even though the Rust session is now established). On web we keep the
    // existing "Connected → Enter the shell" card (the browser redirect already
    // routes returning users via app/page.tsx).
    function adopt(info: ISessionInfo, navigate: boolean) {
      if (cancelled) return;
      const id = info.webId ?? null;
      if (!id) return;
      writeLastIdentity(APP_NAME, {
        webId: id,
        displayName: id.split("/").filter(Boolean).pop(),
      });
      if (navigate) router.replace("/shell");
      else setWebId(id);
    }

    getPlatform().then((p) => {
      if (cancelled) return;

      // Initial read — web delegates to the single-flight ensureSession (HARD
      // rule #3, no second handleIncomingRedirect call site); native reads the
      // Rust-held session via auth_status (not logged in on a fresh launch).
      p.auth
        .ensureSession()
        .then((info) => adopt(info, false))
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });

      if (p.kind === "native") {
        // The native OIDC redirect returns via a deep-link callback (§3.1):
        // subscribe so we advance to the shell the moment the Rust session
        // resolves. (Web's onAuthCallback is a no-op.)
        unlistenCallback = p.auth.onAuthCallback((info) => {
          if (info.isLoggedIn) adopt(info, true);
          else if (!cancelled)
            setError("Sign-in did not complete. Please try again.");
        });

        // Belt-and-suspenders: when the user switches back from the system
        // browser, re-read the session in case the callback event was missed.
        onFocus = () => {
          p.auth
            .ensureSession()
            .then((info) => {
              if (info.isLoggedIn) adopt(info, true);
            })
            .catch(() => {});
        };
        window.addEventListener("focus", onFocus);
      }
    });

    return () => {
      cancelled = true;
      unlistenCallback?.();
      if (onFocus) window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  async function onLogout() {
    const p = await getPlatform();
    await p.auth.logout();
    clearLastIdentity(APP_NAME);
    setWebId(null);
  }

  if (webId) {
    return (
      <div className="rounded-lg border border-primary/40 bg-primary/5 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">
          Connected
        </p>
        <p className="mt-2 break-all font-mono text-sm" data-testid="webid">
          {webId}
        </p>
        <div className="mt-4 flex gap-3">
          <Button asChild>
            <a href="/shell">Enter the shell →</a>
          </Button>
          <Button variant="outline" onClick={onLogout}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  // The redirect path (existing/external pods + native). CSS-only on-page password
  // login can't cover external issuers, so this stays as a secondary affordance.
  const redirectCard = (
    <MindLoginCard
      appName={APP_NAME}
      defaultIssuer={DEFAULT_ISSUER}
      accent={SHELL_ACCENT}
      tagline="One surface for everything in your pod."
      onLogin={async ({ issuer }) => {
        // Platform owns the redirect: web does the browser OIDC redirect
        // (remember issuer + return-to "/shell" + navigate to the IdP, same as
        // the old browserOidcLogin path); native opens the system auth session.
        const p = await getPlatform();
        await p.auth.login(issuer, "/shell");
      }}
    />
  );

  const errorBanner = error && (
    <p className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  // Returning user: lead with the one-tap unlock hero (WalletOnboarding shows the
  // unlock card for a locked wallet); everything else is collapsed behind a link.
  if (returning) {
    return (
      <div className="space-y-6">
        <WalletOnboarding />

        {!showOthers ? (
          <button
            type="button"
            onClick={() => setShowOthers(true)}
            className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Use a different account
          </button>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-[color:var(--border)]" />
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Different account
              </span>
              <span className="h-px flex-1 bg-[color:var(--border)]" />
            </div>
            <PasswordLoginCard />
            {redirectCard}
          </div>
        )}
        {errorBanner}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Wallet-first: create a brand-new DID-rooted identity (+ first pod), or
          resume an existing wallet headlessly. The zero-to-pod new-user path. */}
      <WalletOnboarding />

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-[color:var(--border)]" />
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Already have a Mind pod?
        </span>
        <span className="h-px flex-1 bg-[color:var(--border)]" />
      </div>

      {/* Primary on-page option: type your account password, no redirect. */}
      <PasswordLoginCard />

      {/* Secondary: redirect to an external/different issuer (and native). */}
      {redirectCard}
      {errorBanner}
    </div>
  );
}
