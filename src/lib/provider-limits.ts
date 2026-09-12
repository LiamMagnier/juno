import type { Provider } from "@/lib/providers";

/**
 * Per-provider output ceilings.
 *
 * Lives outside `llm.ts` because that module is `server-only` (it imports every
 * adapter, which construct SDK clients) and this table is a pure fact about
 * each lab that a test must be able to read. It went wrong exactly the way an
 * unreadable table does: two providers were simply missing from it, and the
 * lookup default silently capped them at 8192 tokens.
 */
// Each provider's native max output tokens — the real per-reply ceiling now
// that no plan imposes a smaller cap. A requested value is clamped to this so
// it never exceeds what the model itself allows. Values track each lab's
// published per-request output max; providers that enforce prompt+output ≤
// context (deepseek, mistral, qwen) are set to a context-safe fraction so a
// long conversation can't 400.
export const PROVIDER_MAX_OUTPUT: Record<Provider, number> = {
  // Claude 4.8/Sonnet 5 allow 128k output, but only 64k without a beta header;
  // streamAnthropic adds the thinking budget separately and re-clamps the total
  // to its own 64k outputCap, so 64k is the safe header-free ceiling here.
  anthropic: 64000,
  // GPT-5.6 supports 128k output (400k context); hidden reasoning counts toward
  // this budget, so a generous ceiling avoids starving the visible answer.
  openai: 128000,
  google: 65536, // Gemini 3.x tops out at 65,536 output (thinking+answer combined)
  zhipu: 131072, // GLM-4.6: up to 128k output
  moonshot: 65536, // Kimi K2/K3 allow ~100k; 64k stays safe across the 128k-context models
  deepseek: 32768, // 64k-capable, held to a context-safe share of the 128k window
  mistral: 32768, // output bounded by prompt+output ≤ context; safe share of 256k
  xai: 65536, // Grok 4.5 caps responses ~131k; 64k is ample
  seedance: 8192, // media model — no long text output
  minimax: 131072, // MiniMax M2 allows 131k output
  mimo: 16384,
  qwen: 65536, // Qwen3 Max: 65,536 output
  // Both of these were MISSING, so clampMaxTokens fell through to the 8192
  // default and neither lab could produce a long answer on any plan — a silent
  // cap that looked like the model giving up early.
  meta: 32768, // Meta Model API, Muse Spark 1.2
  longcat: 32768, // Meituan LongCat 2.0
};

/**
 * Clamp a requested output-token cap to what the provider's models actually allow.
 *
 * Every provider in PROVIDER_LIST must have an entry above;
 * `tests/provider-limits.test.ts` asserts it, because a missing key is not an
 * error anywhere — it is a quietly 4x-smaller answer on one lab.
 */
export function clampMaxTokens(provider: string, requested: number): number {
  // `provider` is a plain string at several call sites (route/runner metadata),
  // so an unknown one falls back rather than throwing — the table test is what
  // keeps every REAL provider out of that fallback.
  return Math.min(Math.max(1024, requested), PROVIDER_MAX_OUTPUT[provider as Provider] ?? 8192);
}

