"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@mind-studio/ui";
import { useState } from "react";
import { useShell } from "@/lib/shell/context";

/**
 * The top-left project switcher (wireframe "▼ Product"). Lists the projects in
 * the current workspace plus an "All / no project" option that scopes the shell
 * to the whole workspace. Selecting a project calls `setProject`; "New project"
 * writes a project container in the active workspace and switches to it.
 */
export function ProjectSwitcher() {
  const { projects, project, setProject, workspacePod } = useShell();
  const current = project?.name ?? "No project";
  const [creating, setCreating] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
          >
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
          {/* Creating needs an active workspace pod to write into. */}
          {workspacePod && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <span className="text-muted-foreground">＋</span>
                <span className="ml-1">New project</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { createProject } = useShell();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createProject({ name });
      setName("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is a board, timeline, meetings and briefings — stored in your workspace pod.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="mt-4 space-y-2">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Marketing site relaunch"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
