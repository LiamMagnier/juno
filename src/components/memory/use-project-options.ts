"use client";

import * as React from "react";

/*
 * The projects a memory can be moved into, for a row's "Move to project" menu.
 *
 * Loaded on first use rather than with the page: most visits never open that
 * menu, and the list is the account's projects, not its memory, so the memory
 * routes do not carry it. One request per visit to the page, shared by every
 * row.
 *
 * Held by the page, not in a module-level cache: a cache that outlives the page
 * outlives the project list too, so a project created since (or in the same
 * session, before coming back here) was missing from the menu until a full
 * reload. A failed load is reported as such and retried the next time a menu
 * opens, rather than standing in for "no other projects".
 */

export interface ProjectOption {
  id: string;
  name: string;
}

/** The list; null while it has not arrived; "failed" when the last attempt did not. */
export type ProjectOptions = ProjectOption[] | null | "failed";

export function useProjectOptions(): { projects: ProjectOptions; load: () => void } {
  const [projects, setProjects] = React.useState<ProjectOptions>(null);
  const settled = React.useRef(false);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = React.useCallback(() => {
    if (settled.current || inFlight.current) return;
    inFlight.current = true;
    setProjects((prev) => (prev === "failed" ? null : prev));
    void fetch("/api/projects")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { projects?: ProjectOption[] };
        settled.current = true;
        if (mounted.current) {
          setProjects((data.projects ?? []).map((project) => ({ id: project.id, name: project.name })));
        }
      })
      .catch(() => {
        if (mounted.current) setProjects("failed");
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  return { projects, load };
}
