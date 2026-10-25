import type { FastMode } from "@/lib/pricing";
import { estimateGenerationCostUsd, normalizeUsage } from "@/lib/pricing";
import { formatUsd } from "@/lib/utils";
import type { ModelInfo } from "@/lib/models";

/**
 * Token accounting for one generation, split out of the chat route so the money
 * arithmetic can be tested. It is completely pure — no request scope, no I/O —
 * which is why it was the first thing worth lifting out of a 2,600-line file.
 *
 * `src/app/api/chat/route.ts` cannot be imported by a test: it pulls in Prisma
 * and the Next server runtime. Anything that stays inside it is, in practice,
 * untestable.
 */

export interface RawGenerationUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearchRequests?: number;
  xSearchRequests?: number;
  promptChars?: number;
  /**
   * Characters the MODEL emitted, which is not always what ends up on the
   * message: a canvas edit rewrites the assistant text into the whole rebuilt
   * artifact. This value floors the cost estimate (see pricing.ts — `charOut >
   * completion` wins), so passing the rebuilt text here inflates the receipt.
   */
  completionChars?: number;
  reasoningChars?: number;
}

export interface GenerationUsage {
  /** "12,000 input (3,000 cached) · 800 output · $0.0123" */
  detail: string;
  cost: number;
  costMicroUsd: number;
  totalInput: number;
  /**
   * The prompt count in the provider's own convention (Anthropic: fresh input
   * only; OpenAI-style: cache included), which is what `recordSpend` re-prices
   * alongside the cache fields. For Anthropic, `totalInput` adds the cache,
   * so a ledger write that passed it billed every cached token twice: once at the
   * full input rate and again at its cache rate (a cached Sonnet turn
   * recorded at ~6x its real cost).
   */
  billedPromptTokens: number;
  output: number;
  reasoning: number;
  toolFeesUsd: number;
  webSearchRequests: number;
  xSearchRequests: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  cacheWrite: number;
  /** Whether the billed counts are the provider's report or partly estimated (see `usageBasisOf`). */
  basis: UsageBasis;
}

/**
 * "reported": every billed count is a number the provider sent.
 * "estimated": `resolveBillableTokens` filled at least one in from characters.
 */
export type UsageBasis = "reported" | "estimated";

/**
 * Which of the two a billed figure is, by the same rules `resolveBillableTokens`
 * (pricing.ts) applies, so a receipt never calls a chars/4 guess a report:
 *  - nothing reported at all: both counts come from characters;
 *  - no prompt count but a billed prompt: the prompt came from characters (a
 *    fully cached Anthropic turn bills 0 fresh input and is not flagged);
 *  - a billed output above everything the provider reported for output
 *    (completion, reasoning, total minus prompt): the character floor won.
 */
export function usageBasisOf(
  raw: Pick<RawGenerationUsage, "input" | "output" | "reasoning" | "total" | "cacheRead" | "cacheWrite" | "cacheWrite5m" | "cacheWrite1h">,
  billed: { promptTokens: number; completionTokens: number }
): UsageBasis {
  const positive = (n: number | undefined) => Math.max(0, n ?? 0);
  const reportedAnything =
    positive(raw.input) > 0 ||
    positive(raw.output) > 0 ||
    positive(raw.total) > 0 ||
    positive(raw.reasoning) > 0 ||
    positive(raw.cacheRead) > 0 ||
    positive(raw.cacheWrite) + positive(raw.cacheWrite5m) + positive(raw.cacheWrite1h) > 0;
  if (!reportedAnything) return billed.promptTokens > 0 || billed.completionTokens > 0 ? "estimated" : "reported";
  if (raw.input == null && billed.promptTokens > 0) return "estimated";
  const total = positive(raw.total);
  const impliedOut = total > 0 && billed.promptTokens > 0 ? Math.max(0, total - billed.promptTokens) : 0;
  const reportedOut = Math.max(positive(raw.output), positive(raw.reasoning), impliedOut);
  return billed.completionTokens > reportedOut ? "estimated" : "reported";
}

/**
 * Normalize a generation's token usage and build the "Token usage recorded"
 * detail line + cost (tokens + cache + server-tool fees). Floors on streamed
 * answer + reasoning characters so thinking-heavy turns without full usage
 * still bill fairly.
 */
export function buildUsage(
  model: ModelInfo,
  raw: RawGenerationUsage,
  fastMode: FastMode = false
): GenerationUsage {
  const billed = estimateGenerationCostUsd(model, {
    // For Anthropic, raw.input is FRESH only; cache is separate. The estimator
    // bills each bucket at the right rate.
    promptTokens: raw.input,
    completionTokens: raw.output,
    reasoningTokens: raw.reasoning,
    totalTokens: raw.total,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    cacheWrite5m: raw.cacheWrite5m,
    cacheWrite1h: raw.cacheWrite1h,
    webSearchRequests: raw.webSearchRequests,
    xSearchRequests: raw.xSearchRequests,
    fastMode,
    promptChars: raw.promptChars,
    completionChars: raw.completionChars,
    reasoningChars: raw.reasoningChars,
  });
  const cacheRead = Math.max(0, raw.cacheRead ?? 0);
  const cacheWrite5m = Math.max(0, raw.cacheWrite5m ?? 0);
  const cacheWrite1h = Math.max(0, raw.cacheWrite1h ?? 0);
  const cacheWrite =
    cacheWrite5m + cacheWrite1h > 0
      ? cacheWrite5m + cacheWrite1h
      : Math.max(0, raw.cacheWrite ?? 0);
  const cachedDisplay = cacheRead + cacheWrite;
  // Anthropic reports fresh input; other providers already include the cache.
  // Use the same convention as pricing when displaying and persisting totals.
  const totalInput = normalizeUsage(model.provider, {
    input: billed.promptTokens,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
  }).totalInput;
  const searches =
    Math.max(0, raw.webSearchRequests ?? 0) + Math.max(0, raw.xSearchRequests ?? 0);
  const detail = [
    totalInput
      ? `${totalInput.toLocaleString()} input${cachedDisplay ? ` (${cachedDisplay.toLocaleString()} cached)` : ""}`
      : null,
    billed.completionTokens ? `${billed.completionTokens.toLocaleString()} output` : null,
    searches > 0 ? `${searches.toLocaleString()} ${searches === 1 ? "search" : "searches"}` : null,
    billed.costUsd > 0 ? formatUsd(billed.costUsd) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    detail,
    cost: billed.costUsd,
    costMicroUsd: Math.max(0, Math.round(billed.costUsd * 1_000_000)),
    totalInput,
    billedPromptTokens: billed.promptTokens,
    output: billed.completionTokens,
    reasoning: Math.max(0, raw.reasoning ?? 0),
    toolFeesUsd: billed.toolFeesUsd,
    webSearchRequests: Math.max(0, raw.webSearchRequests ?? 0),
    xSearchRequests: Math.max(0, raw.xSearchRequests ?? 0),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    cacheWrite,
    basis: usageBasisOf(raw, billed),
  };
}
