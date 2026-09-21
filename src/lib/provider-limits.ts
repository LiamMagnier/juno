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
// The largest per-reply budget that EVERY model in a lab's lineup accepts.
//
// Not the flagship's ceiling. This one value is applied to every model of that
// provider, so the SMALLEST output cap in the lineup is what it has to respect
// — and within a lab those differ by more than an order of magnitude while the
// context window says nothing about which is which. Qwen is the worked example:
// qwen3.8-max takes 131,072 output tokens, and qwen3.6-flash rejects the same
// number with a 400 despite having a LARGER (1M) context window.
//
// That was learned the expensive way. Raising this entry to the Max line's
// 131,072 shipped to production and 400'd every Qwen model —
// "Qwen3.6 Flash couldn't accept this request", caught by the release smoke
// after the build was already live. Output capability does not follow context
// size, so the per-model context bound in `clampMaxTokens` cannot catch it.
//
// So a value here may only be raised against evidence about the lab's SMALLEST
// model, never its largest. The two failure directions are not symmetrical:
// too low truncates one reply, too high fails every request. Per-model raises
// belong in a per-model table with per-model evidence, not here.
export const PROVIDER_MAX_OUTPUT: Record<Provider, number> = {
  // 64k is the ceiling every Claude in the catalog accepts unconditionally.
  // The adaptive-era models (Opus 4.7/4.8, Sonnet 5, Fable 5.x) go to 128k —
  // `anthropic-thinking.ts` already allows that as its own outputCap — but
  // Haiku 4.5 and the 4.5 line stop at 64k and `claude-3`/`opus-4-1` at 32k, so
  // a lab-wide 128000 would be a 400 on half the lineup. The adaptive models
  // still reach past this: streamAnthropic adds the thinking headroom on top of
  // the number clamped here, up to its own 128k cap.
  anthropic: 64000,
  // GPT-5.6 supports 128k output (400k context); hidden reasoning counts toward
  // this budget, so a generous ceiling avoids starving the visible answer.
  openai: 128000,
  google: 65536, // Gemini 3.x tops out at 65,536 output (thinking+answer combined)
  zhipu: 131072, // GLM-5.3 (and 5.2): 1M context, up to 128k output
  // Kimi K3 accepts up to 1,048,576 and K2.5/K2.6 up to 262,144, so this is far
  // under the flagship — and it is the value the whole Moonshot lineup has
  // served in production without a 400, which is the bar this table has to
  // clear. Raising it needs evidence about kimi-k2.7-code, not about K3.
  moonshot: 65536,
  deepseek: 32768, // DeepSeek's V4 notes say 384k output; 32768 is what this lineup is proven to take
  mistral: 32768, // Mistral Large 3 documents 131k output; 32768 is what this lineup is proven to take
  xai: 65536, // xAI publishes no text-output limit; 65536 is what this lineup is proven to take
  seedance: 8192, // media model — no long text output
  minimax: 131072, // MiniMax documents 131,072 recommended (524,288 hard max) for M3
  // The one raise kept from the audit, because 16384 was not a conservative
  // value — it was a broken one, and the bug this table was re-read for: MiMo
  // answers stopped at an eighth of what the model would have written, on a
  // 1.05M context model. 131072 is the number Xiaomi's API itself enforces, and
  // it enforces it by REJECTING anything above — which is what makes 131072 an
  // accepted value rather than a guess at one. That ceiling belongs to the API
  // rather than to one model, so it covers Flash as well as Pro.
  mimo: 131072,
  // 131072 is correct for qwen3.7/3.8-max and a 400 on qwen3.6-flash — the
  // failure in the header. Alibaba caps the Flash and Plus lines well below the
  // Max line, and nothing in the catalog records which model is which, so the
  // lineup minimum stands until something does.
  qwen: 65536,
  // meta and longcat were once MISSING from this table entirely, so
  // clampMaxTokens fell through to the 8192 default and neither lab could
  // produce a long answer on any plan — a silent cap that looked like the model
  // giving up early. Keep every provider present even when the figure is a
  // guess; absence is the failure that hides.
  meta: 32768, // Meta publishes no per-model output cap; 131072 is unverified against the live API
  // Meituan publishes no output figure for LongCat 2.0, and it is still
  // comingSoon, so nothing calls this yet. Left at the value it was given
  // rather than raised on a guess — revisit when it goes live.
  longcat: 32768,
};

/**
 * Share of a model's context window that its reply may claim.
 *
 * Several labs (DeepSeek, Mistral, Qwen, Zhipu) enforce
 * `prompt_tokens + max_tokens <= context_length`, so a budget bigger than the
 * window is a 400 rather than a long answer. The table above used to absorb
 * that by shading whole providers down, which punished their long-context
 * flagships to protect their short-context siblings — and still didn't work:
 * `zhipu` sat at 131072 while `glm-4.6` has a 128,000-token window, so every
 * GLM-4.x request asked for more output than the model could hold.
 *
 * Half is the crude prompt allowance that shading was really reaching for,
 * applied where it belongs: per model, against that model's own window.
 */
const CONTEXT_SHARE = 0.5;

/**
 * Clamp a requested output-token cap to what this model actually allows.
 *
 * Every provider in PROVIDER_LIST must have an entry above;
 * `tests/provider-limits.test.ts` asserts it, because a missing key is not an
 * error anywhere — it is a quietly 4x-smaller answer on one lab.
 *
 * `contextWindow` is optional so the lab ceiling still applies on its own, but
 * callers holding a model should pass it: it is the only bound that
 * distinguishes a lab's flagship from its small siblings.
 */
export function clampMaxTokens(provider: string, requested: number, contextWindow?: number): number {
  // `provider` is a plain string at several call sites (route/runner metadata),
  // so an unknown one falls back rather than throwing — the table test is what
  // keeps every REAL provider out of that fallback.
  const providerCap = PROVIDER_MAX_OUTPUT[provider as Provider] ?? 8192;
  const contextCap =
    contextWindow && contextWindow > 0 ? Math.floor(contextWindow * CONTEXT_SHARE) : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(1024, requested), providerCap, contextCap);
}
