/**
 * Seed a demo workspace into the local CSS pod so the shell + Vault are not
 * empty on first login.
 *
 * Usage:
 *   docker compose up -d        # CSS on :3101 (seeds alice@mind-shell.local)
 *   npm run seed:demo
 *
 * This lays down ONLY the non-secret scaffolding (PRD §6):
 *   {pod}/workspace.ttl                  mind:Workspace (title + owner WebID)
 *   {pod}/apps/shell/layout.ttl          shell's own state — pinned tiles + theme
 *   {pod}/apps/shell/recents.ttl         shell's own state — recent apps
 *   {pod}/apps/vault/manifest.ttl        mind:App self-declaration (Vault)
 *   {pod}/apps/vault/items/              empty container (real .enc items are
 *                                        written client-side by the Rust core)
 *   {pod}/projects/product/project.ttl   one demo project ("Product")
 *
 * HARD RULE (PRD §4, AGENTS.md invariant #1): this script writes NO plaintext
 * secrets and NO fake encrypted vault items. Vault items are AEAD ciphertext
 * produced only by the browser-side crypto core; the seed never touches them.
 *
 * Idempotent — every write is a PUT (overwrite); containers tolerate prior
 * existence. We log only WebID / path / status — never credentials.
 */
import { Session } from "@inrupt/solid-client-authn-node";

const POD_BASE = process.env.POD_BASE_URL ?? "http://localhost:3101/";
const EMAIL = process.env.SEED_EMAIL ?? "alice@mind-shell.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-only-do-not-use-in-prod";
const POD_NAME = process.env.SEED_POD ?? "alice";
const SHELL_URL =
  process.env.NEXT_PUBLIC_APP_SHELL_URL ?? "http://localhost:3100";

const ROOT = `${POD_BASE}${POD_NAME}/`;
const WEBID = `${ROOT}profile/card#me`;
const PROFILE_DOC = `${ROOT}profile/card`;
const DISPLAY_NAME = process.env.SEED_NAME ?? "Alice";

/**
 * Obtain client credentials for the seeded account via the CSS Account API,
 * then log a node Session in with them (same flow as the sibling prototypes).
 */
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
    body: JSON.stringify({ name: "mind-shell-seed", webId: WEBID }),
  });
  if (!credRes.ok) {
    throw new Error(
      `Credentials creation failed: ${credRes.status} ${await credRes.text()}`
    );
  }
  return (await credRes.json()) as { id: string; secret: string };
}

async function put(session: Session, url: string, body: string, contentType: string) {
  const res = await session.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · wrote ${url} (${res.status})\n`);
}

/**
 * Add a display name to the auto-generated WebID profile card via SPARQL PATCH.
 * We INSERT rather than PUT so the CSS-minted triples in the card (pim:storage,
 * solid:oidcIssuer, etc.) survive — clobbering the card would break login + pod
 * discovery. INSERT DATA is idempotent for a fixed name (RDF set semantics).
 */
async function patchProfileName(session: Session) {
  const sparql = `PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
INSERT DATA {
  <${WEBID}> foaf:name "${DISPLAY_NAME}" ;
             vcard:fn "${DISPLAY_NAME}" .
}`;
  const res = await session.fetch(PROFILE_DOC, {
    method: "PATCH",
    headers: { "Content-Type": "application/sparql-update" },
    body: sparql,
  });
  if (!res.ok) {
    throw new Error(`PATCH ${PROFILE_DOC} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · named profile "${DISPLAY_NAME}" (${res.status})\n`);
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
  // 412 (precondition failed) / 205 / 409 ⇒ the container already exists. Fine.
  if (!res.ok && ![205, 409, 412].includes(res.status)) {
    throw new Error(`Container PUT ${url} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · ensured ${url} (${res.status})\n`);
}

const PREFIXES = `@prefix mind: <https://mind.dev/ns/v1#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix schema: <https://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

function workspaceTtl(): string {
  return `${PREFIXES}
<#workspace> a mind:Workspace ;
    dct:title "Alice's Workspace" ;
    mind:owner <${WEBID}> .
`;
}

/** Shell's own pinned-tile + theme state (PRD §3 — /apps/shell/ is Dock's own). */
function shellLayoutTtl(): string {
  return `${PREFIXES}
<#layout> a mind:ShellLayout ;
    mind:theme "dark" ;
    mind:tile <#tile-vault>, <#tile-drive> .

<#tile-vault> a mind:AppTile ;
    mind:app "vault" ;
    mind:pinned true ;
    mind:order 0 .

<#tile-drive> a mind:AppTile ;
    mind:app "drive" ;
    mind:pinned true ;
    mind:order 1 .
`;
}

function shellRecentsTtl(): string {
  const now = new Date().toISOString();
  return `${PREFIXES}
<#recents> a mind:ShellRecents ;
    mind:recent <#recent-vault> .

<#recent-vault> a mind:RecentApp ;
    mind:app "vault" ;
    dct:modified "${now}"^^xsd:dateTime .
`;
}

/** Vault's mind:App self-declaration for Dock discovery (PRD §4.2). */
function vaultManifestTtl(): string {
  return `${PREFIXES}
<#app> a mind:App ;
    schema:name "Vault" ;
    mind:icon "🔐" ;
    mind:hostedAt <${SHELL_URL}/> ;
    dct:description "Zero-knowledge password manager — your secrets, encrypted in your pod." .
`;
}

function projectTtl(): string {
  return `${PREFIXES}
<#project> a mind:Project ;
    dct:title "Product" ;
    mind:owner <${WEBID}> ;
    mind:member <${WEBID}> .
`;
}

async function main() {
  console.log(`[seed] minting client credentials at ${POD_BASE}`);
  const { id, secret } = await mintCredentials();

  const session = new Session();
  await session.login({ clientId: id, clientSecret: secret, oidcIssuer: POD_BASE });
  if (!session.info.isLoggedIn) throw new Error("login did not stick");
  console.log(`[seed] webId = ${session.info.webId}`);

  console.log(`[seed] seeding workspace scaffolding under ${ROOT}`);

  // Give the WebID a human display name (B0) — INSERT, never clobber the card.
  await patchProfileName(session);

  // Workspace root metadata.
  await put(session, `${ROOT}workspace.ttl`, workspaceTtl(), "text/turtle");

  // Shell's own state.
  await ensureContainer(session, `${ROOT}apps/`);
  await ensureContainer(session, `${ROOT}apps/shell/`);
  await put(session, `${ROOT}apps/shell/layout.ttl`, shellLayoutTtl(), "text/turtle");
  await put(session, `${ROOT}apps/shell/recents.ttl`, shellRecentsTtl(), "text/turtle");

  // Vault scaffolding — manifest + an EMPTY items container. No vault.ttl
  // (KDF params / wrapped keys) and no *.enc items: those are written
  // client-side by the real crypto core on first unlock.
  await ensureContainer(session, `${ROOT}apps/vault/`);
  await put(session, `${ROOT}apps/vault/manifest.ttl`, vaultManifestTtl(), "text/turtle");
  await ensureContainer(session, `${ROOT}apps/vault/items/`);

  // One demo project — "Product" (matches the wireframe).
  await ensureContainer(session, `${ROOT}projects/`);
  await ensureContainer(session, `${ROOT}projects/product/`);
  await put(session, `${ROOT}projects/product/project.ttl`, projectTtl(), "text/turtle");

  console.log("[seed] done.");
  console.log("[seed] open http://localhost:3100/");
  console.log(`[seed] OIDC issuer = ${POD_BASE}`);
  await session.logout();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
