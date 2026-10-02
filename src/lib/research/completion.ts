/**
 * A finished web run becomes one assistant message in its conversation: a
 * cited summary and the report as an artifact, written in one transaction
 * with the run's `assistantMessageId` (SPEC §9.6.3, INV-14).
 *
 * WS0 lands the signatures; WS7 implements them.
 */

import type { ClientSource } from "@/types/chat";
import type { RunFact } from "@/types/run";

export interface ResearchCompletionInput {
  runId: string;
  userId: string;
  /** Null, or a deleted conversation: the run completes and no message is written. */
  conversationId: string | null;
  title: string;
  /** 120–250 words, cited with [n] against `sources`. */
  summary: string;
  /** The report Markdown, without a model-written sources section. */
  report: string;
  /** Cited first, in citation order, then read-not-cited; each with `origin: "research"`. */
  sources: ClientSource[];
  /** Model id of the lead that wrote both. */
  leadModel: string;
  fact: Extract<RunFact, { key: "research" }>;
}

export async function finalizeResearchRun(_input: ResearchCompletionInput): Promise<{ messageId: string | null }> {
  throw new Error("not implemented: WS7");
}

/** The regenerate/edit guard: true when a run's `assistantMessageId` is this message. */
export async function isResearchCompletionMessage(_messageId: string): Promise<boolean> {
  throw new Error("not implemented: WS7");
}
