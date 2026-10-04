import "server-only";
import { recordSpend } from "@/lib/spend";
import type { buildUsage } from "@/lib/chat-usage";
import type { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import type { legacyChatClientForOrigin } from "@/lib/chat-origin";

/*
 * Pipeline — the one spend-ledger write a turn makes.
 *
 * The route wrote this record four times (private complete, private partial,
 * saved complete, saved partial), field for field, and the copies differed
 * only in which usage and which completion-character count they carried. One
 * builder now; the call sites pass those two facts.
 *
 * `recordSpend` also settles this turn's reservation (`reserveSpend`), so it
 * is the write that closes the hold. It is never retried here: a failed write
 * leaves the hold for `releaseSpend` in the turn's `finally`, and the hourly
 * sweep is the backstop.
 */
export function recordTurnSpend(input: {
  userId: string;
  modelId: string;
  source: ReturnType<typeof legacyChatClientForOrigin>;
  generationId: string;
  usage: ReturnType<typeof buildUsage>;
  acc: GenerationAccumulator;
  promptChars: number;
  completionChars: number;
}): Promise<boolean> {
  const { acc, usage } = input;
  return recordSpend({
    userId: input.userId,
    model: input.modelId,
    kind: "chat",
    source: input.source,
    ref: input.generationId,
    promptTokens: usage.totalInput || undefined,
    completionTokens: usage.output || undefined,
    reasoningTokens: acc.tokens.reasoningTokens || undefined,
    totalTokens: acc.tokens.totalTokens || undefined,
    cacheRead: acc.tokens.cacheReadTokens,
    cacheWrite: acc.tokens.cacheWriteTokens,
    cacheWrite5m: acc.tokens.cacheWrite5mTokens,
    cacheWrite1h: acc.tokens.cacheWrite1hTokens,
    webSearchRequests: acc.tokens.webSearchRequests,
    xSearchRequests: acc.tokens.xSearchRequests,
    costUsd: usage.cost || undefined,
    promptChars: input.promptChars,
    completionChars: input.completionChars,
    reasoningChars: acc.reasoning.length,
    fastMode: acc.servedFast,
  });
}
