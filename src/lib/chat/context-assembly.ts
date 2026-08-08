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
 * One retrieved passage, as the prompt needs it.
 *
 * Structurally a subset of `ScoredPassage` from lib/knowledge/rank rather than
 * an import of it, so this module stays free of `server-only` and Prisma. The
 * fields that are here are the ones a citation cannot do without: which
 * document, which blocks, and where in the document the text physically is.
 */
export interface RetrievedPassage {
  documentId: string;
  fileName: string;
  /** "page 4", "Sheet2!B7", "slide 3". May be empty for a formatless source. */
  locator: string;
  blockIds: readonly string[];
  text: string;
}

export interface ProjectKnowledge {
  passages: readonly RetrievedPassage[];
  /**
   * Files the index covers. Their wholesale text is dropped from the prompt in
   * favour of the retrieved extracts — otherwise the same document appears
   * twice, once entire and once in extract, and retrieval has bought nothing.
   */
  indexedFileNames: readonly string[];
  /**
   * Set when the semantic half of retrieval could not run — no embedding
   * provider the account's policy permits, or a corpus that has not been
   * embedded. The passages below are then lexical matches only, and the model
   * is told so rather than left to over-trust them.
   */
  degraded?: boolean;
}

/** Marker the model is asked to reuse, so a claim can be traced to a page. */
function citation(passage: RetrievedPassage): string {
  return passage.locator ? `${passage.fileName} · ${passage.locator}` : passage.fileName;
}

/**
 * The project's instructions and reference files, as one system-prompt section.
 *
 * Files with no extracted text are omitted entirely rather than contributing an
 * empty heading — a heading with nothing under it reads to the model as a file
 * that exists and is blank.
 *
 * `knowledge` is the retrieval-backed half, and it is deliberately additive:
 * omit it and this function behaves exactly as it did before retrieval existed,
 * which is what a project with nothing indexed must keep getting. When it is
 * present, indexed files stop being dumped whole and appear as located extracts
 * instead — the difference between a prompt that grows with the library and one
 * that grows with the question.
 */
export function buildProjectContext(
  project: ProjectContextSource | null,
  knowledge?: ProjectKnowledge | null
): string {
  if (!project) return "";
  const sections = [`# Project: ${project.name}`];
  if (project.instructions.trim()) {
    sections.push(`## Project instructions\n${project.instructions.trim()}`);
  }

  const indexed = new Set(knowledge?.indexedFileNames ?? []);
  const fileTexts = project.files.filter(
    (file) => file.extractedText?.trim() && !indexed.has(file.fileName)
  );
  if (fileTexts.length) {
    sections.push("## Project reference files");
    for (const file of fileTexts) sections.push(`### ${file.fileName}\n${file.extractedText!}`);
  }

  const passages = knowledge?.passages ?? [];
  if (passages.length) {
    sections.push(
      knowledge?.degraded
        ? "## Retrieved from project documents\nKeyword matches only — the semantic index is unavailable, so relevant passages may be missing. Say so if the extracts do not answer the question."
        : "## Retrieved from project documents\nExtracts selected for this question. Cite the source in parentheses when you use one, exactly as it is labelled."
    );
    for (const passage of passages) {
      sections.push(`### ${citation(passage)}\n${passage.text.trim()}`);
    }
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
 *
 * `documentPassages` is optional so a caller that has not been taught about
 * retrieval produces the same line it always did.
 */
export function contextActivityDetail(input: {
  messages: number;
  attachments: number;
  memories: number;
  hasProjectContext: boolean;
  documentPassages?: number;
}): string {
  const parts = [plural(input.messages, "message")];
  if (input.attachments) parts.push(plural(input.attachments, "attachment"));
  if (input.memories) parts.push(plural(input.memories, "memory", "memories"));
  if (input.documentPassages) parts.push(plural(input.documentPassages, "document passage"));
  if (input.hasProjectContext) parts.push("project context");
  return parts.join(" · ");
}

/** Total characters of history sent to the model — the floor on prompt size. */
export function promptChars(system: string, history: readonly { content: string }[]): number {
  return system.length + history.reduce((sum, message) => sum + message.content.length, 0);
}
