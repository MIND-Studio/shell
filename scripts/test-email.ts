/**
 * Unit test for the email helpers (PRD-PROVIDER-ACCOUNTS P2 — email branch).
 *
 * Pure logic: placeholder detection, validation, plus-alias suggestion, and the
 * verification-state lifecycle that gates silent resume. No servers, no env.
 *
 * Usage:  npx tsx scripts/test-email.ts   (or: npm run test:email)
 * Exits non-zero on the first failed assertion group.
 */
import {
  isAutoEmail,
  isValidEmail,
  aliasSlug,
  suggestPlusAlias,
  verificationState,
  isVerificationPending,
} from "../src/lib/identity/email";

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

console.log("email helpers:");

// --- isAutoEmail: the shell's non-deliverable placeholders -------------------
check("workspace placeholder is auto", isAutoEmail("family-ab12cd34@workspace.mind.local"));
check("passport placeholder is auto", isAutoEmail("passport-99@passport.mind.local"));
check("bare mind.local is auto", isAutoEmail("x@mind.local"));
check("trailing-dot placeholder is auto", isAutoEmail("x@workspace.mind.local."));
check("real gmail is NOT auto", !isAutoEmail("you@gmail.com"));
check("look-alike .mind.dev is NOT auto", !isAutoEmail("you@mind.dev"));
check("garbage is NOT auto", !isAutoEmail("not-an-email"));

// --- isValidEmail: permissive shape check ------------------------------------
check("plain address valid", isValidEmail("you@gmail.com"));
check("plus-alias valid", isValidEmail("you+ws1@gmail.com"));
check("subdomain valid", isValidEmail("a@mail.example.co.uk"));
check("no domain dot invalid", !isValidEmail("you@localhost"));
check("no local invalid", !isValidEmail("@gmail.com"));
check("no at invalid", !isValidEmail("you.gmail.com"));
check("whitespace invalid", !isValidEmail("you @gmail.com"));
check("empty invalid", !isValidEmail(""));
check("trailing-dot domain invalid", !isValidEmail("you@gmail."));

// --- aliasSlug ---------------------------------------------------------------
eq("slug lowercases + hyphenates", aliasSlug("Work Drive"), "work-drive");
eq("slug trims edge separators", aliasSlug("  Family!! "), "family");
eq("slug collapses runs", aliasSlug("a___b   c"), "a-b-c");
eq("slug of empty is empty", aliasSlug("   "), "");

// --- suggestPlusAlias --------------------------------------------------------
eq("alias from plain base", suggestPlusAlias("you@gmail.com", "Work Drive"), "you+work-drive@gmail.com");
eq(
  "alias replaces existing +tag (idempotent)",
  suggestPlusAlias("you+old@gmail.com", "New"),
  "you+new@gmail.com"
);
eq(
  "empty label drops the +tag",
  suggestPlusAlias("you+old@gmail.com", "   "),
  "you@gmail.com"
);
eq("non-email base returned unchanged", suggestPlusAlias("not-an-email", "x"), "not-an-email");
// Re-aliasing the result with the same label is stable.
eq(
  "alias is stable under re-application",
  suggestPlusAlias(suggestPlusAlias("you@gmail.com", "Work"), "Work"),
  "you+work@gmail.com"
);

// --- verificationState lifecycle ---------------------------------------------
eq("no creds → not-required", verificationState(undefined), "not-required");
eq("no email → not-required", verificationState({}), "not-required");
eq(
  "placeholder email → not-required",
  verificationState({ email: "x@workspace.mind.local", emailVerified: false }),
  "not-required"
);
eq(
  "real email, flagged false → pending",
  verificationState({ email: "you@gmail.com", emailVerified: false }),
  "pending"
);
eq(
  "real email, flagged true → verified",
  verificationState({ email: "you@gmail.com", emailVerified: true }),
  "verified"
);
eq(
  "real email, flag absent (legacy) → verified",
  verificationState({ email: "you@gmail.com" }),
  "verified"
);

// --- isVerificationPending (the silent-resume gate) --------------------------
check("pending real email blocks resume", isVerificationPending({ email: "you@gmail.com", emailVerified: false }));
check("placeholder never pending", !isVerificationPending({ email: "x@workspace.mind.local", emailVerified: false }));
check("verified not pending", !isVerificationPending({ email: "you@gmail.com", emailVerified: true }));

// --- Report ------------------------------------------------------------------
console.log("");
if (failures.length === 0) {
  console.log(`✓ all ${passed} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
