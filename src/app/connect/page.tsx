import ConnectForm from "@/components/ConnectForm";

// The dev-shortcut panel describes the LOCAL CSS instance's seeded accounts.
// Only show it when this build targets a local issuer — otherwise it leaks dev
// credentials onto the production pod. Mirrors DEFAULT_ISSUER in session.ts.
const ISSUER =
  process.env.NEXT_PUBLIC_SOLID_ISSUER ??
  process.env.NEXT_PUBLIC_POD_BASE_URL ??
  "https://pod.mindpods.org/";
const IS_LOCAL_ISSUER =
  ISSUER.includes("localhost") || ISSUER.includes("127.0.0.1");

export default function ConnectPage() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-16 sm:px-10 overflow-y-auto max-h-screen">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        Mind Shell — the everything app
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">
        Sign in once. Everything lives in your pod.
      </h1>
      <p className="mt-4 text-muted-foreground">
        One surface wraps your identity: switch workspaces, projects and apps —
        starting with Vault, a password manager whose secrets only you can read.
      </p>
      <div className="mt-8">
        <ConnectForm />
      </div>
      {IS_LOCAL_ISSUER && (
        <div className="mt-12 rounded-lg border bg-muted/40 px-5 py-4 text-sm text-muted-foreground">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Dev shortcut
          </p>
          <p className="mt-2">
            The local CSS instance on port 3101 has two pre-seeded accounts:
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            <li>alice@mind-shell.local · dev-only-do-not-use-in-prod</li>
            <li>bob@mind-shell.local · dev-only-do-not-use-in-prod</li>
          </ul>
        </div>
      )}
    </section>
  );
}
