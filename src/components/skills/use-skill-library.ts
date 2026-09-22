"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ClientSkillSource, LibrarySkill, LibrarySource, SkillLibrary } from "@/lib/skills/library-contract";
import {
  fetchSkillLibrary,
  patchSkill,
  patchSkillSource,
  removeSkillSource,
  skillsFailureMessage,
} from "@/components/skills/skills-transport";

function mapSkills(library: SkillLibrary, id: string, patch: Partial<LibrarySkill>): SkillLibrary {
  const apply = (skill: LibrarySkill) => (skill.id === id ? { ...skill, ...patch } : skill);
  return {
    ...library,
    yours: library.yours.map(apply),
    sources: library.sources.map((source) => ({ ...source, skills: source.skills.map(apply) })),
  };
}

function mapSource(library: SkillLibrary, id: string, patch: Partial<ClientSkillSource>): SkillLibrary {
  return {
    ...library,
    sources: library.sources.map((source) => (source.id === id ? { ...source, ...patch } : source)),
  };
}

/** A new press on `key`; only the answer to the latest press may land. */
function nextTicket(sequence: Map<string, number>, key: string): number {
  const ticket = (sequence.get(key) ?? 0) + 1;
  sequence.set(key, ticket);
  return ticket;
}

/**
 * The library, read once and kept in step with what the reader switches.
 *
 * SWITCHES ANSWER AT ONCE. A toggle writes the new state before the request
 * and puts the old one back if the server refuses, with the server's own
 * sentence in a toast: the common case is instant, and the rare refusal (a
 * blocked skill cannot be switched on) is explained rather than silently
 * undone. Each row keeps a sequence number so a slow answer to an earlier
 * press can never overwrite a later one.
 *
 * A FAILED READ IS SAID. `error` carries a sentence and `library` stays null,
 * so the page draws a retry instead of an empty library; "you have no skills"
 * and "Juno could not find out" are different pages.
 */
export function useSkillLibrary() {
  const [library, setLibrary] = React.useState<SkillLibrary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(new Map<string, number>());

  const load = React.useCallback(async (): Promise<SkillLibrary | null> => {
    setError(null);
    const result = await fetchSkillLibrary();
    if (result.kind === "ok") {
      setLibrary(result.value);
      return result.value;
    }
    setError(
      skillsFailureMessage(
        result,
        "Couldn’t load your skills. The request failed, so this is not an empty library."
      )
    );
    return null;
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const setSkillEnabled = React.useCallback(async (skill: LibrarySkill, enabled: boolean) => {
    const key = `skill:${skill.id}`;
    const ticket = nextTicket(sequence.current, key);
    setLibrary((current) => (current ? mapSkills(current, skill.id, { enabled }) : current));
    const result = await patchSkill(skill.id, { enabled });
    if (sequence.current.get(key) !== ticket) return;
    if (result.kind === "ok") {
      setLibrary((current) => (current ? mapSkills(current, skill.id, { enabled: result.value.enabled }) : current));
      return;
    }
    setLibrary((current) => (current ? mapSkills(current, skill.id, { enabled: skill.enabled }) : current));
    toast.error(skillsFailureMessage(result, "Couldn’t change that. The skill is as it was."));
  }, []);

  const setSourceEnabled = React.useCallback(async (source: LibrarySource, enabled: boolean) => {
    const key = `source:${source.id}`;
    const ticket = nextTicket(sequence.current, key);
    setLibrary((current) => (current ? mapSource(current, source.id, { enabled }) : current));
    const result = await patchSkillSource(source.id, { enabled });
    if (sequence.current.get(key) !== ticket) return;
    if (result.kind === "ok") {
      setLibrary((current) =>
        current ? mapSource(current, source.id, { enabled: result.value?.enabled ?? enabled }) : current
      );
      return;
    }
    setLibrary((current) => (current ? mapSource(current, source.id, { enabled: source.enabled }) : current));
    toast.error(skillsFailureMessage(result, "Couldn’t change that. The repository is as it was."));
  }, []);

  const removeSource = React.useCallback(async (source: LibrarySource): Promise<boolean> => {
    const result = await removeSkillSource(source.id);
    if (result.kind === "ok") {
      setLibrary((current) =>
        current ? { ...current, sources: current.sources.filter((entry) => entry.id !== source.id) } : current
      );
      return true;
    }
    toast.error(skillsFailureMessage(result, "Couldn’t remove that repository. Its skills are still installed."));
    return false;
  }, []);

  return { library, error, reload: load, setSkillEnabled, setSourceEnabled, removeSource };
}
