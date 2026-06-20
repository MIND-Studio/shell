"use client";

/**
 * Passport provisioning (PRD-DID C2 / §5.6-§5.7 — "close the gap").
 *
 * A passport is a per-server bundle the master identity owns: a FRESH WebID + a
 * pod + a fully independent account on that server. Provisioning now owns the
 * whole lifecycle ({@link createPassportAccount}): it creates a NEW account,
 * auto-generates a strong password (via the Vault's own generator — the user
 * never picks or sees one), mints the fresh WebID + pod, and captures durable
 * **client-credentials** so the shell can later sign in headlessly with NO typed
 * password and NO redirect (PRD-DID §5.6). This is the gap-closing change: the
 * shell becomes your password manager for servers.
 *
 * Servers stay stock: no DID plugin, no fork — just the account API every CSS
 * exposes. Non-CSS providers (Inrupt PodSpaces, …) aren't automatable uniformly
 * (CAPTCHA / email verification), so we keep a manual-capture path: the user
 * signs up in a browser and pastes the WebID + pod. Manually-captured passports
 * carry no creds, so they still sign in via the normal /connect redirect.
 *
 * Security (AGENTS.md rule #5): the auto-generated account password is used once
 * during account creation and dropped — the durable secret the wallet keeps is
 * the client-credentials pair, sealed in the encrypted registry, never written
 * to a pod, never logged. Only the public WebID + pod root (+ the secret-bearing
 * creds, into the sealed registry) leave this module.
 */

import { getPlatform } from "@/lib/platform";
import { createPassportAccount } from "@/lib/solid/account";
import type { Passport } from "./types";
import { newPassportId, sign as walletSign } from "./wallet";

/** Origin of a server URL, trailing-slash-free (e.g. "http://localhost:3101"). */
function origin(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    return server.replace(/\/$/, "");
  }
}

/** A strong, unique account password from the audited Vault generator. */
async function generateAccountPassword(): Promise<string> {
  const core = await (await getPlatform()).crypto.getCore();
  return core.generatePassword({
    length: 24,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: true,
  });
}

/** A unique, non-identifying account email (never used as an identifier — §5.8). */
function autoEmail(label?: string): string {
  const slug =
    (label ?? "passport")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "passport";
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${slug}-${rand}@passport.mind.local`;
}

/**
 * Provision a passport on a CSS server and assemble the {@link Passport} record
 * (NOT yet stored — the caller adds it to the encrypted registry via the wallet).
 * The account password is auto-generated; `email` may be supplied as a recovery
 * channel but is auto-generated when omitted.
 */
export async function provisionPassport(opts: {
  did: string;
  server: string;
  label?: string;
  /** Optional recovery email; auto-generated (non-identifying) when omitted. */
  email?: string;
}): Promise<Passport> {
  const password = await generateAccountPassword();
  const email = opts.email?.trim() || autoEmail(opts.label);
  const { webId, podRoot, creds, didLinked } = await createPassportAccount({
    server: origin(opts.server) + "/",
    email,
    password,
    name: opts.label?.trim() || "passport",
    // Bind the master DID to the new account so it can later log in by signing a
    // challenge (server-side DID login). Best-effort: skipped on a stock CSS.
    linkDid: { did: opts.did, sign: walletSign },
  });
  return {
    id: newPassportId(),
    did: opts.did,
    server: origin(opts.server),
    webId,
    podRoots: [podRoot],
    label: opts.label?.trim() || undefined,
    email,
    createdAt: new Date().toISOString(),
    bound: false,
    // Record whether the account-level DID link succeeded, so the Identity UI
    // can surface "DID login ready" without re-probing the server.
    didLinked,
    creds: { kind: "client-credentials", id: creds.id, secret: creds.secret },
  };
}

/**
 * Manual-capture fallback: the user already has a WebID + pod (any provider) and
 * pastes them. Validates shape; the wallet then writes the binding to claim it.
 */
export function captureManualPassport(opts: {
  did: string;
  webId: string;
  podRoot: string;
  label?: string;
}): Passport {
  const webId = opts.webId.trim();
  const podRoot = opts.podRoot.trim();
  let webUrl: URL;
  let podUrl: URL;
  try {
    webUrl = new URL(webId);
  } catch {
    throw new Error("That doesn't look like a valid WebID URL.");
  }
  try {
    podUrl = new URL(podRoot);
  } catch {
    throw new Error("That doesn't look like a valid pod URL.");
  }
  if (!/^https?:$/.test(webUrl.protocol) || !/^https?:$/.test(podUrl.protocol)) {
    throw new Error("WebID and pod must be http(s) URLs.");
  }
  return {
    id: newPassportId(),
    did: opts.did,
    server: webUrl.origin,
    webId,
    podRoots: [podRoot.endsWith("/") ? podRoot : podRoot + "/"],
    label: opts.label?.trim() || undefined,
    createdAt: new Date().toISOString(),
    bound: false,
  };
}
