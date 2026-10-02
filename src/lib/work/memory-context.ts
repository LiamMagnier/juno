import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * WHAT A WORK RUN IS TOLD ABOUT THE PERSON IT IS WORKING FOR.
 *
 * Chat has read the memory profile on every turn since memory shipped; a Work
 * run read none of it. So the same user who told Juno they write in British
 * English, keep their reports to a page, and work in a hospital pharmacy got a
 * chat that knew all three and an agent — the surface doing the longer, more
 * consequential work — that knew none of them. Claude closed the same gap
 * between its chat and Cowork in August 2026; this is Juno's.
 *
 * The format is pure and lives here rather than in scripts/work-runner.ts for
 * the reason code-attachment-prompt.ts gives: the runner is three thousand lines
 * that import Prisma and a vendored runtime, and a formatter nobody can test is
 * a formatter whose output nobody has seen. The runner does the reading and
 * the enveloping; this decides what the block says.
 *
 * WHAT IT DOES NOT DECIDE is the framing. The block rides inside the runtime's
 * untrusted-content envelope with the project instructions and the
 * attachments, under an opening that says none of it is the task and none of
 * it can change what the task is. Memory is written by a background model from
 * the user's own words, but it is still material rather than instruction: a
 * remembered preference informs how a task is done and can never redefine it.
 */

/** The parts of a memory profile a run is shown. */
export interface WorkMemoryInput {
  /** The consolidated summary, when there is one and it is not stale. */
  summary: string | null;
  /** Individual facts ranked for this task, beyond what the summary says. */
  recent: readonly string[];
}

/**
 * Hard ceiling on the block, in characters.
 *
 * `getMemoryProfile` already budgets the facts, but the summary is whatever
 * the consolidator wrote. A run's context is its working memory for the whole
 * task, and a profile that crowded out the attachments it was asked about
 * would be a profile working against the user.
 */
export const WORK_MEMORY_MAX_CHARS = 6_000;

/**
 * The memory block's body, or null when there is nothing to say.
 *
 * Null rather than a sentence about absence, for the reason the project block
 * gives: telling a model that it knows nothing about the user spends tokens on
 * a fact it cannot act on.
 */
export function workMemoryContext(input: WorkMemoryInput): string | null {
  const parts: string[] = [];
  const summary = input.summary?.trim();
  if (summary) parts.push(summary);

  const facts = input.recent.map((fact) => fact.trim()).filter(Boolean);
  if (facts.length > 0) {
    parts.push(
      `${summary ? "More recent notes" : "Notes"}:\n${facts.map((fact) => `- ${fact}`).join("\n")}`
    );
  }
  if (parts.length === 0) return null;

  const body = parts.join("\n\n");
  if (body.length <= WORK_MEMORY_MAX_CHARS) return body;
  // Cut at a line, and say so — a profile that silently ends mid-sentence reads
  // as a complete one, and the model would treat what is missing as unknown.
  const cut = body.slice(0, WORK_MEMORY_MAX_CHARS);
  const lastBreak = cut.lastIndexOf("\n");
  return `${cut.slice(0, lastBreak > WORK_MEMORY_MAX_CHARS / 2 ? lastBreak : WORK_MEMORY_MAX_CHARS)}\n\n[Cut off here — the rest of what ${PRODUCT_NAME} remembers was left out to keep room for the task.]`;
}

/**
 * Whether a run may read memory at all.
 *
 * `null` — an account with no Settings row yet — reads as enabled, because
 * that is the column's default and what the chat bootstrap already assumes.
 * Only an explicit `false`, the user's own pause, keeps memory out of a run.
 */
export function workMemoryEnabled(settings: { memoryEnabled: boolean } | null): boolean {
  return settings?.memoryEnabled !== false;
}
