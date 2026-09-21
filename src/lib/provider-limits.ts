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
// Each provider's native max output tokens — the largest per-reply budget the
// lab's own API will accept. A requested value is clamped to this so it never
// exceeds what the model itself allows.
//
// These are per-LAB ceilings only. The per-MODEL bound is the model's own
// context window, applied by `clampMaxTokens` below — which is why no entry
// here is shaded down "to be context-safe" any more. Shading here was wrong in
// both directions at once: it held the lab's flagship (1M context) to a
// fraction of what it can write, while still handing its small siblings
// (128k context) a budget larger than their entire window.
//
// Asking for more than a lab accepts is a 400, so these track published
// figures; asking for less than it accepts is a reply that stops mid-sentence,
// which is what the reader actually reports. Audited 2026-09-21 — sources in
// the per-entry notes.
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
  // Kimi K3 takes max_completion_tokens up to 1,048,576 and DEFAULTS to
  // 131,072; K2.5/K2.6 accept up to 262,144. 131,072 is the largest value every
  // Moonshot model in the catalog accepts. Was 65536 on a "stays safe across
  // the 128k-context models" note — the context bound below is what actually
  // keeps those safe, and it does so without halving K3.
  moonshot: 131072,
  // DeepSeek's own V4 notes give 1M context / 384k max output; third-party
  // hosts enforce far less (65,536 on Ollama Cloud, 32k reported elsewhere).
  // 131,072 is under every figure any first-party doc quotes and 4x the old
  // 32768, which was a "context-safe share" — a job the context bound now does
  // per model instead of per lab.
  deepseek: 131072,
  mistral: 131072, // Mistral Large 3: 256k context, up to 131k output
  // xAI publishes no separate text-output limit for the Grok 4.x line; 131,072
  // is the largest figure its docs have ever quoted for a response, and the
  // per-model context bound handles the 256k-window Grok Build.
  xai: 131072,
  seedance: 8192, // media model — no long text output
  minimax: 131072, // MiniMax documents 131,072 recommended (524,288 hard max) for M3
  // The number Xiaomi's API enforces — it rejects any completion budget above
  // it. This was 16384, the only entry in the table with no note saying why,
  // and 8x under the real ceiling: a MiMo answer was cut off at an eighth of
  // what the model would have written, on a 1.05M context model, and the reader
  // saw a reply that simply stopped.
  mimo: 131072,
  qwen: 131072, // Qwen3.7/3.8 Max: 131,072 output (the old 65536 note quoted Qwen3 Max, two generations back)
  // meta and longcat were once MISSING from this table entirely, so
  // clampMaxTokens fell through to the 8192 default and neither lab could
  // produce a long answer on any plan — a silent cap that looked like the model
  // giving up early. Keep every provider present even when the figure is a
  // guess; absence is the failure that hides.
  meta: 131072, // Meta Model API defaults max_tokens to 131,072 for the Muse Spark line
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
