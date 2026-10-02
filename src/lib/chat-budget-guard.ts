/**
 * The mid-stream budget ceiling.
 *
 * The instant the running cost of a generation would push a user past their
 * remaining plan budget, the provider stream is aborted so they cannot be billed
 * a cent beyond it. This ran twice in the chat route — once per streaming path,
 * byte-identical apart from which system prompt and history it measured — which
 * is exactly the kind of duplication that drifts apart on a money path.
 *
 * Free of `server-only` and of any I/O so the arithmetic and the latch are
 * testable; the caller supplies the token counts it has accumulated so far.
 *
 * Two ways a tool turn stays inside the budget (SPEC §4.7, DECISIONS §4c):
 * the hard halt above, which now also counts Juno's tool fees and provider
 * search fees, and a soft one — after every request the route asks whether one
 * more tool round plus a final answer would cross the ceiling, and if so the
 * loop's next request is the tools-off final one. The soft path makes the halt
 * rare: the turn ends with an answer written from what it found instead of a
 * cut-off stream.
 */
import type { UsageAccumulator } from "@/lib/usage-merge";

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
}

export interface StreamBudgetGuardOptions {
  /** Remaining plan budget in micro-USD; null means unlimited (owner). */
  ceilingMicroUsd: number | null;
  rates: StreamBudgetRates;
  /** Characters of system + history, the floor when the provider has not yet
   *  reported a prompt token count. */
  inputChars: number;
  /** Live counts, read fresh on every check. */
  usage: () => {
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens served from the provider's cache — billed at `rates.cacheRead`. */
    cacheReadTokens?: number;
    /**
     * Whether `promptTokens` already counts the cached reads. OpenAI-style
     * providers report `prompt_tokens` INCLUSIVE of `cached_tokens`; Anthropic
     * reports `input_tokens` EXCLUSIVE of `cache_read_input_tokens`. Getting
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
  const writeSplit = (last.cacheWrite5m ?? 0) + (last.cacheWrite1h ?? 0);
  const write = writeSplit > 0 ? writeSplit : (last.cacheWrite ?? 0);
  const cacheRead = last.cacheRead ?? 0;
  const input = options.promptTokensIncludeCacheRead
    ? (last.input ?? 0) + write
    : (last.input ?? 0) + cacheRead + write;
  const cachedShare = input > 0 ? Math.min(1, Math.max(0, cacheRead / input)) : 0;
  return { lastRequestInputTokens: input, cachedShare };
}

export function createStreamBudgetGuard(opts: StreamBudgetGuardOptions): StreamBudgetGuard {
  let halted = false;

  const projected = (): number => {
    const {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      promptTokensIncludeCacheRead = true,
      outputChars,
      reasoningChars,
    } = opts.usage();
    const reported = promptTokens ?? Math.ceil(opts.inputChars / CHARS_PER_TOKEN);
    const outTok = completionTokens ?? Math.ceil((outputChars + reasoningChars) / CHARS_PER_TOKEN);
    // Cached reads are priced at the cache rate, not the full input rate.
    // Whether they sit inside the reported prompt count is provider-specific
    // (see `promptTokensIncludeCacheRead`); either way the fresh share is
    // never allowed below zero, so the guard stays an upper bound.
    const cachedRaw = Math.max(0, cacheReadTokens ?? 0);
    const cached = promptTokensIncludeCacheRead ? Math.min(cachedRaw, reported) : cachedRaw;
    const fresh = promptTokensIncludeCacheRead ? reported - cached : reported;
    const cacheRate = opts.rates.cacheRead ?? opts.rates.input;
    const extra = Math.max(0, opts.extraCostMicroUsd?.() ?? 0);
    return fresh * opts.rates.input + cached * cacheRate + outTok * opts.rates.output + extra;
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
      const input = Math.max(0, next.lastRequestInputTokens);
      const share = Math.min(1, Math.max(0, next.cachedShare));
      const cacheRate = opts.rates.cacheRead ?? opts.rates.input;
      const promptCost = input * ((1 - share) * opts.rates.input + share * cacheRate);
      const nextRound = promptCost + NEXT_ROUND_OUTPUT_TOKENS * opts.rates.output + Math.max(0, next.toolFeeEstimateMicroUsd);
      const finalAnswer = promptCost + FINAL_ANSWER_OUTPUT_TOKENS * opts.rates.output;
      return projected() + nextRound + finalAnswer >= opts.ceilingMicroUsd;
    },
  };
}
