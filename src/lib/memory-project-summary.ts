/*
 * THE PROJECT SUMMARY PROMPT — what a project's memory is distilled from, and
 * the rules the distilling model is held to.
 *
 * A chat filed in a project reads memory in isolation: that project's facts,
 * never the account's (getMemoryProfile). The account summary, the settled
 * overview every other chat opens with, was therefore never shown to a
 * project chat — and nothing replaced it, so a project had no overview of
 * itself, only whichever of its facts ranked into the token budget that turn.
 * Claude gives each project "its own separate memory space and dedicated
 * project summary"; this is Juno's.
 *
 * What goes in is deliberately narrower than the account summary's sources:
 *
 *   - FACTS learned in THIS project's chats — never an account-wide fact and
 *     never another project's. The isolation a project chat reads under has to
 *     hold for what its summary was written from, or the summary is the leak.
 *   - DIGESTS of this project's conversations, for the thread of the work.
 *   - The project's NAME, and the start of its instructions as context only:
 *     every chat in the project is shown the instructions in full already, and
 *     a summary that restated them would spend the budget twice.
 *   - SUPPRESSIONS — all of them. A "forget" is account-wide by design: asking
 *     Juno to forget where you work does not mean "except in Thesis".
 *
 * Pure — no Prisma, no model — so every one of those rules is a test.
 */

export interface ProjectSummarySources {
  projectName: string;
  /** The project's instructions; only the start is shown, as context. */
  instructions: string;
  /** Active, unexpired facts scoped to this project, oldest first. */
  facts: { content: string; createdAt: Date }[];
  /** One-line digests of this project's conversations, newest first. */
  digests: string[];
  /** Every statement the user asked to forget, account-wide. */
  suppressions: string[];
}

/** How much of the instructions the summariser sees — enough to know what the project is for. */
export const PROJECT_SUMMARY_INSTRUCTIONS_CHARS = 600;

/** Newest facts win the budget; the oldest are dropped first, as for the account. */
export const PROJECT_SUMMARY_FACT_CHARS = 30_000;

/** Nothing to distil: no facts and no chat has been digested. Instructions alone are not memory. */
export function projectSummaryIsEmpty(sources: Pick<ProjectSummarySources, "facts" | "digests">): boolean {
  return sources.facts.length === 0 && sources.digests.length === 0;
}

/** Keep the newest facts that fit, in their original (oldest-first) order. */
export function budgetProjectFacts(
  facts: readonly { content: string; createdAt: Date }[],
  maxChars: number = PROJECT_SUMMARY_FACT_CHARS
): { content: string; createdAt: Date }[] {
  const kept: { content: string; createdAt: Date }[] = [];
  let used = 0;
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i];
    if (used + fact.content.length > maxChars) break;
    kept.unshift(fact);
    used += fact.content.length;
  }
  return kept;
}

export function projectConsolidationPrompt(sources: ProjectSummarySources): { system: string; userMsg: string } {
  const system = `You maintain the memory of ONE project a user works on, used to give future chats in that project their bearings. Distill the extracted memory below into a clean, deduplicated, well-organized summary in Markdown.

HARD RULE — SUPPRESSED CONTENT: the user explicitly asked to forget the statements listed under "SUPPRESSED". They must NOT appear in the summary in any form, direct or paraphrased. This outranks every other source.

Sources:
1. FACTS — durable facts learned in this project's chats (oldest to newest, with dates; most recent wins on contradictions).
2. CHAT DIGESTS — one-line topics of this project's conversations (for the thread of the work, not facts).
3. PROJECT — its name, and the start of its instructions for context only. Every chat in the project already sees the instructions in full: never restate them.

Rules:
- Group content under "## " section headings, and INCLUDE A SECTION ONLY IF IT HAS CONTENT. Prefer these, in this order: Purpose & context, Decisions & conventions, Current state, Open threads.
- Write in the third person as concise prose (a short paragraph per section) — synthesize, don't list.
- Use only what these sources say about this project. Add nothing from outside them — no general knowledge about the user, no guesses.
- Keep only durable, non-sensitive information. Never include secrets, passwords, or API keys.
- Output ONLY the Markdown summary — no preamble, no closing remarks.`;

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const block = (title: string, lines: string[]) =>
    lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
  const instructions = sources.instructions.replace(/\s+/g, " ").trim();
  const excerpt =
    instructions.length > PROJECT_SUMMARY_INSTRUCTIONS_CHARS
      ? `${instructions.slice(0, PROJECT_SUMMARY_INSTRUCTIONS_CHARS - 1).trimEnd()}…`
      : instructions;
  const userMsg = [
    block("SUPPRESSED (never include any of this)", sources.suppressions),
    `PROJECT: ${sources.projectName}${excerpt ? `\nInstructions (context only — do not restate): ${excerpt}` : ""}`,
    block("FACTS (oldest to newest)", sources.facts.map((f) => `[${day(f.createdAt)}] ${f.content}`)),
    block("CHAT DIGESTS", sources.digests),
    "Write the consolidated Markdown memory summary for this project.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, userMsg };
}
