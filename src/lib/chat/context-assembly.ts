/**
 * Stage: conversation and context assembly.
 *
 * Everything the model is shown, decided before a provider is called: how far
 * back the history window reaches, which turns the model sees instead of what
 * the user sees, the project's instructions and reference files, and the one
 * line of activity that tells the user what went in.
 *
 * All of it was inline in the 2,500-line route, where none of it could be
 * exercised without a request, a session and a database. It is pure here for
 * the same reason `chat-admission.ts` is: a rule you cannot test is a rule that
 * drifts.
 */
import type { MessageForModel } from "@/types/llm";

/** How many recent messages the model is shown. */
export const HISTORY_LIMIT = 24;

/**
 * When a conversation outgrows HISTORY_LIMIT, drop the oldest messages in
 * blocks of this size instead of one per turn.
 *
 * A per-turn sliding window changes the prompt prefix on every request, which
 * defeats provider-side implicit prompt caching (Zhipu/DeepSeek/Moonshot/OpenAI
 * all cache on stable prefixes). Chunked truncation keeps the prefix
 * byte-identical for HISTORY_STEP consecutive turns, at the cost of a slightly
 * larger window.
 */
export const HISTORY_STEP = 8;

/**
 * How many messages to skip so the window stays anchored to HISTORY_STEP
 * blocks. The window therefore holds between HISTORY_LIMIT and
 * HISTORY_LIMIT + HISTORY_STEP - 1 messages.
 */
export function historyWindowStart(
  totalMessages: number,
  limit: number = HISTORY_LIMIT,
  step: number = HISTORY_STEP
): number {
  if (totalMessages <= limit) return 0;
  return Math.floor((totalMessages - limit) / step) * step;
}

export interface PrivateHistoryEntry {
  role: "USER" | "ASSISTANT";
  content: string;
}

/**
 * Private mode's history is supplied by the client, never stored, and so is
 * normalised here rather than trusted: blank turns dropped, content trimmed,
 * and only the last `limit` kept.
 */
export function buildPrivateHistory(
  entries: readonly PrivateHistoryEntry[] | undefined,
  limit: number = HISTORY_LIMIT
): MessageForModel[] {
  return (entries ?? [])
    .filter((message) => message.content.trim())
    .slice(-limit)
    .map((message) => ({ role: message.role, content: message.content.trim(), attachments: [] }));
}

/**
 * Rewrites the most recent user turn.
 *
 * A clarification reply is shown to the user as the answers they picked and
 * given to the model as a directive built from them. In private mode there is
 * no stored message to diverge from, so the substitution happens on the way
 * past — and it must happen *before* moderation, so the policy screen sees the
 * exact turns the provider will receive.
 *
 * Returns a new array; the caller's input is untouched.
 */
export function replaceLastUserTurn(
  history: readonly MessageForModel[],
  content: string
): MessageForModel[] {
  const next = [...history];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role !== "USER") continue;
    next[i] = { ...next[i], content };
    break;
  }
  return next;
}

/**
 * Swaps one persisted message's content for the model-directed version.
 *
 * Same divergence as above, on the saved path: the Message row holds what the
 * user sees, and this turn — and only this turn — sends the model something
 * else. Nothing is written back, so a reload shows the visible text.
 */
export function applyHiddenUserContent<T extends { id: string; content: string }>(
  history: readonly T[],
  userMessageId: string | null,
  hiddenContent: string | null
): T[] {
  if (!hiddenContent || !userMessageId) return [...history];
  return history.map((message) =>
    message.id === userMessageId ? { ...message, content: hiddenContent } : message
  );
}

export interface ProjectContextSource {
  name: string;
  instructions: string;
  files: readonly { fileName: string; extractedText: string | null }[];
}

/**
 * The project's instructions and reference files, as one system-prompt section.
 *
 * Files with no extracted text are omitted entirely rather than contributing an
 * empty heading — a heading with nothing under it reads to the model as a file
 * that exists and is blank.
 */
export function buildProjectContext(project: ProjectContextSource | null): string {
  if (!project) return "";
  const sections = [`# Project: ${project.name}`];
  if (project.instructions.trim()) {
    sections.push(`## Project instructions\n${project.instructions.trim()}`);
  }
  const fileTexts = project.files.filter((file) => file.extractedText?.trim());
  if (fileTexts.length) {
    sections.push("## Project reference files");
    for (const file of fileTexts) sections.push(`### ${file.fileName}\n${file.extractedText!}`);
  }
  return sections.join("\n\n");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * "12 messages · 2 attachments · 3 memories · project context".
 *
 * The message count is always present even at zero; the rest appear only when
 * they contributed something, so the line never claims context that is not
 * there.
 */
export function contextActivityDetail(input: {
  messages: number;
  attachments: number;
  memories: number;
  hasProjectContext: boolean;
}): string {
  const parts = [plural(input.messages, "message")];
  if (input.attachments) parts.push(plural(input.attachments, "attachment"));
  if (input.memories) parts.push(plural(input.memories, "memory", "memories"));
  if (input.hasProjectContext) parts.push("project context");
  return parts.join(" · ");
}

/** Total characters of history sent to the model — the floor on prompt size. */
export function promptChars(system: string, history: readonly { content: string }[]): number {
  return system.length + history.reduce((sum, message) => sum + message.content.length, 0);
}
