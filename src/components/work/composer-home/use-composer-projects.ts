"use client";

import * as React from "react";
import { toast } from "sonner";

/*
 * The account's projects, for filing a task.
 *
 * Lifted out of `ProjectChip`, which used to own the list, the create and the
 * dropdown in one component. Two things now need the list on the same
 * composer: the [+] menu, which is where a task gets filed when it is not in a
 * project yet, and the chip on the row, which appears only once it is. One
 * fetch shared between them is what stops the two disagreeing about whether
 * the account has any projects at all.
 */

/** As much of `GET /api/projects` as a composer has any use for. */
export interface ComposerProject {
  id: string;
  name: string;
  conversationCount: number;
}

export interface ComposerProjectsState {
  /** Null while the list is in flight. */
  projects: ComposerProject[] | null;
  failed: boolean;
  creating: boolean;
  reload: () => void;
  /**
   * Makes a project and resolves it, or null when the create was refused.
   *
   * A brand-new project is created unnamed — the API calls it "Untitled
   * project" and renames it from its first conversation — so the caller files
   * the task against it straight away, exactly like picking an existing one.
   */
  create: () => Promise<{ id: string; name: string } | null>;
}

export function useComposerProjects(): ComposerProjectsState {
  const [projects, setProjects] = React.useState<ComposerProject[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("projects");
      const data = (await response.json()) as { projects?: ComposerProject[] };
      setProjects(data.projects ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  // On mount rather than on open: knowing whether the account has any projects
  // decides what the [+] menu offers, and deferring it would swap a row out
  // from under a pointer already heading for it.
  React.useEffect(() => {
    void load();
  }, [load]);

  const create = React.useCallback(async () => {
    if (creating) return null;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? "Could not create the project.");
      const made = { id: data.id, name: "New project", conversationCount: 0 };
      setProjects((prev) => [made, ...(prev ?? [])]);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      return { id: made.id, name: made.name };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the project.");
      return null;
    } finally {
      setCreating(false);
    }
  }, [creating]);

  return React.useMemo(
    () => ({ projects, failed, creating, reload: () => void load(), create }),
    [projects, failed, creating, load, create]
  );
}
