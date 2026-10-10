/**
 * Skills on a cloud run (skills lane, Cloud Code).
 *
 * A cloud run has no reader's Mac behind it, so two kinds of skill reach it:
 *
 *   account  the reader's Alevr skills chosen in the composer. The task keeps
 *            their ids; runner-context reads their instructions from the
 *            library and hands them over with the rest of the run's context.
 *   project  the cloned repository's own `.alevr/skills`, `.juno/skills` and
 *            `.claude/skills`, found by the same rules the Mac's env server
 *            uses (skill-files.ts, shared byte for byte), chosen by name.
 *
 * Both go into the engine's system prompt the way the env server's Alevr
 * engine puts them there (`systemAppendix`), so a cloud run and a run on the
 * Mac read a skill identically. A project skill is read from the clone only,
 * by the name the composer sent; a name the repository does not have is
 * reported as missing, never guessed at.
 */
import type { LocalSkillSummary, SkillActivation } from "../contracts/code-v2.js";
import { discoverAll, renderSkillInstructions, resolveSkillActivations, skillRoots, toSummaries, type ResolvedSkill } from "./skill-files.js";

/** An account skill as runner-context hands it over. */
export interface CloudAccountSkill {
  name: string;
  title?: string;
  instructions: string;
}

export interface CloudSkillRequest {
  account?: readonly CloudAccountSkill[];
  /** Names of the repository's own skills. */
  project?: readonly string[];
}

export interface CloudSkills {
  /** The block for the engine's `systemAppendix` ("" when nothing applies). */
  text: string;
  /** The skills the run is under, in order. */
  applied: ResolvedSkill[];
  /** Names asked for that could not be read (not in the repository, no text). */
  missing: string[];
  /** Every skill the clone carries (summaries, for the run's notice). */
  available: LocalSkillSummary[];
}

const MAX_SKILLS = 20;

/** Validates runner-context's `skills` field, dropping anything malformed. */
export function readCloudSkillRequest(value: unknown): CloudSkillRequest {
  if (!value || typeof value !== "object") return {};
  const raw = value as { account?: unknown; project?: unknown };
  const account = Array.isArray(raw.account)
    ? raw.account
        .filter((s): s is CloudAccountSkill => !!s && typeof s === "object" && typeof (s as CloudAccountSkill).name === "string" && typeof (s as CloudAccountSkill).instructions === "string")
        .map((s) => ({ name: s.name, instructions: s.instructions, ...(typeof s.title === "string" && s.title ? { title: s.title } : {}) }))
        .slice(0, MAX_SKILLS)
    : [];
  const project = Array.isArray(raw.project) ? raw.project.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, MAX_SKILLS) : [];
  return { ...(account.length ? { account } : {}), ...(project.length ? { project } : {}) };
}

/**
 * The skills a cloud run in `cwd` (the clone) runs under: the account's,
 * then the repository's chosen ones, read from the clone.
 */
export async function resolveCloudSkills(cwd: string, request: CloudSkillRequest): Promise<CloudSkills> {
  // No home: a runner has no reader's folders, only the repository's.
  const discovered = await discoverAll(await skillRoots({ cwd }));
  const activations: SkillActivation[] = [
    ...(request.account ?? []).map((s): SkillActivation => ({ name: s.name, source: "account", instructions: s.instructions, ...(s.title ? { title: s.title } : {}) })),
    ...(request.project ?? []).map((name): SkillActivation => ({ name, source: "project" })),
  ];
  const { skills, missing } = await resolveSkillActivations(activations, discovered);
  return { text: renderSkillInstructions(skills), applied: skills, missing, available: toSummaries(discovered) };
}

/** The run's notice: which skills it is under, and which it could not find. */
export function cloudSkillsNotice(skills: Pick<CloudSkills, "applied" | "missing">): string | null {
  const parts: string[] = [];
  if (skills.applied.length) {
    const names = skills.applied.map((s) => s.title ?? s.name).join(", ");
    parts.push(`Running with ${skills.applied.length === 1 ? "the skill" : "skills"} ${names}.`);
  }
  if (skills.missing.length) {
    parts.push(`Not found in this repository or your library: ${skills.missing.join(", ")}.`);
  }
  return parts.length ? parts.join(" ") : null;
}
