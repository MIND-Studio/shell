/**
 * Loud "this is a prototype — don't store real secrets" banner.
 *
 * shell / Vault is an unaudited prototype (AGENTS.md §6: independent
 * crypto review is required *before* the core touches real secrets, and that
 * review has not happened). Shown on the front door and inside Vault so a user
 * can't reach a password field without seeing it.
 */
export function PrototypeWarning({ className = "" }: { className?: string }) {
  return (
    <div
      role="alert"
      data-testid="prototype-warning"
      className={`flex items-start gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-700 dark:text-amber-200 ${className}`}
    >
      <span aria-hidden className="text-lg leading-none">
        ⚠️
      </span>
      <div className="text-sm">
        <p className="font-semibold">Prototype — don’t use real passwords.</p>
        <p className="mt-0.5 text-amber-800 dark:text-amber-200/80">
          This Vault is an unaudited preview. Use throwaway, made-up secrets only — never your real
          accounts.
        </p>
      </div>
    </div>
  );
}
