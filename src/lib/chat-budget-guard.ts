/**
 * The estimated mid-stream budget ceiling.
 *
 * Abort when the available usage projection reaches the remaining plan budget.
 * Usage can arrive late, and a provider may already have accepted work when an
 * abort arrives, so this is not an invoice-level hard cap. Saved and private
 * chat use the same arithmetic instead of duplicating money-path logic.
 *
 * Free of `server-only` and of any I/O so the arithmetic and the latch are
 * testable; the caller supplies the token counts it has accumulated so far.
 *
 * Callers can supply extra tool/search cost and ask whether another tool round
 * plus a final answer would cross the ceiling. Those estimates only include
 * the inputs the caller wires here; completed-request receipts are reconciled
 * separately at settlement.
 */
import type { UsageAccumulator } from "@/lib/usage-merge";
import { normalizeUsage } from "@/lib/pricing";

export interface StreamBudgetRates {
  /** micro-USD per input token. */
  input: number;
  /** micro-USD per output token. */
  output: number;
  /** micro-USD per cached input token read (~0.1x input). Optional: a guard
   *  without it prices every prompt token at the full rate, which on a long
   *  cached chat over-projects by up to 10x and halts turns the plan could
   *  afford. */
  cacheRead?: number;
  /** Cache-write prices in the same micro-USD-per-token convention. */
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface StreamBudgetGuardOptions {
  /** Remaining plan budget in micro-USD; null means unlimited (owner). */
  ceilingMicroUsd: number | null;
  /** Read the served tier again when a provider falls back from a premium tier. */
  rates: StreamBudgetRates | (() => StreamBudgetRates);
  /** Characters of system + history, the floor when the provider has not yet
   *  reported a prompt token count. */
  inputChars: number;
  /** Live counts, read fresh on every check. */
  usage: () => {
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens served from the provider's cache — billed at `rates.cacheRead`. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite5mTokens?: number;
    cacheWrite1hTokens?: number;
    /**
     * Whether `promptTokens` already counts cached reads AND writes. OpenAI-style
     * providers report an INCLUSIVE prompt count; Anthropic reports
     * `input_tokens` EXCLUSIVE of both cache buckets. Getting
     * this wrong in either direction is a 10x error on a long chat, so it is
     * stated rather than guessed. Default: inclusive.
     */
    promptTokensIncludeCacheRead?: boolean;
    /** Answer text so far. */
    outputChars: number;
    /** Reasoning text so far — billed, so it counts toward the ceiling. */
    reasoningChars: number;
  };
  /** Called once, when the ceiling is first crossed. */
  onHalt: () => void;
  /**
   * Juno tool fees and provider search fees so far, micro-USD
   * (`ToolFeeAccumulator` plus search counts). A tool payload spends no tokens,
   * so without this a turn of paid searches could pass the ceiling unseen.
   */
  extraCostMicroUsd?: () => number;
}

/** What the next request would carry, from the last one (see `lastRequestFigures`). */
export interface NextRoundEstimate {
  /** Prompt tokens of the last request, cache reads included. */
  lastRequestInputTokens: number;
  /** Share of those that were cache reads, 0–1. */
  cachedShare: number;
  /** Juno fees the next tool round may add: `toolFeeEstimateFor(...)`. */
  toolFeeEstimateMicroUsd: number;
}

export interface StreamBudgetGuard {
  /** Check the running cost. Safe to call on every event. */
  enforce(): void;
  /** True once the ceiling has been hit. */
  readonly halted: boolean;
  /** The running cost as `enforce` measures it: tokens so far plus the extra cost. */
  projectedMicroUsd(): number;
  /**
   * Would one more tool round plus a final answer cross the ceiling? The route
   * asks after every `usage` event and, when it would, makes the next request
   * the final one (`loop.requestFinal("budget")`). Never true without a
   * ceiling.
   */
  wouldExceedNextRound(next: NextRoundEstimate): boolean;
}

/** Providers report tokens late or not at all, so fall back to ~4 chars/token. */
const CHARS_PER_TOKEN = 4;

/** Output a tool round is assumed to write: its reasoning and its calls. */
export const NEXT_ROUND_OUTPUT_TOKENS = 2_000;
/** Output a final answer is assumed to write. */
export const FINAL_ANSWER_OUTPUT_TOKENS = 1_500;
/** What one more round's Juno searches may cost, when `web_search` is attached. */
export const WEB_SEARCH_ROUND_FEE_ESTIMATE_MICRO_USD = 8_000;

/** The tool fee a next round is assumed to add (SPEC §4.7). */
export function toolFeeEstimateFor(input: { webSearchAttached: boolean }): number {
  return input.webSearchAttached ? WEB_SEARCH_ROUND_FEE_ESTIMATE_MICRO_USD : 0;
}

const TOKEN_FIELDS = [
  "input",
  "output",
  "reasoning",
  "total",
  "cacheRead",
  "cacheWrite",
  "cacheWrite5m",
  "cacheWrite1h",
  "webSearchRequests",
  "xSearchRequests",
] as const;

/**
 * One request's usage, from two cumulative readings. Adapters report usage
 * cumulatively and the accumulator merges it with `preferHigher`, so the last
 * request is the difference, field by field, never below zero.
 */
export function usageDelta(previous: UsageAccumulator | null | undefined, current: UsageAccumulator): UsageAccumulator {
  const out: UsageAccumulator = {};
  for (const field of TOKEN_FIELDS) {
    const now = current[field];
    if (now == null) continue;
    out[field] = Math.max(0, now - (previous?.[field] ?? 0));
  }
  return out;
}

/**
 * The prompt size and cached share of the last request (SPEC §4.7).
 *
 * `promptTokensIncludeCacheRead` is the same flag the guard's `usage()` takes:
 * OpenAI-style providers count cache reads inside the prompt, Anthropic
 * outside it, and adding them twice (or not at all) is a 10x error on a long
 * cached chat.
 */
export function lastRequestFigures(
  previous: UsageAccumulator | null | undefined,
  current: UsageAccumulator,
  options: { promptTokensIncludeCacheRead: boolean }
): { lastRequestInputTokens: number; cachedShare: number } {
  const last = usageDelta(previous, current);
  // Use the ledger's convention here too. OpenAI includes writes in input;
  // adding them again inflated the estimate of every remaining tool round,
  // forcing an early final answer while the user's budget could still pay.
  const normalized = normalizeUsage(options.promptTokensIncludeCacheRead ? "openai" : "anthropic", last);
  const input = normalized.totalInput;
  const cacheRead = normalized.cacheRead;
  const cachedShare = input > 0 ? Math.min(1, Math.max(0, cacheRead / input)) : 0;
  return { lastRequestInputTokens: input, cachedShare };
}

export function createStreamBudgetGuard(opts: StreamBudgetGuardOptions): StreamBudgetGuard {
  let halted = false;
  const ratesNow = () => typeof opts.rates === "function" ? opts.rates() : opts.rates;

  const projected = (rates = ratesNow()): number => {
    const {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      promptTokensIncludeCacheRead = true,
      outputChars,
      reasoningChars,
    } = opts.usage();
    // Older Anthropic usage events omit a zero fresh-input count. Positive
    // cache buckets already account for that input; estimating the whole
    // prompt again would charge it once fresh and once cached.
    const cacheOnly = !promptTokensIncludeCacheRead &&
      [cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens].some((n) => (n ?? 0) > 0);
    const reported = promptTokens ?? (cacheOnly ? 0 : Math.ceil(opts.inputChars / CHARS_PER_TOKEN));
    // A tool loop has the previous request's count while the next one is
    // streaming. That older count cannot disable the character floor and let
    // the next response run past the ceiling until its final usage arrives.
    const outTok = Math.max(0, completionTokens ?? 0, Math.ceil((outputChars + reasoningChars) / CHARS_PER_TOKEN));
    const normalized = normalizeUsage(promptTokensIncludeCacheRead ? "openai" : "anthropic", {
      input: reported,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      cacheWrite5m: cacheWrite5mTokens,
      cacheWrite1h: cacheWrite1hTokens,
    });
    const cacheRate = rates.cacheRead ?? rates.input;
    const writeRate = rates.cacheWrite ?? rates.input;
    const splitWrite = normalized.cacheWrite5m + normalized.cacheWrite1h;
    const writeCost = splitWrite > 0
      ? normalized.cacheWrite5m * (rates.cacheWrite5m ?? writeRate) + normalized.cacheWrite1h * (rates.cacheWrite1h ?? writeRate)
      : normalized.cacheWrite * writeRate;
    const extra = Math.max(0, opts.extraCostMicroUsd?.() ?? 0);
    return normalized.freshInput * rates.input + normalized.cacheRead * cacheRate + writeCost + outTok * rates.output + extra;
  };

  return {
    enforce() {
      // Latched: once halted, the abort is already in flight and re-running the
      // estimate would fire onHalt again on every subsequent event.
      if (opts.ceilingMicroUsd == null || halted) return;
      if (projected() >= opts.ceilingMicroUsd) {
        halted = true;
        opts.onHalt();
      }
    },
    get halted() {
      return halted;
    },
    projectedMicroUsd: projected,
    wouldExceedNextRound(next) {
      if (opts.ceilingMicroUsd == null) return false;
      const rates = ratesNow();
      const input = Math.max(0, next.lastRequestInputTokens);
      const share = Math.min(1, Math.max(0, next.cachedShare));
      const cacheRate = rates.cacheRead ?? rates.input;
      const promptCost = input * ((1 - share) * rates.input + share * cacheRate);
      const nextRound = promptCost + NEXT_ROUND_OUTPUT_TOKENS * rates.output + Math.max(0, next.toolFeeEstimateMicroUsd);
      const finalAnswer = promptCost + FINAL_ANSWER_OUTPUT_TOKENS * rates.output;
      return projected(rates) + nextRound + finalAnswer >= opts.ceilingMicroUsd;
    },
  };
}
