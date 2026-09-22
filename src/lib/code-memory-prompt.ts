/*
 * WHAT A CODE RUN IS TOLD FROM MEMORY — AND, MORE TO THE POINT, WHAT IT IS NOT.
 *
 * A Juno Code run reaches its agent as one stored string (see
 * code-attachment-prompt.ts), and that string does not stay on Juno's servers:
 * it is written to the CodeTask row, handed to the host that runs it, and on a
 * cloud run that host is a GitHub Actions runner in the user's own repository.
 * So the question here is not "what would help" — all of memory might — but
 * "what is it reasonable to send to a CI machine", and the answer is narrow.
 *
 * Three categories: how the user works (`workflows` — "uses pnpm", "deploys
 * with Fly"), how they like things done (`preferences` — "prefers small
 * commits", "wants tests with every change") and what they are building
 * (`projects`). Never identity, the people in their life, their goals or their
 * studies, and never a fact that falls under a sensitive subject whatever its
 * category — a preference can still say something about someone's health.
 * Never project-scoped facts either: a Code run is not filed in a Juno project,
 * and a fact kept for one project must not reach an unrelated repository.
 *
 * Pure, for the reason its sibling gives: the database read stays at the call
 * site, and a test can pin exactly what the agent receives.
 */

import { isExpired, selectMemoriesForContext, type LifecycleEntry } from "@/lib/memory-lifecycle";
import { sensitiveTopicOf } from "@/lib/memory-sensitive";

export const CODING_MEMORY_CATEGORIES = ["workflows", "preferences", "projects"] as const;

/** Small on purpose: this rides every turn of a run, replayed into context. */
export const CODING_MEMORY_BUDGET_TOKENS = 250;
export const CODING_MEMORY_LIMIT = 8;

/**
 * The facts a Code run may be shown, ranked against the task.
 *
 * The filter is applied here even though the loader narrows its query the same
 * way, because this is the function a test can reach — and the boundary that
 * keeps a diagnosis out of a CI log should be provable, not merely likely.
 */
export function selectCodingMemories(
  entries: readonly LifecycleEntry[],
  opts: { query: string; now?: Date }
): { id: string; content: string }[] {
  const now = opts.now ?? new Date();
  const allowed = new Set<string>(CODING_MEMORY_CATEGORIES);
  const eligible = entries.filter(
    (entry) =>
      entry.kind === "FACT" &&
      entry.status === "active" &&
      entry.projectId === null &&
      entry.category !== null &&
      allowed.has(entry.category) &&
      !isExpired(entry, now) &&
      sensitiveTopicOf(entry.content) === null
  );
  const { selected } = selectMemoriesForContext(eligible, {
    query: opts.query,
    projectId: null,
    now,
    budgetTokens: CODING_MEMORY_BUDGET_TOKENS,
    limit: CODING_MEMORY_LIMIT,
  });
  return selected.map((memory) => ({ id: memory.id, content: memory.content }));
}

/**
 * Append the remembered facts to an agent prompt, after everything else.
 *
 * Last, under its own separator, and framed as background the task outranks:
 * the task is what to do, attachments are what it is about, and this is how
 * the user tends to like it done. An empty prompt is returned untouched — a
 * profile is never a task on its own.
 */
export function foldMemoryIntoPrompt(prompt: string, facts: readonly string[]): string {
  const lines = facts.map((fact) => fact.trim()).filter(Boolean);
  if (!prompt.trim() || lines.length === 0) return prompt;
  return `${prompt}\n\n---\nBackground from what Juno remembers about how this user works. It is context, not part of the task — where it and the task disagree, the task wins:\n${lines
    .map((line) => `- ${line}`)
    .join("\n")}`;
}
