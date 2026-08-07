"use client";

import * as React from "react";
import type { ClientWorkSkill } from "@/lib/work/skills";

export interface WorkSkillsState {
  /** Null while the list is still in flight. */
  skills: ClientWorkSkill[] | null;
  failed: boolean;
  reload: () => void;
}

/**
 * The skills this account could name on a task.
 *
 * `?enabled=true` rather than the whole library, because `selectSkillBySlug`
 * refuses a disabled skill with `reason: "disabled"` — so a switched-off skill
 * in this menu would be a row that can be picked, writes its name into the
 * goal, and is then silently ignored by the run. The one place a disabled skill
 * should be visible is /work/skills, where it can be switched back on, and the
 * menu links there.
 *
 * Trust is deliberately not filtered on. It gates whether Juno may reach for a
 * skill *on its own* — `trustPermitsAutoSelection` — and this menu is the
 * reader naming one, which `skillFromInvocation` explicitly does not consult:
 * "the user typed the name". Hiding an untrusted skill here would remove the
 * only route by which a skill somebody has just imported can ever be tried.
 *
 * A failed load is carried rather than swallowed, on the same argument as
 * `useConnectedApps` beside it: "you have no skills" and "Juno could not find
 * out" are different sentences, and only the second one deserves a Retry.
 */
export function useWorkSkills(): WorkSkillsState {
  const [skills, setSkills] = React.useState<ClientWorkSkill[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/work/skills?enabled=true");
      if (!response.ok) throw new Error("skills");
      const data = (await response.json()) as { skills?: ClientWorkSkill[] };
      setSkills(data.skills ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  return { skills, failed, reload };
}
