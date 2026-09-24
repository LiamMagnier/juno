/*
 * Model-facing text for "Keep researching" (SPEC §9.7). English, and in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29, §10.5):
 * the new run's goal is read by the planner, not by the person.
 */

/** Between the previous run's goal and what the reader wants looked into next. */
export const KEEP_RESEARCHING_JOINER = "\n\nGo further on: ";

/** `startResearchSchema.goal`'s ceiling. */
export const MAX_GOAL_CHARS = 4_000;

/**
 * The goal of a follow-up run: the old goal, then the reader's words. The old
 * goal gives way when the two would pass the ceiling; the new words never do.
 */
export function keepResearchingGoal(previousGoal: string, next: string): string {
  const tail = `${KEEP_RESEARCHING_JOINER}${next.trim()}`.slice(0, MAX_GOAL_CHARS);
  const head = previousGoal.trim().slice(0, Math.max(0, MAX_GOAL_CHARS - tail.length));
  return `${head}${tail}`;
}
