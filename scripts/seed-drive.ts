/**
 * Register the REAL `drive` app in alice's pod catalog so the shell hosts
 * it in the app body (PRD-APPS P2 — but the ZERO-DRIVE-EDIT variant).
 *
 * Unlike the toy `embed-demo`, Drive is NOT a bridge client: it has no
 * `mind:hello` handshake and authenticates itself via @inrupt's browser OIDC.
 * So we register it as `mind:trust "first-party"`, which makes `IframeHost` give
 * it `allow-same-origin` — the iframe keeps its own (:3060) origin, loads its own
 * Next chunks (no dev-403), and runs its OWN login against the shared issuer.
 *
 *   NOTE: this is the self-authenticating posture, NOT the brokered one. The
 *   shell does NOT hand Drive a credential (it can't — Drive won't ask). It's a
 *   "see how it looks" wiring; the real brokered P2 needs a small shim in Drive.
 *
 * Usage:
 *   docker compose up -d                       # CSS on :3101 (alice)
 *   (cd ../drive && NEXT_PUBLIC_SOLID_ISSUER=http://localhost:3101/ \
 *      NEXT_PUBLIC_POD_BASE_URL=http://localhost:3101/ npm run dev)   # Drive :3060
 *   npm run dev                                # shell :3100
 *   npm run seed:drive
 *
 * Idempotent: DELETE WHERE clears any stale url, then INSERT DATA writes the
 * entry. Logs only WebID / path / status — never credentials.
 */
import { Session } from "@inrupt/solid-client-authn-node";

const POD_BASE = process.env.POD_BASE_URL ?? "http://localhost:3101/";
const EMAIL = process.env.SEED_EMAIL ?? "alice@mind-shell.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-only-do-not-use-in-prod";
const POD_NAME = process.env.SEED_POD ?? "alice";
const DRIVE_URL = process.env.DRIVE_URL ?? "http://localhost:3060";

const ROOT = `${POD_BASE}${POD_NAME}/`;
const WEBID = `${ROOT}profile/card#me`;
const APPS_DOC = `${ROOT}home/apps.ttl`;

/** Mint client credentials via the CSS Account API (same flow as seed-demo.ts). */
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
    body: JSON.stringify({ name: "mind-shell-seed-drive", webId: WEBID }),
  });
  if (!credRes.ok) {
    throw new Error(`Credentials creation failed: ${credRes.status} ${await credRes.text()}`);
  }
  return (await credRes.json()) as { id: string; secret: string };
}

/** Idempotent container create; tolerates "already exists". */
async function ensureContainer(session: Session, url: string) {
  const res = await session.fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "text/turtle",
      Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      "If-None-Match": "*",
    },
  });
  if (!res.ok && ![205, 409, 412].includes(res.status)) {
    throw new Error(`Container PUT ${url} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · ensured ${url} (${res.status})\n`);
}

async function main() {
  console.log(`[seed-drive] minting client credentials at ${POD_BASE}`);
  const { id, secret } = await mintCredentials();

  const session = new Session();
  await session.login({ clientId: id, clientSecret: secret, oidcIssuer: POD_BASE });
  if (!session.info.isLoggedIn) throw new Error("login did not stick");
  console.log(`[seed-drive] webId = ${session.info.webId}`);

  await ensureContainer(session, `${ROOT}home/`);

  const sparql = `PREFIX mind: <http://mind.example/voc#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE WHERE { <#drive> mind:url ?u . } ;
INSERT DATA {
  <#drive> rdf:type mind:App ;
    mind:label "Drive" ;
    mind:url "${DRIVE_URL}" ;
    mind:icon "📁" ;
    mind:order 5 ;
    mind:embed "iframe" ;
    mind:trust "first-party" .
}`;
  const res = await session.fetch(APPS_DOC, {
    method: "PATCH",
    headers: { "Content-Type": "application/sparql-update" },
    body: sparql,
  });
  if (!res.ok) {
    throw new Error(`PATCH ${APPS_DOC} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · registered <#drive> in ${APPS_DOC} (${res.status})\n`);

  console.log("[seed-drive] done.");
  console.log(`[seed-drive] open the shell and pick "Drive" in the app switcher.`);
  await session.logout();
}

main().catch((err) => {
  console.error("[seed-drive] failed:", err);
  process.exit(1);
});
