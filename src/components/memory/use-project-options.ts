"use client";

import * as React from "react";

/*
 * The projects a memory can be moved into, for a row's "Move to project" menu.
 *
 * Loaded on first use rather than with the page: most visits never open that
 * menu, and the list is the account's projects, not its memory, so the memory
 * routes do not carry it. One request per page view, shared by every row.
 */

export interface ProjectOption {
  id: string;
  name: string;
}

let cache: Promise<ProjectOption[]> | null = null;

function loadProjects(): Promise<ProjectOption[]> {
  if (!cache) {
    cache = fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : { projects: [] }))
      .then((data: { projects?: { id: string; name: string }[] }) =>
        (data.projects ?? []).map((project) => ({ id: project.id, name: project.name }))
      )
      .catch(() => {
        // A failed load is retried the next time a menu opens, not cached.
        cache = null;
        return [];
      });
  }
  return cache;
}

/**
 * `null` until requested and loaded. Pass `enabled` from the menu's open state
 * so the request goes out when the reader first reaches for it.
 */
export function useProjectOptions(enabled: boolean): ProjectOption[] | null {
  const [projects, setProjects] = React.useState<ProjectOption[] | null>(null);
  React.useEffect(() => {
    if (!enabled || projects) return;
    let active = true;
    void loadProjects().then((list) => {
      if (active) setProjects(list);
    });
    return () => {
      active = false;
    };
  }, [enabled, projects]);
  return projects;
}
