import { looksTruncated } from "@/lib/answer-completeness";
import { normalizeFinishReason } from "@/lib/finish-reason";
import type { ChatFinishReason } from "@/types/chat";

/**
 * How a Gemini turn ended, and what to tell the reader about it.
 *
 * Deliberately free of `server-only`, SDK clients and network code — like
 * `background-provider-policy.ts` — so the rules can be unit-tested against the
 * exact token counts that produced a bad label in production. Everything here
 * is a pure function of what came off the wire.
 *
 * TWO FACTS ABOUT GEMINI 3 SHAPE ALL OF IT:
 *
 *  1. `maxOutputTokens` is a COMBINED budget for thinking and answer. Google
 *     reports the two counts separately (`thoughtsTokenCount` and
 *     `candidatesTokenCount`) and charges both to the one ceiling.
 *  2. The model expands its thinking to fill very nearly whatever budget it is
 *     given. At HIGH on a long task it will think for ~64k of a 65,536 budget
 *     and then write the answer in what is left.
 *
 * Together they produce the failure this module exists for: a reply cut off
 * mid-sentence after ~1.3k tokens, on a request that asked for Google's own
 * published maximum. Raising the cap cannot fix it — 65,536 IS Gemini 3.8
 * Flash's maximum — and removing it is worse still: an unset max_output_tokens
 * makes the model hang with no server-side timeout
 * (googleapis/python-genai#2062). The only honest response is to say what
 * happened, in the numbers, and name the lever that does work.
 */

/** Within this many tokens of the ceiling is the model being cut off, not finishing. */
const CAP_SLACK = 32;

/**
 * Thinking must take at least this share of the budget before the note blames
 * it. Below the line the reply really did just run out of room, and Continue —
 * the generic advice — is the right advice.
 */
const THINKING_DOMINANCE = 0.5;

export interface GeminiFinishInput {
  /** The provider's own terminal reason, when it sent one. */
  lastFinishReason: string | null;
  /** Did any `usageMetadata` frame arrive? Without one the counts mean nothing. */
  sawUsage: boolean;
  /** `candidatesTokenCount` — the visible reply. */
  answerTokens: number;
  /** `thoughtsTokenCount` — charged to the same ceiling as the reply. */
  thoughtTokens: number;
  /** The `maxOutputTokens` this request asked for. */
  maxTokens: number;
  /** The tail of the answer, for the no-terminal-frame case. */
  answerTail: string;
}

export interface GeminiFinishDecision {
  /** The raw reason to report, provider-shaped so `normalizeFinishReason` maps it. */
  raw: string;
  reason: ChatFinishReason;
  /** One sentence naming the real cause, when the counts know one. */
  note?: string;
  /** Was the decision made from evidence rather than from a provider reason? */
  decidedOnEvidence: boolean;
  /** Only meaningful when `decidedOnEvidence`; kept for the operator log. */
  atCap: boolean;
  truncated: boolean;
}

/**
 * Did this turn exhaust its output budget?
 *
 * THINKING COUNTS. This used to compare `answerTokens` alone against the
 * ceiling, which is how the reported turn — 1,270 answer tokens against a
 * 65,536 budget — was read as comfortably finished when it had in fact spent
 * every token it had: the other 64,266 went to thoughts.
 */
export function geminiAtCap(input: Pick<GeminiFinishInput, "sawUsage" | "answerTokens" | "thoughtTokens" | "maxTokens">): boolean {
  if (!input.sawUsage) return false;
  const billed = input.answerTokens + input.thoughtTokens;
  return billed > 0 && billed >= input.maxTokens - CAP_SLACK;
}

/**
 * The sentence the reader actually needs, or nothing.
 *
 * `finishReasonDetail("length")` says "Use Continue to ask the model to pick up
 * from the partial answer". That is right for an answer that ran long and wrong
 * for one whose thinking ate the budget: Continue resumes into the same budget
 * and the same expansion, so the advice sends the reader round the loop again.
 * Only the token counts can tell the two apart, so only this can say it.
 */
export function geminiFinishNote(
  reason: ChatFinishReason,
  input: Pick<GeminiFinishInput, "sawUsage" | "answerTokens" | "thoughtTokens" | "maxTokens">,
): string | undefined {
  if (reason !== "length" || !input.sawUsage) return undefined;
  if (input.thoughtTokens < input.maxTokens * THINKING_DOMINANCE) return undefined;
  const n = (value: number) => value.toLocaleString("en-US");
  return (
    `Thinking used ${n(input.thoughtTokens)} of the ${n(input.maxTokens)} tokens this model can produce in ` +
    `one reply, leaving ${n(input.answerTokens)} for the answer. ` +
    `Lower the thinking level for a longer reply, or use Continue.`
  );
}

export function decideGeminiFinish(input: GeminiFinishInput): GeminiFinishDecision {
  const atCap = geminiAtCap(input);

  if (input.lastFinishReason) {
    const reason = normalizeFinishReason(input.lastFinishReason);
    return {
      raw: input.lastFinishReason,
      reason,
      // The provider naming the reason does not make the reason useful: a
      // Google-sent MAX_TOKENS over a thinking-starved answer needs the same
      // sentence as one we inferred.
      note: geminiFinishNote(reason, input),
      decidedOnEvidence: false,
      atCap,
      truncated: false,
    };
  }

  /*
   * THE CAP IS NOT THE ONLY WAY AN ANSWER GETS CUT OFF, and assuming it was is
   * what put "Done · 7.6s" under a reply that stopped at "…an interactive
   * command palette (" — the product calmly reporting success over a
   * half-written sentence, with nothing to click. That is worse than the red
   * banner it replaced: a banner at least says something went wrong.
   *
   * So when the provider will not say why it stopped, read the text. Prose that
   * ends mid-bracket, on a conjunction, or inside an unclosed code fence was cut
   * off whatever the token count says. `length` is the honest label — it does
   * not claim the answer finished, and it is the one that offers Continue.
   */
  const truncated = looksTruncated(input.answerTail);
  const raw = atCap || truncated ? "MAX_TOKENS" : "STOP";
  const reason = normalizeFinishReason(raw);
  return { raw, reason, note: geminiFinishNote(reason, input), decidedOnEvidence: true, atCap, truncated };
}
