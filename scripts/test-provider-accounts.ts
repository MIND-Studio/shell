/**
 * Unit test for the provider-account projection (PRD-PROVIDER-ACCOUNTS P0).
 *
 * Runs the PURE projection (no crypto, no pod, no DOM) over crafted passport
 * fixtures and asserts the trust gradient holds — above all that the MAIN
 * IDENTITY (a `client-credentials` passport) is NEVER projected into a viewable
 * login, even if it carries stray email/password fields.
 *
 * Usage:  npx tsx scripts/test-provider-accounts.ts   (or: npm run test:provider-accounts)
 *
 * Pure-logic test: no servers, no env. Exits non-zero on first failed assertion.
 */
import {
  projectProviderAccounts,
  hasViewableLogin,
  hostLabel,
} from "../src/lib/identity/provider-accounts";
import type { Passport } from "../src/lib/identity/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

function eq<T>(name: string, got: T, want: T) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

const now = "2026-06-07T00:00:00.000Z";

// --- Fixtures ----------------------------------------------------------------

/** A sealed hybrid-workspace login — SHOULD be projected. */
const workspace: Passport = {
  id: "pp-ws1",
  did: "did:key:zMain",
  server: "https://pod.mindpods.org",
  webId: "https://pod.mindpods.org/me/profile/card#me",
  podRoots: ["https://pod.mindpods.org/work/"],
  label: "Work",
  createdAt: now,
  didLinked: true,
  workspace: true,
  creds: { kind: "password", email: "you+ws1@example.com", password: "s3cret-pw-24chars-xxxx" },
};

/** THE MAIN IDENTITY — client-credentials key card. MUST NOT be projected,
 *  even though we maliciously stuff email/password onto its creds. */
const mainIdentity: Passport = {
  id: "pp-main",
  did: "did:key:zMain",
  server: "https://pod.mindpods.org",
  webId: "https://pod.mindpods.org/me2/profile/card#me",
  podRoots: ["https://pod.mindpods.org/me2/"],
  label: "Personal",
  createdAt: now,
  creds: {
    kind: "client-credentials",
    id: "cc-id",
    secret: "cc-secret-NEVER-SHOW",
    email: "leak@example.com",
    password: "ROOT-PASSWORD-MUST-NOT-LEAK",
  },
};

/** A credential-less manual passport — not projectable yet (no stored login). */
const manual: Passport = {
  id: "pp-manual",
  did: "did:key:zMain",
  server: "https://inrupt.example",
  webId: "https://inrupt.example/me#me",
  podRoots: [],
  createdAt: now,
  creds: { kind: "none" },
};

/** A password-kind record MISSING the password — must be filtered (incomplete). */
const incompleteNoPw: Passport = {
  ...workspace,
  id: "pp-nopw",
  creds: { kind: "password", email: "x@example.com" },
};

/** A password-kind record MISSING the email — must be filtered (incomplete). */
const incompleteNoEmail: Passport = {
  ...workspace,
  id: "pp-noemail",
  creds: { kind: "password", password: "has-pw-but-no-email" },
};

/** A workspace with no label — label should fall back to the server host. */
const noLabel: Passport = {
  ...workspace,
  id: "pp-nolabel",
  label: "   ",
  server: "https://pods.example.org/",
  creds: { kind: "password", email: "a@b.co", password: "pw" },
};

/** A bring-your-own-email account awaiting confirmation — projects, but PENDING. */
const pendingEmail: Passport = {
  ...workspace,
  id: "pp-pending",
  label: "Inrupt",
  creds: {
    kind: "password",
    email: "you+inrupt@gmail.com",
    password: "pw-pending-24chars-xx",
    emailVerified: false,
  },
};

/** A passport with NO creds at all (pre-credential state) — must be filtered. */
const noCreds: Passport = {
  id: "pp-nocreds",
  did: "did:key:zMain",
  server: "https://pod.mindpods.org",
  webId: "https://pod.mindpods.org/me3#me",
  podRoots: [],
  createdAt: now,
};

const all = [
  workspace,
  mainIdentity,
  manual,
  incompleteNoPw,
  incompleteNoEmail,
  noLabel,
  pendingEmail,
  noCreds,
];

// --- Assertions --------------------------------------------------------------

console.log("provider-account projection:");

const out = projectProviderAccounts(all);
const ids = out.map((a) => a.id);

// 1. Exactly the three complete password-kind records are projected.
eq("projects exactly 3 accounts", out.length, 3);
check("includes the workspace", ids.includes("pp-ws1"));
check("includes the no-label workspace", ids.includes("pp-nolabel"));
check("includes the pending account", ids.includes("pp-pending"));

// 2. THE CRITICAL PROPERTY: the main identity is never present, by id OR by secret.
check("main identity is NOT projected (by id)", !ids.includes("pp-main"));
check("client-credentials never pass hasViewableLogin", !hasViewableLogin(mainIdentity));
const serialized = JSON.stringify(out);
check(
  "root password string never appears anywhere in output",
  !serialized.includes("ROOT-PASSWORD-MUST-NOT-LEAK")
);
check(
  "client-credentials secret never appears anywhere in output",
  !serialized.includes("cc-secret-NEVER-SHOW")
);

// 3. Incomplete and credential-less records are excluded.
check("credential-less (kind none) excluded", !ids.includes("pp-manual"));
check("no-creds passport excluded", !ids.includes("pp-nocreds"));
check("no-creds passport fails hasViewableLogin", !hasViewableLogin(noCreds));
check("password-kind without password excluded", !ids.includes("pp-nopw"));
check("password-kind without email excluded", !ids.includes("pp-noemail"));

// 4. Field mapping is faithful for the included workspace.
const ws = out.find((a) => a.id === "pp-ws1")!;
eq("workspace email mapped", ws.email, "you+ws1@example.com");
eq("workspace password mapped", ws.password, "s3cret-pw-24chars-xxxx");
eq("workspace label preserved", ws.label, "Work");
eq("workspace didLinked mapped", ws.didLinked, true);
eq("workspace flag mapped", ws.workspace, true);
eq("workspace server mapped", ws.server, "https://pod.mindpods.org");

eq("workspace email (real shape) is verified", ws.verification, "verified");
eq("workspace not pending", ws.pending, false);

// 5. Label falls back to the host when blank.
const nl = out.find((a) => a.id === "pp-nolabel")!;
eq("blank label falls back to host", nl.label, "pods.example.org");

// 5b. The bring-your-own-email account surfaces as PENDING (§6).
const pend = out.find((a) => a.id === "pp-pending")!;
eq("pending account verification state", pend.verification, "pending");
eq("pending account pending flag", pend.pending, true);
eq("pending account email mapped", pend.email, "you+inrupt@gmail.com");

// 6. hostLabel helper.
eq("hostLabel strips scheme + path", hostLabel("https://pod.mindpods.org/x/y"), "pod.mindpods.org");
eq("hostLabel tolerates a bare host", hostLabel("not a url"), "not a url");

// 7. Empty input is safe.
eq("empty input → empty output", projectProviderAccounts([]).length, 0);

// --- Report ------------------------------------------------------------------

console.log("");
if (failures.length === 0) {
  console.log(`✓ all ${passed} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
