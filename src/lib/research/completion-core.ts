/**
 * The pure half of a web run's completion (SPEC §9.6.3, INV-14).
 *
 * A finished run becomes exactly one assistant message in its conversation: a
 * cited summary, then the whole report as a `research-report-{runId}`
 * artifact. The message, its artifact row, the conversation's
 * `lastMessageAt`, `ResearchRun.assistantMessageId` and the run's terminal
 * state land in one transaction — a message whose run still says "writing",
 * or a run that points at a message that never landed, are both states a
 * reader would see.
 *
 * Everything that decides WHAT is written lives here and takes its database
 * as a port, so `tests/research-completion.test.ts` drives it through a fake
 * transaction. `completion.ts` binds the port to Prisma.
 */

import type { ParsedArtifact } from "@/lib/message-content";
import { bottomLineOf, citationOrder, renumberCitations, stripModelSources } from "@/lib/research/report-structure";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";
import type { RunFact } from "@/types/run";

export type ResearchFact = Extract<RunFact, { key: "research" }>;

/** The legacy title of the completion message's one activity row (native reads titles). */
export const RESEARCH_COMPLETION_ACTIVITY_TITLE = "Research report";

export function researchReportIdentifier(runId: string): string {
  return `research-report-${runId}`;
}

/**
 * Neutralises Juno's own tags inside model text. A report that contained a
 * literal `</juno:artifact>` would close the artifact early and spill the rest
 * of itself into the message as prose; `&lt;` renders as `<` in Markdown.
 */
function neutraliseTags(text: string): string {
  return text.replace(/<(\/?)juno:/gi, "&lt;$1juno:");
}

/** A title safe inside the artifact tag's double-quoted attribute. */
function attributeTitle(title: string): string {
  return title.replace(/["<>]/g, "'").replace(/\s+/g, " ").trim().slice(0, 200) || "Research report";
}

/** `content` of the completion message: the summary, then the report as an artifact. */
export function completionContent(input: { runId: string; title: string; summary: string; report: string }): string {
  const summary = neutraliseTags(input.summary.trim());
  const report = neutraliseTags(input.report.trim());
  const artifact = `<juno:artifact identifier="${researchReportIdentifier(input.runId)}" type="MARKDOWN" title="${attributeTitle(input.title)}" language="md">\n${report}\n</juno:artifact>`;
  return summary ? `${summary}\n\n${artifact}` : artifact;
}

/** The artifact the message carries, as `persistArtifacts` takes it. */
export function reportArtifact(input: { runId: string; title: string; report: string }): ParsedArtifact {
  return {
    identifier: researchReportIdentifier(input.runId),
    type: "MARKDOWN",
    title: attributeTitle(input.title),
    language: "md",
    content: neutraliseTags(input.report.trim()),
  };
}

/** The message's one activity row: the research fact on `kind: "context"` (SPEC §9.6.3). */
export function completionActivity(fact: ResearchFact, now: Date, id: string): ClientActivityEvent[] {
  return [
    {
      id,
      kind: "context",
      title: RESEARCH_COMPLETION_ACTIVITY_TITLE,
      createdAt: now.toISOString(),
      seq: 1,
      fact,
    },
  ];
}

export interface CorpusSource {
  id: string;
  title: string;
  url: string;
  /** The stored snapshot, for a one-line snippet. */
  snapshot?: string | null;
}

export interface OrderedCompletionSources {
  /** Cited first, in order of first citation, then read and not cited. */
  sources: ClientSource[];
  /** The source row ids in the same order: what `[n]` means on this message. */
  sourceOrder: string[];
  /** Old corpus number → the message's number, for the texts. */
  mapping: Map<number, number>;
  summary: string;
  report: string;
  cited: number;
}

const SNIPPET_CHARS = 300;

/**
 * Renumbers the summary and the report so `[1]` is the first source cited,
 * and orders the message's sources to match (cited, then read-not-cited).
 *
 * The writer numbers against the corpus — `citableSources`, the list the
 * citation audit also numbers against — and the message's sources resolve
 * `[n]` positionally, so a message whose first citation is `[7]` would point
 * `[7]` at whatever sits seventh. A marker outside the corpus is left as
 * written; the audit has already named it.
 */
export function orderCompletionSources(input: {
  corpus: readonly CorpusSource[];
  summary: string;
  report: string;
}): OrderedCompletionSources {
  const count = input.corpus.length;
  const order = citationOrder([input.summary, input.report]).filter((n) => n >= 1 && n <= count);
  const mapping = new Map<number, number>();
  order.forEach((n, i) => mapping.set(n, i + 1));
  const citedRows = order.map((n) => input.corpus[n - 1]);
  const citedIds = new Set(citedRows.map((row) => row.id));
  const rest = input.corpus.filter((row) => !citedIds.has(row.id));
  const toClient = (row: CorpusSource, cited: boolean): ClientSource => ({
    title: row.title.replace(/\s+/g, " ").trim() || row.url,
    url: row.url,
    snippet: (row.snapshot ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
    cited,
    origin: "research",
  });
  return {
    sources: [...citedRows.map((row) => toClient(row, true)), ...rest.map((row) => toClient(row, false))],
    sourceOrder: [...citedRows, ...rest].map((row) => row.id),
    mapping,
    summary: renumberCitations(input.summary, mapping),
    report: renumberCitations(input.report, mapping),
    cited: citedRows.length,
  };
}

const SUMMARY_MIN_WORDS = 40;
const SUMMARY_MAX_WORDS = 300;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * The summary the message opens with: the writer's own when it wrote one of
 * a reasonable length, else the report's bottom line — never nothing, since a
 * message that is only a report card reads as an empty answer in every
 * client that does not render artifacts inline (native, share pages).
 */
export function completionSummary(summary: string, bottomLine: string): string {
  const own = summary.trim();
  const pick = words(own).length >= SUMMARY_MIN_WORDS ? own : bottomLine.trim() || own;
  const list = words(pick);
  if (list.length <= SUMMARY_MAX_WORDS) return pick;
  // Cut at a sentence end inside the limit when there is one.
  const cut = list.slice(0, SUMMARY_MAX_WORDS).join(" ");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("] "));
  return end > cut.length / 2 ? cut.slice(0, end + 1).trim() : `${cut}…`;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** The database, as the completion needs it: every call is inside one transaction. */
export interface CompletionTx {
  /** The run's current completion message, if one was already written (a resumed finalize). */
  runMessage(runId: string, userId: string): Promise<string | null>;
  /** False when the conversation was deleted (or is not this user's). */
  conversationExists(conversationId: string, userId: string): Promise<boolean>;
  createAssistantMessage(data: {
    conversationId: string;
    content: string;
    model: string;
    sources: ClientSource[];
    activity: ClientActivityEvent[];
    createdAt: Date;
  }): Promise<{ id: string }>;
  persistArtifacts(conversationId: string, messageId: string, parsed: ParsedArtifact[]): Promise<unknown>;
  touchConversation(conversationId: string, at: Date): Promise<void>;
  /**
   * Points the run at its message and moves it to its terminal state, only
   * while it is still in `from`. False when something else moved it first —
   * a cancel landing on the last step — and then nothing of this write stays.
   */
  finishRun(input: {
    runId: string;
    userId: string;
    from: readonly string[];
    to: "completed" | "partially_completed";
    messageId: string | null;
    report: string;
    error: string | null;
    at: Date;
  }): Promise<boolean>;
}

export interface CompletionPorts {
  transaction<T>(fn: (tx: CompletionTx) => Promise<T>): Promise<T>;
  /** `encryptMessageText`: the content is stored like every other message's. */
  encrypt(text: string): string;
  now(): Date;
  newId(): string;
}

export interface CompletionWrite {
  runId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  summary: string;
  report: string;
  sources: ClientSource[];
  leadModel: string;
  fact: ResearchFact;
  /** The terminal state and what the run row records beside it. */
  to: "completed" | "partially_completed";
  from: readonly string[];
  /** The run's own copy of the report (corpus-numbered, for the audit). */
  runReport: string;
  error: string | null;
}

/** Thrown inside the transaction to roll it back when the run moved underneath the write. */
export class CompletionRacedError extends Error {
  constructor() {
    super("The research run changed state before its completion was written.");
    this.name = "CompletionRacedError";
  }
}

/**
 * Writes the completion: one message, its artifact, `lastMessageAt`, the
 * run's pointer and its terminal state, in one transaction.
 *
 * A deleted conversation writes no message and the run still completes. A
 * run that already points at a message (a finalize resumed after a crash
 * between the commit and the events) is not written twice. A run that some
 * other path finished first rolls the whole write back and reports `raced`.
 */
export async function writeResearchCompletion(
  input: CompletionWrite,
  ports: CompletionPorts
): Promise<{ messageId: string | null; raced: boolean; existing: boolean }> {
  try {
    return await ports.transaction(async (tx) => {
      const existing = await tx.runMessage(input.runId, input.userId);
      if (existing) return { messageId: existing, raced: false, existing: true };
      const at = ports.now();
      let messageId: string | null = null;
      if (input.conversationId && (await tx.conversationExists(input.conversationId, input.userId))) {
        const content = completionContent({ runId: input.runId, title: input.title, summary: input.summary, report: input.report });
        const message = await tx.createAssistantMessage({
          conversationId: input.conversationId,
          content: ports.encrypt(content),
          model: input.leadModel,
          sources: input.sources,
          activity: completionActivity(input.fact, at, ports.newId()),
          createdAt: at,
        });
        messageId = message.id;
        await tx.persistArtifacts(input.conversationId, message.id, [
          reportArtifact({ runId: input.runId, title: input.title, report: input.report }),
        ]);
        await tx.touchConversation(input.conversationId, at);
      }
      const moved = await tx.finishRun({
        runId: input.runId,
        userId: input.userId,
        from: input.from,
        to: input.to,
        messageId,
        report: input.runReport,
        error: input.error,
        at,
      });
      if (!moved) throw new CompletionRacedError();
      return { messageId, raced: false, existing: false };
    });
  } catch (error) {
    if (error instanceof CompletionRacedError) return { messageId: null, raced: true, existing: false };
    throw error;
  }
}

/**
 * The regenerate/edit guard's predicate (§9.6.3): a message that some run's
 * `assistantMessageId` points at is a research completion, which cannot be
 * regenerated or edited over — the regenerate path would delete its report
 * artifact and leave the run pointing at a chat answer.
 */
export function isCompletionMessage(
  runs: ReadonlyArray<{ assistantMessageId: string | null }>,
  messageId: string
): boolean {
  return !!messageId && runs.some((run) => run.assistantMessageId === messageId);
}

/**
 * Everything the completion writes, from what the run holds at the end: the
 * report (corpus-numbered, as the audit checked it), the writer's summary,
 * and the corpus the writer numbered against. `sourceOrder` is what `[n]`
 * means on the message, for the `run_completed` event the citations loader
 * reads (SPEC §9.4, the loader fallback).
 */
export function buildCompletionWrite(input: {
  runId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  summary: string;
  report: string;
  corpus: readonly CorpusSource[];
  to: "completed" | "partially_completed";
  from?: readonly string[];
  error: string | null;
  leadModel: string;
  workedMs: number;
  pages: number;
}): { write: CompletionWrite; sourceOrder: string[] } {
  // The reader renders sources from rows, cited then read; a list the model
  // wrote itself is stripped (research-UI bug 7). The run keeps its report as
  // the audit checked it.
  const report = stripModelSources(input.report);
  const summary = completionSummary(input.summary, bottomLineOf(report));
  const ordered = orderCompletionSources({ corpus: input.corpus, summary, report });
  const title = input.title.trim() || "Research report";
  return {
    write: {
      runId: input.runId,
      userId: input.userId,
      conversationId: input.conversationId,
      title,
      summary: ordered.summary,
      report: ordered.report,
      sources: ordered.sources,
      leadModel: input.leadModel,
      fact: {
        key: "research",
        runId: input.runId,
        title,
        workedMs: Math.max(0, Math.round(input.workedMs)),
        cited: ordered.cited,
        read: input.corpus.length,
        pages: Math.max(0, Math.round(input.pages)),
        leadModel: input.leadModel,
        state: input.to,
      },
      to: input.to,
      from: input.from ?? ["validating_citations"],
      runReport: input.report,
      error: input.error,
    },
    sourceOrder: ordered.sourceOrder,
  };
}
