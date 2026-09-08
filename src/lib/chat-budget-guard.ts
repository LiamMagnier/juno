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

      const { promptTokens, completionTokens, cacheReadTokens, outputChars, reasoningChars } = opts.usage();
      const inTok = promptTokens ?? Math.ceil(opts.inputChars / CHARS_PER_TOKEN);
      const outTok = completionTokens ?? Math.ceil((outputChars + reasoningChars) / CHARS_PER_TOKEN);
      // Cached reads are priced at the cache rate, not the full input rate.
      // Providers report them beside the prompt count (Anthropic exclusive of
      // it, OpenAI inclusive); the guard only ever needs an upper bound, so the
      // cached share is capped at the prompt count and priced separately.
      const cached = Math.min(Math.max(0, cacheReadTokens ?? 0), inTok);
      const cacheRate = opts.rates.cacheRead ?? opts.rates.input;
      const projected = (inTok - cached) * opts.rates.input + cached * cacheRate + outTok * opts.rates.output;

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
