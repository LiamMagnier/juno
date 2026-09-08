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
 */

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
}

export interface StreamBudgetGuard {
  /** Check the running cost. Safe to call on every event. */
  enforce(): void;
  /** True once the ceiling has been hit. */
  readonly halted: boolean;
}

/** Providers report tokens late or not at all, so fall back to ~4 chars/token. */
const CHARS_PER_TOKEN = 4;

export function createStreamBudgetGuard(opts: StreamBudgetGuardOptions): StreamBudgetGuard {
  let halted = false;

  return {
    enforce() {
      // Latched: once halted, the abort is already in flight and re-running the
      // estimate would fire onHalt again on every subsequent event.
      if (opts.ceilingMicroUsd == null || halted) return;

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
      const projected = fresh * opts.rates.input + cached * cacheRate + outTok * opts.rates.output;

      if (projected >= opts.ceilingMicroUsd) {
        halted = true;
        opts.onHalt();
      }
    },
    get halted() {
      return halted;
    },
  };
}
