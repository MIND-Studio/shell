/**
 * Smoke test for the Vault zero-knowledge invariant — at the DATA layer.
 *
 * Usage:
 *   docker compose up -d        # CSS on :3101
 *   npm run seed:demo           # lays down /apps/vault/items/ (empty)
 *   # ...run the app, unlock Vault, create an item (writes a real *.enc)...
 *   npm run smoke:vault
 *
 * WHAT THIS VERIFIES (and what it does NOT):
 *
 *   The real encryption happens in the browser, in the Rust crypto core
 *   (crypto-core/, loaded as WASM). Importing that WASM in a bare Node script
 *   is not a faithful test of the shipping path, and this script deliberately
 *   does NOT attempt it. Instead it asserts the OBSERVABLE invariant the
 *   protocol promises (PRD §4, §10; AGENTS.md invariant #1):
 *
 *     "Only ciphertext, wrapped keys, KDF params and salt reach the pod."
 *
 *   So this script connects to the pod, lists {pod}/apps/vault/items/, reads
 *   every *.enc resource, and asserts the bytes are OPAQUE:
 *     - not decodable as a UTF-8 JSON object, and
 *     - contain none of a set of obvious plaintext markers
 *       (e.g. "password", "username", "otpauth", "BEGIN").
 *
 *   This is a guardrail against the worst regression (an item accidentally
 *   PUT as cleartext JSON), NOT a cryptographic audit. It does not check AEAD
 *   tag integrity, KDF strength, key wrapping, or nonce uniqueness — those
 *   live in `cargo test` (KATs) inside crypto-core and an independent review
 *   (PRD §8). If the items container is empty it prints a clear "run the app
 *   first" note and exits 0 — there is simply nothing to inspect yet.
 */
import { Session } from "@inrupt/solid-client-authn-node";
import {
  getSolidDataset,
  getContainedResourceUrlAll,
} from "@inrupt/solid-client";

const POD_BASE = process.env.POD_BASE_URL ?? "http://localhost:3101/";
const EMAIL = process.env.SEED_EMAIL ?? "alice@mind-shell.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-only-do-not-use-in-prod";
const POD_NAME = process.env.SEED_POD ?? "alice";

const ROOT = `${POD_BASE}${POD_NAME}/`;
const WEBID = `${ROOT}profile/card#me`;
const ITEMS = `${ROOT}apps/vault/items/`;

/** Plaintext that must NEVER appear in an opaque item blob. */
const PLAINTEXT_MARKERS = [
  "password",
  "username",
  "otpauth://",
  "secret",
  "-----BEGIN",
  "creditCard",
  "cardNumber",
];

async function mintCredentials(): Promise<{ id: string; secret: string }> {
  const indexRes = await fetch(`${POD_BASE}.account/`);
  if (!indexRes.ok) {
    throw new Error(`CSS account index ${indexRes.status} — is CSS running?`);
  }
  const { controls } = (await indexRes.json()) as {
    controls: { password: { login: string } };
  };
  const loginRes = await fetch(controls.password.login, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { authorization } = (await loginRes.json()) as { authorization: string };
  const accountRes = await fetch(`${POD_BASE}.account/`, {
    headers: { Authorization: `CSS-Account-Token ${authorization}` },
  });
  const account = (await accountRes.json()) as {
    controls: { account: { clientCredentials: string } };
  };
  const credRes = await fetch(account.controls.account.clientCredentials, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
    },
    body: JSON.stringify({ name: "mind-shell-smoke", webId: WEBID }),
  });
  if (!credRes.ok) {
    throw new Error(
      `Credentials creation failed: ${credRes.status} ${await credRes.text()}`
    );
  }
  return (await credRes.json()) as { id: string; secret: string };
}

/** True if the bytes parse as a JSON object/array (a plaintext-item smell). */
function looksLikeJson(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false; // not valid UTF-8 ⇒ certainly not JSON ⇒ opaque, good.
  }
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Markers found by case-insensitive scan of the decoded text, if any. */
function plaintextMarkersIn(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return []; // not UTF-8 ⇒ no readable markers.
  }
  const hay = text.toLowerCase();
  return PLAINTEXT_MARKERS.filter((m) => hay.includes(m.toLowerCase()));
}

async function main() {
  console.log(`[smoke] connecting to ${POD_BASE} as ${EMAIL}`);
  const { id, secret } = await mintCredentials();
  const session = new Session();
  await session.login({ clientId: id, clientSecret: secret, oidcIssuer: POD_BASE });
  if (!session.info.isLoggedIn) throw new Error("login did not stick");
  console.log(`[smoke] webId = ${session.info.webId}`);

  // List the items container.
  let itemUrls: string[];
  try {
    const ds = await getSolidDataset(ITEMS, { fetch: session.fetch });
    itemUrls = getContainedResourceUrlAll(ds).filter((u) => u.endsWith(".enc"));
  } catch (err) {
    console.log(`[smoke] could not read ${ITEMS}: ${(err as Error).message}`);
    console.log("[smoke] run `npm run seed:demo` first to create the container.");
    await session.logout();
    process.exit(0);
  }

  if (itemUrls.length === 0) {
    console.log(`[smoke] no items to check in ${ITEMS}`);
    console.log("[smoke] (run the app, unlock Vault, and create an item first)");
    await session.logout();
    process.exit(0);
  }

  console.log(`[smoke] inspecting ${itemUrls.length} item(s) for plaintext leaks`);
  const failures: string[] = [];

  for (const url of itemUrls) {
    const res = await session.fetch(url);
    if (!res.ok) {
      failures.push(`${url} — GET ${res.status}`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (looksLikeJson(bytes)) {
      failures.push(`${url} — decodes as JSON (looks like a PLAINTEXT item!)`);
    }
    const markers = plaintextMarkersIn(bytes);
    if (markers.length > 0) {
      failures.push(`${url} — contains plaintext marker(s): ${markers.join(", ")}`);
    }
    if (!looksLikeJson(bytes) && markers.length === 0) {
      console.log(`  · ok  ${url} (${bytes.length} bytes, opaque)`);
    }
  }

  await session.logout();

  if (failures.length > 0) {
    console.error("\n[smoke] FAIL — zero-knowledge invariant violated:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }

  console.log(`\n[smoke] PASS — all ${itemUrls.length} item(s) are opaque.`);
  console.log("[smoke] note: this checks opacity only, NOT AEAD/KDF strength");
  console.log("[smoke]       (those live in crypto-core `cargo test` + review).");
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
