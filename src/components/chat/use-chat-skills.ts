"use client";

import * as React from "react";
import type { ClientWorkSkill } from "@/lib/work/skills";

export interface ChatSkillsState {
  /** Null until the first read lands. */
  skills: ClientWorkSkill[] | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

/**
 * The skills this chat could be sent under.
 *
 * `?enabled=true`, for the same reason the Work menu asks for it: a disabled
 * skill is refused server-side, so a row that can be picked, arms a pill, and
 * is then silently ignored by the turn is worse than no row. The one place a
 * disabled skill should be visible is /skills, where it can be switched back
 * on, and every surface here links there.
 *
 * Trust is deliberately NOT filtered on. It gates whether Juno may reach for a
 * skill on its own, and this list is the reader naming one — `selectSkillBySlug`
 * explicitly does not consult trust, because the user typed the name. Hiding an
 * untrusted skill here would remove the only route by which a skill somebody
 * has just imported from GitHub can ever be tried.
 *
 * LAZY, unlike the Work version. This hook sits in the chat composer, which is
 * mounted on every conversation in the product; fetching a skill library on
 * mount would put a request on the critical path of every chat for a control
 * most of them never open. `enabled` is the gate — the composer passes true
 * once the reader opens the palette or the add menu — and the result is kept
 * for the life of the composer afterwards.
 *
 * A failed load is carried rather than swallowed: "you have no skills" and
 * "Juno could not find out" are different sentences and only the second one
 * deserves a Retry.
 */
export function useChatSkills(enabled: boolean): ChatSkillsState {
  const [skills, setSkills] = React.useState<ClientWorkSkill[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // A ref, not state: this guards the fetch and must be readable synchronously
  // inside the effect that fires it, or StrictMode's double-run asks twice.
  const askedRef = React.useRef(false);

  const load = React.useCallback(async () => {
    askedRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch("/api/work/skills?enabled=true");
      if (!response.ok) throw new Error("skills");
      const data = (await response.json()) as { skills?: ClientWorkSkill[] };
      setSkills(data.skills ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled || askedRef.current) return;
    void load();
  }, [enabled, load]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  return { skills, loading, failed, reload };
}

/**
 * Reads a leading `/slug` out of a draft, and only when it names a real skill.
 *
 * The composer converts the typed form into an armed pill: this is what lets
 * somebody type `/tidy-inbox sort these` and press Enter without the route
 * ever parsing a message for a slash (see `chatBodySchema.skillSlug`). The
 * check against the library is what makes it safe to do at all — `/Users/liam`
 * is a path, `/usr` is a path, and neither of them is a skill on this account,
 * so neither arms anything.
 *
 * Returns the remainder as well, because the `/slug` token is addressed to Juno
 * rather than part of the request, and leaving it in the message sends the
 * model a sentence that begins with a command it was never given.
 */
export function readSkillInvocation(
  draft: string,
  skills: readonly ClientWorkSkill[] | null
): { skill: ClientWorkSkill; remainder: string } | null {
  if (!skills || skills.length === 0) return null;
  const match = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(\s[\s\S]*)?$/.exec(draft);
  if (!match) return null;
  const skill = skills.find((entry) => entry.slug === match[1]);
  if (!skill) return null;
  return { skill, remainder: (match[2] ?? "").trim() };
}
