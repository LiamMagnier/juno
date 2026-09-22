"use client";

import * as React from "react";
import type { ClientWorkSkill } from "@/lib/work/skills";
import { skillIsAvailable, sourceLabel, type SkillLibrary } from "@/lib/skills/library-contract";

/** A skill as the composer lists it: the wire skill, plus where it came from. */
export interface ChatSkill extends ClientWorkSkill {
  /** A skill written here or saved from a run, rather than installed from a repository. */
  yours: boolean;
  /**
   * "owner/repo" for an installed skill. Null for one of your own, and also
   * when the server could not say (a deployment without the library
   * endpoint), which is why `yours` is carried separately: an unknown source
   * must not be labelled as yours.
   */
  sourceLabel: string | null;
  /** The repository's owner, for its avatar; null exactly when `sourceLabel` is. */
  sourceOwner: string | null;
}

/** What the composer calls the skills you wrote, beside a repository's name. */
export const YOURS_SOURCE_LABEL = "Yours";

export interface ChatSkillsState {
  /** Null until the first read lands. */
  skills: ChatSkill[] | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

/**
 * The library flattened into the order the composer lists it: your own skills
 * first, then each installed repository in the library's order. Only what chat
 * can actually use survives: a skill switched off, or one whose repository is
 * switched off, would be a row that arms a pill and is then refused.
 */
export function chatSkillsFromLibrary(library: SkillLibrary): ChatSkill[] {
  const yours = library.yours
    .filter((skill) => skillIsAvailable(skill, null))
    .map((skill) => ({ ...skill, yours: true, sourceLabel: null, sourceOwner: null }));
  const installed = library.sources.flatMap((source) =>
    source.skills
      .filter((skill) => skillIsAvailable(skill, source))
      .map((skill) => ({ ...skill, yours: false, sourceLabel: sourceLabel(source), sourceOwner: source.owner }))
  );
  return [...yours, ...installed];
}

/**
 * The skills this chat could be sent under.
 *
 * The LIBRARY (`GET /api/skills`), not the flat list, because the composer
 * labels each skill with the repository it came from and groups them by it,
 * and only the library knows which source a skill belongs to. It is also the
 * only read with no silent cap: `/api/work/skills` stops at 50 unless asked,
 * and an account with more lost the rest from the "/" palette. A deployment
 * that does not have the library yet (404) gets the flat list at the route's
 * ceiling of 200, unlabelled.
 *
 * Only skills chat can use are kept, for the same reason the Work menu asks
 * for `?enabled=true`: a disabled skill is refused server-side, so a row that
 * can be picked, arms a pill, and is then silently ignored by the turn is
 * worse than no row. The one place a disabled skill should be visible is
 * /skills, where it can be switched back on, and every surface here links
 * there.
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
  const [skills, setSkills] = React.useState<ChatSkill[] | null>(null);
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
      const response = await fetch("/api/skills");
      if (response.ok) {
        const library = (await response.json()) as Partial<SkillLibrary>;
        setSkills(
          chatSkillsFromLibrary({
            yours: Array.isArray(library.yours) ? library.yours : [],
            sources: Array.isArray(library.sources) ? library.sources : [],
            total: library.total ?? 0,
            truncated: library.truncated === true,
          })
        );
        return;
      }
      if (response.status !== 404) throw new Error("skills");
      const flat = await fetch("/api/work/skills?enabled=true&limit=200");
      if (!flat.ok) throw new Error("skills");
      const data = (await flat.json()) as { skills?: ClientWorkSkill[] };
      setSkills((data.skills ?? []).map((skill) => ({ ...skill, yours: false, sourceLabel: null, sourceOwner: null })));
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
