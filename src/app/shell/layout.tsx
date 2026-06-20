"use client";

import { AccountSwitcher } from "@/components/shell/AccountSwitcher";
import { AppMenu } from "@/components/shell/AppMenu";
import { AppSwitcher } from "@/components/shell/AppSwitcher";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { WorkspaceRail } from "@/components/shell/WorkspaceRail";
import { ShellProvider, useShell } from "@/lib/shell/context";

/**
 * The shell chrome (PRD §3 wireframe). A full-bleed, non-scrolling frame:
 *
 *   ┌──────┬──────────┬──────────────────────────┐
 *   │ rail │ AppMenu  │  ProjectSwitcher  AppSwitcher │ ← top bar of content area
 *   │  +   │          │──────────────────────────────│
 *   │  ⚙   │          │        App Body (scrolls)     │
 *   ├──────┤          │                               │
 *   │ acct │          │                               │
 *   └──────┴──────────┴──────────────────────────────┘
 *
 * Only the app body scrolls; the rail, app menu and top bar stay put.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ShellProvider>
      <ShellFrame>{children}</ShellFrame>
    </ShellProvider>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  const { ready } = useShell();

  if (!ready) return <ShellLoading />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Far-left: the full-height workspace rail. */}
      <WorkspaceRail />

      {/* The active app's left-nav column with the account switcher at its foot.
          Hidden on narrow screens; the rail's ⚙ still reaches settings there. */}
      <div className="hidden w-48 shrink-0 flex-col border-r border-[color:var(--border)] md:flex">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AppMenu />
        </div>
        <AccountSwitcher />
      </div>

      {/* Content area: top switchers bar + the scrolling app body. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[color:var(--border)] glass-panel px-3">
          {/* The switcher cluster shrinks/clips first so the account button below
              never gets pushed off the right edge on a narrow (mobile) viewport. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <ProjectSwitcher />
            <span className="text-muted-foreground">/</span>
            <AppSwitcher />
          </div>
          {/* The footer account column is hidden <md, so surface the account
              menu (incl. Log out / theme) here on mobile. Fixed-width, never clipped. */}
          <div className="shrink-0 md:hidden">
            <AccountSwitcher variant="compact" />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function ShellLoading() {
  return (
    <div className="grid h-screen w-screen place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <span className="grid size-12 animate-pulse place-items-center rounded-2xl bg-primary/20 text-2xl">
          ✦
        </span>
        <p className="text-sm">Opening your workspace…</p>
      </div>
    </div>
  );
}
