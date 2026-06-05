"use client";

import type { AccountIdentity } from "./types";

/**
 * A local, per-device registry of the WebIDs (Accounts) the user has signed into
 * — the source for the account switcher's "switch / add account" list. The
 * @inrupt browser SDK only keeps ONE active session at a time, so multi-account
 * here means "remembered identities you can re-auth as", not concurrent sessions.
 *
 * Stored in localStorage (non-secret: WebID + display name + issuer). Never holds
 * credentials or tokens.
 */
const KEY = "mind-shell:accounts";

export function listAccounts(): AccountIdentity[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AccountIdentity[]) : [];
  } catch {
    return [];
  }
}

export function rememberAccount(account: AccountIdentity): AccountIdentity[] {
  if (typeof window === "undefined") return [];
  const list = listAccounts().filter((a) => a.webId !== account.webId);
  const next = [account, ...list];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function forgetAccount(webId: string): AccountIdentity[] {
  const next = listAccounts().filter((a) => a.webId !== webId);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}
