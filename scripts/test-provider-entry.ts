/**
 * Unit test for provider-entry policy (PRD-PROVIDER-ACCOUNTS P1 + P4).
 *
 * Pure logic: host-based account matching, the brokered-vs-stored-login entry
 * plan (brokered preferred, stored login the fallback, both coexist), and the P1
 * "will the login actually be sealed?" gate. No servers, no env.
 *
 * Usage:  npx tsx scripts/test-provider-entry.ts   (or: npm run test:provider-entry)
 * Exits non-zero on the first failed assertion group.
 */
import {
  matchAccountForServer,
  planProviderEntry,
  willSealWorkspaceLogin,
} from "../src/lib/identity/provider-entry";
import { brokeredHandoffAvailable } from "../src/lib/shell/brokered-bridge";
import type { ProviderAccount } from "../src/lib/identity/provider-accounts";
import type { HostedApp } from "../src/lib/shell/types";

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

const acct = (over: Partial<ProviderAccount>): ProviderAccount => ({
  id: "pp-x",
  label: "Drive",
  server: "https://pods.mindpods.org",
  webId: "https://pods.mindpods.org/me#me",
  email: "you@example.com",
  password: "pw-24-chars-xxxxxxxxxxxx",
  didLinked: false,
  workspace: true,
  manual: false,
  verification: "verified",
  pending: false,
  ...over,
});

console.log("provider-entry policy:");

// --- matchAccountForServer (host-based, scheme/path-agnostic) ----------------
const drive = acct({ id: "pp-drive", server: "https://pods.mindpods.org" });
const other = acct({ id: "pp-other", server: "https://pod.example.org" });
const accounts = [drive, other];

eq("matches exact origin", matchAccountForServer(accounts, "https://pods.mindpods.org")?.id, "pp-drive");
eq("matches ignoring trailing path", matchAccountForServer(accounts, "https://pods.mindpods.org/me#me")?.id, "pp-drive");
eq("matches ignoring scheme/case", matchAccountForServer(accounts, "HTTP://PODS.MINDPODS.ORG")?.id, "pp-drive");
eq("no match → undefined", matchAccountForServer(accounts, "https://nope.example"), undefined);
eq("empty accounts → undefined", matchAccountForServer([], "https://pods.mindpods.org"), undefined);

// --- planProviderEntry: stored-login path (no broker) ------------------------
const stored = planProviderEntry({ server: "https://pods.mindpods.org", accounts, brokered: false });
eq("no broker, has login → stored-login", stored.mode, "stored-login");
eq("stored-login carries the matched account", stored.account?.id, "pp-drive");
eq("stored-login has no separate fallback", stored.fallbackAvailable, false);

// --- planProviderEntry: nothing to offer -------------------------------------
const none = planProviderEntry({ server: "https://unknown.example", accounts, brokered: false });
eq("no broker, no login → none", none.mode, "none");
check("none carries no account", none.account === undefined);
eq("none has no fallback", none.fallbackAvailable, false);

// --- planProviderEntry: brokered preferred, login coexists as fallback -------
const brokeredWithLogin = planProviderEntry({
  server: "https://pods.mindpods.org",
  accounts,
  brokered: true,
});
eq("broker available → brokered mode", brokeredWithLogin.mode, "brokered");
eq("brokered still carries the login (coexist)", brokeredWithLogin.account?.id, "pp-drive");
eq("brokered + login → fallback available", brokeredWithLogin.fallbackAvailable, true);

// --- planProviderEntry: brokered with no stored login ------------------------
const brokeredNoLogin = planProviderEntry({
  server: "https://unknown.example",
  accounts,
  brokered: true,
});
eq("brokered, no login → still brokered", brokeredNoLogin.mode, "brokered");
eq("brokered, no login → no fallback", brokeredNoLogin.fallbackAvailable, false);
check("brokered, no login → no account", brokeredNoLogin.account === undefined);

// --- willSealWorkspaceLogin (P1 honesty gate) --------------------------------
check("unlocked wallet seals the login", willSealWorkspaceLogin("unlocked"));
check("locked wallet does NOT seal", !willSealWorkspaceLogin("locked"));
check("no wallet does NOT seal", !willSealWorkspaceLogin("none"));

// --- brokeredHandoffAvailable (P4 wired to the live shell catalog) ------------
const app = (over: Partial<HostedApp>): HostedApp => ({
  key: "drive",
  label: "Drive",
  icon: "📁",
  url: "https://pods.mindpods.org/drive",
  enabled: true,
  embed: "iframe",
  trust: "first-party",
  ...over,
});

const iframeApps = [app({})];
check(
  "first-party iframe app, host match → brokered",
  brokeredHandoffAvailable("https://pods.mindpods.org", iframeApps)
);
check(
  "host match ignores scheme/path/case",
  brokeredHandoffAvailable("HTTP://PODS.MINDPODS.ORG/me#me", iframeApps)
);
check(
  "no host match → not brokered",
  !brokeredHandoffAvailable("https://other.example", iframeApps)
);
check(
  "link-embed app → not brokered",
  !brokeredHandoffAvailable("https://pods.mindpods.org", [app({ embed: "link" })])
);
check(
  "in-process app → not brokered",
  !brokeredHandoffAvailable("https://pods.mindpods.org", [app({ embed: "inprocess" })])
);
check(
  "community-trust iframe → not brokered",
  !brokeredHandoffAvailable("https://pods.mindpods.org", [app({ trust: "community" })])
);
check(
  "disabled app → not brokered",
  !brokeredHandoffAvailable("https://pods.mindpods.org", [app({ enabled: false })])
);
check(
  "no apps → not brokered",
  !brokeredHandoffAvailable("https://pods.mindpods.org", [])
);
check("undefined server → not brokered", !brokeredHandoffAvailable(undefined, iframeApps));

// --- Report ------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`✓ all ${passed} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
