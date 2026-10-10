/**
 * Skills in Alevr Code's composer (skills lane, contracts `skills.list`).
 *
 * Three kinds, listed in this order:
 *   Yours                  the account's skills, the ones Chat runs (`/api/skills`)
 *   Installed on this Mac  ~/.claude/skills, ~/.codex/skills, ~/.alevr/skills, Claude Code plugins
 *   Project                the thread's own folder (.alevr/.juno/.claude/skills)
 *
 * The Mac's come from its env server over the device link (`skills.list`):
 * names, descriptions and paths only. Chosen from the Skills chip, a skill
 * stays with the thread (kept per thread here, and by the env server, which
 * applies the thread's selection to any message that does not name its own);
 * chosen as `/name`, it runs for the next message only.
 *
 * Pure: the composer, the gallery fixtures and the tests share it.
 */
import type { LocalSkillSummary, SkillActivation, SkillSource } from "./contracts";

export type SkillGroup = "yours" | "mac" | "project";

export const SKILL_GROUP_TITLES: Record<SkillGroup, string> = {
  yours: "Yours",
  mac: "Installed on this Mac",
  project: "Project",
};

const GROUP_ORDER: SkillGroup[] = ["yours", "mac", "project"];

/** One row of the Skills selector and the `/` menu. */
export interface CodeSkillChoice {
  /** `source:name`, stable across reads. */
  id: string;
  /** What `/name` invokes. */
  name: string;
  /** Display name: an account skill's own; a local skill's name. */
  title: string;
  description: string;
  source: SkillSource;
  group: SkillGroup;
  /** Where it came from, in the reader's words ("Claude Code", "impeccable plugin", "owner/repo"). */
  originLabel?: string;
  /** Local skills: the SKILL.md path on the Mac. */
  path?: string;
  /** Account skills: the library id, to read the instructions with. */
  accountId?: string;
}

/** An account skill as `/api/skills` lists it (the subset Code needs). */
export interface AccountSkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  sourceLabel?: string | null;
}

export function skillGroupOf(source: SkillSource): SkillGroup {
  return source === "account" ? "yours" : source === "project" ? "project" : "mac";
}

export function originLabel(skill: Pick<LocalSkillSummary, "source" | "origin" | "plugin">): string {
  if (skill.source === "plugin") return skill.plugin ? `${skill.plugin} plugin` : "Plugin";
  switch (skill.origin) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    default:
      return "Alevr";
  }
}

export function choiceFromLocal(skill: LocalSkillSummary): CodeSkillChoice {
  return {
    id: `${skill.source}:${skill.name}`,
    name: skill.name,
    title: skill.name,
    description: skill.description,
    source: skill.source,
    group: skillGroupOf(skill.source),
    originLabel: originLabel(skill),
    path: skill.path,
  };
}

export function choiceFromAccount(skill: AccountSkillRow): CodeSkillChoice {
  return {
    id: `account:${skill.slug}`,
    name: skill.slug,
    title: skill.name,
    description: skill.description,
    source: "account",
    group: "yours",
    ...(skill.sourceLabel ? { originLabel: skill.sourceLabel } : {}),
    accountId: skill.id,
  };
}

/** Yours, then this Mac's, then the project's; each id once, read order kept within a group. */
export function orderSkills(choices: readonly CodeSkillChoice[]): CodeSkillChoice[] {
  const seen = new Set<string>();
  const unique = choices.filter((c) => !seen.has(c.id) && (seen.add(c.id), true));
  return GROUP_ORDER.flatMap((g) => unique.filter((c) => c.group === g));
}

/** Search: names (and titles) that start with the query first, then anything that contains it. */
export function matchSkills(choices: readonly CodeSkillChoice[], query: string): CodeSkillChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...choices];
  const prefix = choices.filter((c) => c.name.startsWith(q) || c.title.toLowerCase().startsWith(q));
  const rest = choices.filter(
    (c) =>
      !prefix.includes(c) &&
      (c.name.includes(q) || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || (c.originLabel?.toLowerCase().includes(q) ?? false)),
  );
  return [...prefix, ...rest];
}

/** Grouped for browsing, groups in order, empty ones left out. */
export function groupSkills(choices: readonly CodeSkillChoice[]): { group: SkillGroup; title: string; skills: CodeSkillChoice[] }[] {
  return GROUP_ORDER.map((group) => ({ group, title: SKILL_GROUP_TITLES[group], skills: choices.filter((c) => c.group === group) })).filter((g) => g.skills.length > 0);
}

/**
 * A leading `/name …` that names a real skill, and the words after it. A
 * path (`/Users/liam`) or a command (`/plan`) names no skill and arms nothing.
 */
export function readCodeSkillInvocation(draft: string, choices: readonly CodeSkillChoice[]): { skill: CodeSkillChoice; remainder: string } | null {
  const match = /^\s*\/([a-z0-9][a-z0-9._-]*)(\s[\s\S]*)?$/.exec(draft);
  if (!match) return null;
  const skill = choices.find((c) => c.name === match[1]);
  if (!skill) return null;
  return { skill, remainder: (match[2] ?? "").trim() };
}

/** The chip's words: "Skills", one skill's name, or "2 skills". */
export function skillsChipLabel(selected: readonly CodeSkillChoice[], once: CodeSkillChoice | null): string {
  const names = [...selected.map((s) => s.title), ...(once ? [`/${once.name}`] : [])];
  if (names.length === 0) return "Skills";
  if (names.length === 1) return names[0]!;
  return `${names.length} skills`;
}

/** A chosen id the list has not loaded (yet): still sent, by name; never an account skill (it needs its text). */
export function placeholderChoice(id: string): CodeSkillChoice | null {
  const at = id.indexOf(":");
  if (at <= 0) return null;
  const source = id.slice(0, at) as SkillSource;
  const name = id.slice(at + 1);
  if (!name || (source !== "project" && source !== "user" && source !== "plugin")) return null;
  return { id, name, title: name, description: "", source, group: skillGroupOf(source) };
}

/** The activations a message runs under: the thread's, then an armed `/name` one. */
export async function buildActivations(
  selected: readonly CodeSkillChoice[],
  once: CodeSkillChoice | null,
  readInstructions: (accountId: string) => Promise<string | null>,
): Promise<SkillActivation[]> {
  const one = async (c: CodeSkillChoice, isOnce: boolean): Promise<SkillActivation | null> => {
    const base: SkillActivation = { name: c.name, source: c.source, ...(c.title !== c.name ? { title: c.title } : {}), ...(isOnce ? { once: true } : {}) };
    if (c.source !== "account") return { ...base, ...(c.path ? { path: c.path } : {}) };
    const instructions = c.accountId ? await readInstructions(c.accountId).catch(() => null) : null;
    return instructions ? { ...base, instructions } : null;
  };
  const out = await Promise.all([...selected.map((c) => one(c, false)), ...(once && !selected.some((s) => s.id === once.id) ? [one(once, true)] : [])]);
  return out.filter((a): a is SkillActivation => a !== null);
}

// ── Persistence (per thread) ────────────────────────────────────────────────

export const skillsStorageKey = (threadId: string) => `alevr.code.skills.${threadId}`;

/** The ids a thread keeps, from the env server's snapshot when this browser has none. */
export function idsFromSnapshot(skills: readonly SkillActivation[] | undefined): string[] {
  return (skills ?? []).filter((s) => s.once !== true).map((s) => `${s.source}:${s.name}`);
}
