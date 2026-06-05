/**
 * Register the toy "Embed Demo" app in the pod's app catalog so the shell can
 * HOST it in the app body (PRD-APPS P0/P1). This adds a single `mind:App` entry
 * with the new hosting predicates `mind:embed "iframe"` + `mind:trust "community"`
 * to `{pod}/home/apps.ttl` — proving R1: "install = a pod edit, no shell rebuild".
 *
 * Usage:
 *   docker compose up -d            # CSS on :3101 (seeds alice@mind-shell.local)
 *   npm run dev                     # shell on :3100 (serves /embed-demo)
 *   npm run seed:embed-demo
 *
 * Then sign into the shell, open the app switcher → "Embed Demo" renders inside.
 *
 * Idempotent: a SPARQL INSERT DATA of fixed triples is a no-op on re-run (RDF set
 * semantics). Vocab matches @mind-studio/core's launcher: http://mind.example/voc#.
 * Logs only WebID / path / status — never credentials.
 */
import { Session } from "@inrupt/solid-client-authn-node";

const POD_BASE = process.env.POD_BASE_URL ?? "http://localhost:3101/";
const EMAIL = process.env.SEED_EMAIL ?? "alice@mind-shell.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-only-do-not-use-in-prod";
const POD_NAME = process.env.SEED_POD ?? "alice";
const SHELL_URL = process.env.NEXT_PUBLIC_APP_SHELL_URL ?? "http://localhost:3100";

const ROOT = `${POD_BASE}${POD_NAME}/`;
const WEBID = `${ROOT}profile/card#me`;
const APPS_DOC = `${ROOT}home/apps.ttl`;
// A STATIC public/ file — NOT a Next route. A hosted app is a self-contained
// foreign bundle; a Next page's `/_next/static` chunks get 403'd inside the
// opaque-origin sandbox by Next's dev `blockCrossSiteDEV`. See public/embed-demo.html.
const DEMO_URL = `${SHELL_URL}/embed-demo.html`;

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
    body: JSON.stringify({ name: "mind-shell-embed-demo", webId: WEBID }),
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
  console.log(`[seed-embed] minting client credentials at ${POD_BASE}`);
  const { id, secret } = await mintCredentials();

  const session = new Session();
  await session.login({ clientId: id, clientSecret: secret, oidcIssuer: POD_BASE });
  if (!session.info.isLoggedIn) throw new Error("login did not stick");
  console.log(`[seed-embed] webId = ${session.info.webId}`);

  // The catalog lives at {pod}/home/apps.ttl — ensure the container exists.
  await ensureContainer(session, `${ROOT}home/`);

  // Upsert the toy app. SPARQL PATCH creates apps.ttl if absent; DELETE…WHERE
  // first clears any stale url (e.g. an earlier `/embed-demo` route) so a re-run
  // re-points it, then INSERT writes the entry. Idempotent; leaves any
  // launcher-seeded entries untouched.
  // Two ops separated by `;`: a BGP-only `DELETE WHERE` (CSS rejects OPTIONAL /
  // non-BGP WHERE with 501) to clear any stale url, then `INSERT DATA`.
  const sparql = `PREFIX mind: <http://mind.example/voc#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE WHERE { <#embed-demo> mind:url ?u . } ;
INSERT DATA {
  <#embed-demo> rdf:type mind:App ;
    mind:label "Embed Demo" ;
    mind:url "${DEMO_URL}" ;
    mind:icon "🧪" ;
    mind:order 9 ;
    mind:embed "iframe" ;
    mind:trust "community" .
}`;
  const res = await session.fetch(APPS_DOC, {
    method: "PATCH",
    headers: { "Content-Type": "application/sparql-update" },
    body: sparql,
  });
  if (!res.ok) {
    throw new Error(`PATCH ${APPS_DOC} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · registered <#embed-demo> in ${APPS_DOC} (${res.status})\n`);

  console.log("[seed-embed] done.");
  console.log(`[seed-embed] open ${SHELL_URL}/ and pick "Embed Demo" in the app switcher.`);
  await session.logout();
}

main().catch((err) => {
  console.error("[seed-embed] failed:", err);
  process.exit(1);
});
