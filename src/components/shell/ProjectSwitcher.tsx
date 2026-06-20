"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mind-studio/ui";
import { useShell } from "@/lib/shell/context";

/**
 * The top-left project switcher (wireframe "▼ Product"). Lists the projects in
 * the current workspace plus an "All / no project" option that scopes the shell
 * to the whole workspace. Selecting a project calls `setProject`.
 */
export function ProjectSwitcher() {
  const { projects, project, setProject } = useShell();
  const current = project?.name ?? "No project";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
          <span className="text-muted-foreground">▼</span>
          <span className="max-w-40 truncate">{current}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Projects in this workspace</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setProject(null)}>
          All <span className="ml-1 text-muted-foreground">· no project</span>
        </DropdownMenuItem>
        {projects.length > 0 && <DropdownMenuSeparator />}
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} onClick={() => setProject(p)}>
            <span className="truncate">{p.name}</span>
          </DropdownMenuItem>
        ))}
        {projects.length === 0 && <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
