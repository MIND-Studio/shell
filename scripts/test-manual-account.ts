/**
 * Unit test for manual provider-account capture (PRD-PROVIDER-ACCOUNTS P3).
 *
 * Pure logic: server normalization, draft validation, and building the sealed
 * passport — then a round-trip through the P0 projection to prove a captured
 * login surfaces as a viewable provider account, while NEVER being silently
 * resumable (it carries no client-credentials key card). No servers, no env.
 *
 * Usage:  npx tsx scripts/test-manual-account.ts   (or: npm run test:manual-account)
 * Exits non-zero on the first failed assertion group.
 */
import {
  normalizeServer,
  validateManualAccount,
  isManualAccountValid,
  buildManualPassport,
  type ManualAccountDraft,
} from "../src/lib/identity/manual-account";
import { projectProviderAccounts } from "../src/lib/identity/provider-accounts";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) passed++;
  else {
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}
function eq<T>(name: string, got: T, want: T) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

console.log("manual provider-account capture:");

// --- normalizeServer ---------------------------------------------------------
eq("https origin kept", normalizeServer("https://pods.mindpods.org/"), "https://pods.mindpods.org");
eq("path stripped to origin", normalizeServer("https://pods.mindpods.org/x/y#me"), "https://pods.mindpods.org");
eq("scheme added when omitted", normalizeServer("pods.mindpods.org"), "https://pods.mindpods.org");
eq("localhost with port allowed", normalizeServer("http://localhost:3101"), "http://localhost:3101");
eq("blank → null", normalizeServer("   "), null);
eq("host-less → null", normalizeServer("not a url"), null);
eq("bare host (no dot) → null", normalizeServer("https://intranet"), null);
eq("non-http scheme → null", normalizeServer("ftp://pods.example.org"), null);

// --- validateManualAccount ---------------------------------------------------
const good: ManualAccountDraft = {
  label: "Inrupt PodSpaces",
  server: "https://pods.mindpods.org/",
  email: "you+inrupt@gmail.com",
  password: "my-chosen-passw0rd!",
  webId: "https://pods.mindpods.org/me/profile/card#me",
};
check("a complete draft is valid", isManualAccountValid(good));
eq("valid draft → no errors", Object.keys(validateManualAccount(good)).length, 0);

const blank: ManualAccountDraft = { label: " ", server: "", email: "nope", password: "" };
const errs = validateManualAccount(blank);
check("blank label flagged", !!errs.label);
check("bad server flagged", !!errs.server);
check("bad email flagged", !!errs.email);
check("empty password flagged", !!errs.password);
check("blank draft is invalid", !isManualAccountValid(blank));

const badWebId: ManualAccountDraft = { ...good, webId: "not a url" };
check("malformed webId flagged", !!validateManualAccount(badWebId).webId);
const noWebId: ManualAccountDraft = { ...good, webId: undefined };
check("webId is optional", isManualAccountValid(noWebId));

// --- buildManualPassport -----------------------------------------------------
const ctx = { id: "pp-manual-1", did: "did:key:zMaster", createdAt: "2026-06-07T00:00:00.000Z" };
const p = buildManualPassport(good, ctx);
eq("passport id from ctx", p.id, "pp-manual-1");
eq("passport did from ctx", p.did, "did:key:zMaster");
eq("server normalized on the passport", p.server, "https://pods.mindpods.org");
eq("creds kind is password", p.creds?.kind, "password");
eq("email sealed", p.creds?.email, "you+inrupt@gmail.com");
eq("password sealed", p.creds?.password, "my-chosen-passw0rd!");
eq("manual flag set", p.manual, true);
check("NO client-credentials id (never auto-resumed)", !p.creds?.id);
check("NO client-credentials secret (never auto-resumed)", !p.creds?.secret);

// Default: an existing account is already confirmed → verified.
eq("existing account defaults to verified", p.creds?.emailVerified, true);
// Just-registered: caller marks it pending.
const pendingP = buildManualPassport({ ...good, verified: false }, ctx);
eq("verified:false seals pending", pendingP.creds?.emailVerified, false);

// Server normalization is applied even from a sloppy address.
const sloppy = buildManualPassport({ ...good, server: "PODS.mindpods.org/foo" }, ctx);
eq("sloppy server normalized in build", sloppy.server, "https://pods.mindpods.org");

// --- round-trip: a captured login projects as a viewable provider account ----
const projected = projectProviderAccounts([p]);
eq("captured login projects to exactly one account", projected.length, 1);
const acct = projected[0];
eq("projected label", acct.label, "Inrupt PodSpaces");
eq("projected email", acct.email, "you+inrupt@gmail.com");
eq("projected password", acct.password, "my-chosen-passw0rd!");
eq("projected as manual", acct.manual, true);
eq("not a hybrid workspace", acct.workspace, false);
eq("verified → not pending", acct.pending, false);

// A pending capture surfaces as pending in the projection too.
const pendProjected = projectProviderAccounts([pendingP])[0];
eq("pending capture projects pending", pendProjected.pending, true);
eq("pending capture verification state", pendProjected.verification, "pending");

// --- Report ------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`✓ all ${passed} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
