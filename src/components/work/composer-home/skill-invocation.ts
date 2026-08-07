import type { ClientWorkSkill } from "@/lib/work/skills";
import { parseSkillInvocation } from "@/lib/work/skills";

/*
 * Naming a skill from the composer, without inventing a field to carry it.
 *
 * A Work session has no `skillId`. The only way a person picks the skill a task
 * runs under is the one `applySkill` in scripts/work-runner.ts reads: a leading
 * `/slug` on the goal itself, parsed by `parseSkillInvocation`, which is
 * imported here rather than re-derived so the composer and the runner cannot
 * disagree about what counts as an invocation. Adding a wire field instead
 * would have meant a second answer to "which skill is this" — and the goal
 * would still have won, because that is what the runner reads.
 *
 * So the menu writes into the textarea, exactly as the pre-flight card does and
 * for the same reason its own header gives: `WorkSession.goal` is documented as
 * verbatim and is what the plan is checked against, so the only honest way to
 * add to it is where the reader can watch it appear and take it back out.
 */

/**
 * The skill a goal names, or null.
 *
 * Checked against the account's own library rather than trusted from the
 * pattern, and that check is the whole point of this function existing. A goal
 * beginning `/tmp is full of junk` parses as an invocation of a skill called
 * `tmp` — the slug pattern cannot tell a skill name from any other lowercase
 * word after a slash — and treating it as one would mean the menu showed a
 * skill as selected that does not exist, and then *replaced* the reader's first
 * three characters when they picked a real one. Matching against the library
 * first means an unrecognised leading token is left alone, and a skill picked
 * over it is prepended rather than swapped in.
 */
export function invokedSkill(
  goal: string,
  skills: readonly ClientWorkSkill[] | null
): ClientWorkSkill | null {
  const invocation = parseSkillInvocation(goal);
  if (invocation === null || skills === null) return null;
  return skills.find((skill) => skill.slug === invocation.slug) ?? null;
}

/**
 * The goal with `slug` named at the front, or with the current name taken off.
 *
 * `existing` is the recognised invocation from `invokedSkill` — not whatever
 * `parseSkillInvocation` found — so that only text the reader put there by
 * picking a skill is ever removed. Pass null and the slug is prepended, which
 * leaves an unrecognised `/something` where the reader typed it.
 *
 * A trailing space follows the slug even on an empty goal, so the caret lands
 * where the sentence goes rather than against the name.
 */
export function applySkillInvocation(
  goal: string,
  slug: string | null,
  existing: ClientWorkSkill | null
): string {
  const body = existing === null ? goal.trimStart() : (parseSkillInvocation(goal)?.remainder ?? "");
  if (slug === null) return body;
  return body.length === 0 ? `/${slug} ` : `/${slug} ${body}`;
}
