"use client";

/**
 * Signed identity-binding documents (PRD-DID C3 / §5.5).
 *
 * A binding is a small signed RDF resource written into a passport's pod that
 * asserts "this WebID is controlled by did:key:MASTER". It is *pod content*, not
 * a credential any server checks (§2.5) — verification needs ZERO server support:
 * resolve the `did:key`, reconstruct the canonical payload, and check the
 * detached EdDSA signature in the audited Rust core (`verifyBinding`).
 *
 * Default state is UNPUBLISHED (§5.5): the binding lives in your own pod, read by
 * you, and is *shown* to a relationship only when you choose to prove control —
 * which is what keeps the single-master-DID model unlinkable by default (§2.4).
 *
 * The signed payload is a canonical (sorted-key, compact) JSON of
 * `{controller, created, nonce, server, webId}` with a single-use `nonce` so a
 * stale binding can't be replayed onto a different resource. Both write and
 * verify build the payload through {@link canonicalPayload}, so they are
 * guaranteed byte-identical.
 */

import { getPlatform } from "@/lib/platform";
import { ensureContainerChain, readFileText, writeFileText } from "@/lib/solid/pod-fs";
import { sign as walletSign } from "./wallet";

const MIND_NS = "https://mind.dev/ns/v1#";

/** The fields covered by the signature. */
export interface BindingFields {
  webId: string;
  /** The master did:key (controller). */
  controller: string;
  /** ISO 8601 creation time. */
  created: string;
  /** Server origin. */
  server: string;
  /** Single-use nonce (anti-replay). */
  nonce: string;
}

/** A parsed binding document: the signed fields plus the detached signature. */
export interface BindingDoc extends BindingFields {
  proofValue: string;
}

/** Result of verifying a binding (and that it matches the pod it lives in). */
export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Canonical signed payload — sorted keys, compact, deterministic. The object
 * literal is written in alphabetical key order so `JSON.stringify` (which keeps
 * insertion order) yields a stable JCS-style string. All values are strings.
 */
export function canonicalPayload(f: BindingFields): string {
  return JSON.stringify({
    controller: f.controller,
    created: f.created,
    nonce: f.nonce,
    server: f.server,
    webId: f.webId,
  });
}

function bindingUrl(podRoot: string): string {
  const base = podRoot.endsWith("/") ? podRoot : podRoot + "/";
  return `${base}apps/shell/identity.ttl`;
}

function randomNonce(): string {
  const buf = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serialize(doc: BindingDoc): string {
  return `@prefix mind: <${MIND_NS}> .
@prefix sec: <https://w3id.org/security#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<#binding> a mind:IdentityBinding ;
  mind:webId <${doc.webId}> ;
  mind:controller "${esc(doc.controller)}" ;
  mind:server "${esc(doc.server)}" ;
  mind:created "${esc(doc.created)}"^^xsd:dateTime ;
  mind:nonce "${esc(doc.nonce)}" ;
  sec:proofValue "${esc(doc.proofValue)}" ;
  mind:proofPurpose "identity-binding" .
`;
}

/**
 * Build, sign, and write a binding document into a passport's pod. Requires an
 * unlocked wallet (the master key signs in-core). Returns the written document.
 */
export async function writeBinding(opts: {
  podRoot: string;
  webId: string;
  controller: string;
  server: string;
}): Promise<BindingDoc> {
  const fields: BindingFields = {
    webId: opts.webId,
    controller: opts.controller,
    server: opts.server,
    created: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const proofValue = await walletSign(canonicalPayload(fields));
  const doc: BindingDoc = { ...fields, proofValue };

  // Ensure apps/shell/ exists (creating only missing levels — no 404/409 noise),
  // then write the binding. A bare PUT to a deep path would otherwise fail on a
  // missing parent on a fresh passport pod.
  const base = opts.podRoot.endsWith("/") ? opts.podRoot : opts.podRoot + "/";
  await ensureContainerChain(`${base}apps/shell/`, opts.podRoot);
  await writeFileText(bindingUrl(opts.podRoot), serialize(doc), "text/turtle");
  return doc;
}

function lit(ttl: string, pred: string): string | undefined {
  const m = ttl.match(new RegExp(`${pred}\\s+"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : undefined;
}

/** Read + parse the binding document from a pod, or null if none/unreadable. */
export async function readBinding(podRoot: string): Promise<BindingDoc | null> {
  let ttl: string;
  try {
    ttl = await readFileText(bindingUrl(podRoot));
  } catch {
    return null;
  }
  const webMatch = ttl.match(/mind:webId\s+<([^>]+)>/);
  const controller = lit(ttl, "mind:controller");
  const server = lit(ttl, "mind:server");
  const created = lit(ttl, "mind:created");
  const nonce = lit(ttl, "mind:nonce");
  const proofValue = lit(ttl, "sec:proofValue");
  if (!webMatch || !controller || !server || !created || !nonce || !proofValue) {
    return null;
  }
  return { webId: webMatch[1], controller, server, created, nonce, proofValue };
}

/**
 * Verify a binding cryptographically (and sanity-check it belongs to the pod it
 * was read from). Pure crypto in the Rust core — no server trust. Pass
 * `expectedController` (the wallet's did) to also confirm it names YOUR master.
 */
export async function verifyBindingDoc(
  doc: BindingDoc,
  opts?: { podRoot?: string; expectedController?: string },
): Promise<VerifyResult> {
  const core = await (await getPlatform()).crypto.getCore();
  let ok: boolean;
  try {
    ok = await core.verifyBinding(doc.controller, canonicalPayload(doc), doc.proofValue);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "malformed binding" };
  }
  if (!ok) return { ok: false, reason: "signature does not verify" };

  if (opts?.expectedController && opts.expectedController !== doc.controller) {
    return { ok: false, reason: "binding names a different master DID" };
  }
  // Sanity: the bound WebID should live on the same origin as the pod hosting it.
  if (opts?.podRoot) {
    try {
      if (new URL(doc.webId).origin !== new URL(opts.podRoot).origin) {
        return { ok: false, reason: "WebID is not hosted by this pod's server" };
      }
    } catch {
      /* ignore malformed URLs in the sanity check */
    }
  }
  return { ok: true };
}

/** Convenience: read + verify in one call. */
export async function readAndVerify(
  podRoot: string,
  expectedController?: string,
): Promise<{ doc: BindingDoc | null; result: VerifyResult }> {
  const doc = await readBinding(podRoot);
  if (!doc) return { doc: null, result: { ok: false, reason: "no binding found" } };
  const result = await verifyBindingDoc(doc, { podRoot, expectedController });
  return { doc, result };
}
