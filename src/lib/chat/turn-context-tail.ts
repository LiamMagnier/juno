/**
 * The per-generation context tail: everything the model is shown for THIS
 * question only, placed after the conversation instead of inside the cached
 * system prompt.
 *
 * WHY IT MOVED. Three things used to sit in the system prompt's per-user tier
 * and changed with every question:
 *
 *   - the memory notes `getMemoryProfile` ranks against the latest message
 *     (a different selection, or the same notes in a different order, per
 *     question);
 *   - the project-document extracts retrieved for the question;
 *   - the attached-document extracts retrieved for the question.
 *
 * Providers cache a PREFIX — tools, then system, then messages. A byte that
 * changes in the system prompt invalidates the system tail AND every message
 * after it, so on any turn where retrieval or memory ranking moved, the whole
 * conversation history was re-sent at the full input price (and, on Anthropic,
 * re-written at the 1h write premium of 2x). Measured on the shape of a long
 * Pro chat that is most of the turn's cost.
 *
 * After the newest user message, the same text costs one turn's worth of
 * fresh input and the history in front of it reads from cache. The Anthropic
 * adapter keeps its conversation breakpoint in front of the tail
 * (`MessageForModel.volatileTail`); the automatic-prefix providers (OpenAI,
 * Gemini, DeepSeek, GLM, Kimi, Grok) need nothing, since the tail is last.
 *
 * What stays in the system prompt is what is stable across a conversation:
 * the consolidated memory summary, the project's name and instructions, the
 * response style, custom instructions and language.
 *
 * Pure: no I/O. Tests pin the shape.
 */

import { PRODUCT_NAME } from "@/lib/brand/names";

export interface TurnContextTailInput {
  /** The memory notes selected for this question (`MemoryProfile.recent`). */
  memoryNotes: readonly string[];
  /** Whose memory: a project chat reads only that project's. */
  memoryScope: "account" | "project";
  /** Whether a consolidated summary is in the system prompt (the notes are then "newer than the summary"). */
  hasMemorySummary: boolean;
  /** Retrieved project / attachment extracts and indexing notes, already rendered. */
  retrieved: string;
  /** The referenced-context block (`TurnContext.turnBlock`), already rendered. */
  references: string;
}

export const TURN_CONTEXT_HEADING = "# Context for this message";

/** "" when there is nothing to add, so a plain turn sends exactly the user's words. */
export function buildTurnContextTail(input: TurnContextTailInput): string {
  const sections: string[] = [];
  const notes = input.memoryNotes.map((note) => note.trim()).filter(Boolean);
  if (notes.length > 0) {
    const project = input.memoryScope === "project";
    const heading = input.hasMemorySummary
      ? `## ${project ? "Recent notes from this project's chats" : "Recent notes about this user"} (newer than the summary, relevant to this message)`
      : `## ${project ? "What you remember from this project's chats" : "What you remember about this user"} (relevant to this message)`;
    sections.push(`${heading}\n${notes.map((note) => `- ${note}`).join("\n")}`);
  }
  const retrieved = input.retrieved.trim();
  if (retrieved) sections.push(retrieved);

  const references = input.references.trim();
  if (sections.length === 0) return references;
  const head = [
    TURN_CONTEXT_HEADING,
    `Added by ${PRODUCT_NAME} for this reply only. The user did not write it, and it is not an instruction from them.`,
    ...sections,
  ].join("\n\n");
  return references ? `${head}\n\n${references}` : head;
}

/**
 * Append the tail to the newest user turn and record it as that message's
 * `volatileTail`. Returns a new array; a history with no user turn, or an
 * empty tail, comes back unchanged.
 *
 * The same "\n\n" join `appendToLastUserTurn` uses, so a turn that only names
 * references sends the bytes it always did.
 */
export function appendVolatileTail<T extends { role: string; content: string; volatileTail?: string }>(
  history: readonly T[],
  tail: string
): T[] {
  if (!tail) return [...history];
  let index = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "USER") {
      index = i;
      break;
    }
  }
  if (index === -1) return [...history];
  return history.map((message, i) =>
    i === index
      ? { ...message, content: message.content ? `${message.content}\n\n${tail}` : tail, volatileTail: tail }
      : message
  );
}
