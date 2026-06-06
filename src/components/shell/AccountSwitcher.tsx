"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useMindTheme,
} from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";
import { getView, subscribe } from "@/lib/identity/wallet";
import { enterPassport, logoutPassport } from "@/lib/identity/passport-login";
import {
  getActivePassportSession,
  subscribePassportSession,
} from "@/lib/solid/passport-session";
import type { Passport, WalletView } from "@/lib/identity/types";

/**
 * The account switcher pinned bottom-left under the rail (wireframe "🐔 S.
 * Heusser ▲"). Shows the current account and a menu to switch between remembered
 * accounts (re-auth via /connect), add an account, open settings, toggle
 * light/dark, and log out. Modeled on dock's TopBar account menu, opening upward.
 *
 * Two trigger shapes share one menu: the default "bar" pins under the rail
 * (desktop); "compact" is just the avatar, mounted in the header on mobile where
 * the rail's footer column is hidden — without it, Log out is unreachable on a
 * phone. The menu content (switch/settings/theme/log out) is identical.
 */
export function AccountSwitcher({ variant = "bar" }: { variant?: "bar" | "compact" }) {
  const { account, accounts, signOut, setActiveApp, reloadIdentity } = useShell();
  const { resolvedMode, setMode } = useMindTheme();
  const dark = resolvedMode !== "light";

  // C4: the switcher's identity source is the wallet (master DID → passports).
  // accounts.ts (remembered WebIDs) stays as a fallback list below.
  const [wallet, setWallet] = useState<WalletView>(() => getView());
  useEffect(() => {
    setWallet(getView());
    return subscribe(() => setWallet(getView()));
  }, []);
  // Hybrid-workspace records live in the same registry (so their auto-generated
  // password is sealed) but they reuse the master WebID — they're workspaces in
  // the rail, not identities to switch to. Keep them out of the switcher list.
  const passports = (wallet.passports ?? []).filter((p) => !p.workspace);

  // Which passport (if any) we're currently acting AS.
  const [activePassportId, setActivePassportId] = useState<string | null>(
    () => getActivePassportSession()?.passportId ?? null
  );
  useEffect(() => {
    const sync = () => setActivePassportId(getActivePassportSession()?.passportId ?? null);
    sync();
    return subscribePassportSession(sync);
  }, []);

  // Headlessly switch to a passport (no password, no redirect). Provisioned
  // passports carry a key; manually-captured ones don't — those open the
  // Identity app where the /connect path is offered.
  const switchToPassport = async (p: Passport) => {
    if (p.creds?.kind !== "client-credentials") {
      setActiveApp("identity");
      return;
    }
    try {
      await enterPassport(p);
      await reloadIdentity();
    } catch {
      setActiveApp("identity");
    }
  };

  const backToMain = async () => {
    logoutPassport();
    await reloadIdentity();
  };

  const name = account?.displayName ? prettySlug(account.displayName) : "Your account";
  const initial = name.slice(0, 1).toUpperCase();
  const webHost = account ? hostOf(account.webId) : undefined;
  const others = accounts.filter((a) => a.webId !== account?.webId);
  // A remembered account that is also one of our passports should show the name
  // the user chose at creation, not its raw pod slug. Match by WebID; fall back
  // to prettifying the slug (strip the `-<hex>` collision suffix) so the switcher
  // never surfaces "personal-c7668c96".
  const labelByWebId = new Map(
    (wallet.passports ?? []).filter((p) => p.label).map((p) => [p.webId, p.label as string])
  );
  const friendlyName = (a: (typeof others)[number]) =>
    labelByWebId.get(a.webId) ?? (a.displayName ? prettySlug(a.displayName) : hostOf(a.webId));

  const avatar = (
    <Avatar className="size-8 ring-1 ring-[color:var(--border)]">
      {account?.avatarUrl ? <AvatarImage src={account.avatarUrl} alt={name} /> : null}
      <AvatarFallback className="bg-primary text-primary-foreground text-xs">
        {initial}
      </AvatarFallback>
    </Avatar>
  );

  const compact = variant === "compact";

  const trigger = compact ? (
    <button
      aria-label="Account menu"
      className="flex items-center rounded-full outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary"
    >
      {avatar}
    </button>
  ) : (
    <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {webHost && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {webHost}
          </span>
        )}
      </span>
      <span className="text-muted-foreground">▲</span>
    </button>
  );

  return (
    <div className={compact ? "" : "border-t border-[color:var(--border)] glass-panel p-2"}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>

        <DropdownMenuContent
          side={compact ? "bottom" : "top"}
          align={compact ? "end" : "start"}
          className="w-64"
        >
          <DropdownMenuLabel>
            <div className="truncate font-medium">{name}</div>
            {account?.webId && (
              <div className="truncate font-mono text-[10px] font-normal text-muted-foreground">
                {account.webId}
              </div>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* C4: master identity + its passports (the wallet is the source). */}
          {wallet.did && (
            <>
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Master identity
              </DropdownMenuLabel>
              <div className="px-2 pb-1">
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {wallet.status === "locked" ? "🔒 " : ""}
                  {wallet.did}
                </p>
              </div>
              {passports.map((p) => {
                const isActive = p.id === activePassportId;
                return (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => void switchToPassport(p)}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="truncate">🪪 {p.label ?? hostOf(p.webId)}</span>
                      {isActive && (
                        <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          active
                        </span>
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              {activePassportId && (
                <DropdownMenuItem onClick={() => void backToMain()}>
                  ↩ Back to my account
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setActiveApp("identity")}>
                Manage identity & passports
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {others.length > 0 && (
            <>
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Switch account
              </DropdownMenuLabel>
              {others.map((a) => (
                <DropdownMenuItem key={a.webId} asChild>
                  <Link href="/connect">
                    <span className="truncate">{friendlyName(a)}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          {!wallet.did && (
            <DropdownMenuItem onClick={() => setActiveApp("identity")}>
              Set up master identity
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href="/connect">Add account</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings">Account settings</Link>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode(dark ? "light" : "dark")}>
            {dark ? "Switch to light" : "Switch to dark"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void signOut()} variant="destructive">
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function hostOf(webId: string): string {
  try {
    return new URL(webId).host;
  } catch {
    return webId;
  }
}

// A provisioned pod slug is `<label>-<8 hex>` (the random collision suffix from
// account.ts). Users never chose the hex, so strip it for display and restore a
// readable label — "personal-c7668c96" → "Personal". Names without that exact
// suffix shape (a server account like "bob") are shown untouched.
function prettySlug(name: string): string {
  const m = /^(.+)-[0-9a-f]{8}$/.exec(name);
  if (!m) return name;
  const base = m[1];
  return base.charAt(0).toUpperCase() + base.slice(1);
}
