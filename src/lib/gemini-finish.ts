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
  /**
   * How many automatic continuations this turn has already spent.
   *
   * Only changes what the READER is told. A turn that was continued twice and
   * still ended at `length` produced a far longer answer than the note below
   * was written for, and telling that reader "thinking used 59,000 of your
   * 65,536 tokens" describes the first of three requests — true of that
   * request, and a misleading account of the reply in front of them.
   */
  continued?: number;
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
  input: Pick<GeminiFinishInput, "sawUsage" | "answerTokens" | "thoughtTokens" | "maxTokens" | "continued">,
): string | undefined {
  if (reason !== "length" || !input.sawUsage) return undefined;
  const n = (value: number) => value.toLocaleString("en-US");

  // The turn was already extended and STILL ran out. Naming the first request's
  // split would describe a third of what the reader is looking at, and naming
  // the thinking level would point at a lever the continuations already pulled.
  // What is true of the whole turn is that the answer is genuinely very long.
  if (input.continued && input.continued > 0) {
    const times = input.continued === 1 ? "once" : `${input.continued} times`;
    return (
      `The answer was continued ${times} automatically and is still unfinished. ` +
      `Use Continue to carry on, or ask for a narrower part of it.`
    );
  }

  if (input.thoughtTokens < input.maxTokens * THINKING_DOMINANCE) return undefined;
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

/* ───────────────────────────────────────────────────────────────────────────
 * FINISHING THE ANSWER, rather than explaining why it is short.
 *
 * The note above is honest and it is not enough. "Lower the thinking level for
 * a longer reply" asks the reader to give up the thing they chose — someone on
 * HIGH wants the considered answer, and the reply they got stopped at ~6k
 * tokens not because the model had finished but because it had spent 59k of a
 * 65,536 budget thinking first. Telling them to think less is telling them the
 * feature does not work.
 *
 * Continue does not save it either, and that is the specific trap: Continue
 * re-sends the turn at the SAME thinking level into the SAME combined budget,
 * so the model reasons its way to the ceiling a second time and returns another
 * stub. The reader presses it again. That loop is what makes this a bug rather
 * than a limit.
 *
 * The way out is available on the very next request: the thinking for this
 * answer HAS ALREADY HAPPENED. A continuation that hands the model its own last
 * words and asks it to resume, with thinking dropped to the model's floor,
 * spends nearly the whole 65,536 on prose. So the adapter finishes the answer
 * itself instead of printing advice about it — one or two extra requests,
 * bounded, and only for the shape of failure where the manual lever is known to
 * loop.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * How many extra requests one turn may spend finishing a starved answer.
 *
 * Two, not unbounded. Each continuation runs at the thinking floor and so has
 * the full ceiling for prose — three passes is ~190k output tokens, past any
 * answer a chat turn should be producing — and an unbounded loop against a
 * model that keeps ending at `length` is a way to spend a lot of somebody's
 * money quietly. When the allowance is gone the turn ends as `length` with the
 * note, which is exactly where it ended before.
 */
export const MAX_GEMINI_CONTINUATIONS = 2;

/**
 * Should this turn be continued automatically?
 *
 * Deliberately NARROW. The generic `length` finish — an answer that genuinely
 * ran long — is left alone: Continue works for it, the reader can judge whether
 * they want more, and auto-spending a second request on every long reply is a
 * cost decision that is not the adapter's to make. The one case handled here is
 * the one where the manual lever provably loops: thinking took at least half
 * the ceiling, so the answer never had room to finish and pressing Continue
 * would reproduce the same split.
 */
export function geminiShouldContinue(
  reason: ChatFinishReason,
  input: Pick<GeminiFinishInput, "sawUsage" | "answerTokens" | "thoughtTokens" | "maxTokens">,
): boolean {
  if (reason !== "length" || !input.sawUsage) return false;
  // Nothing to resume FROM. An empty answer is a different failure — the model
  // thought until it hit the wall and never started writing — and stitching a
  // continuation onto nothing produces a reply with no beginning.
  if (input.answerTokens <= 0) return false;
  return input.thoughtTokens >= input.maxTokens * THINKING_DOMINANCE;
}

/**
 * What the continuation request asks for.
 *
 * Every clause is defending one seam. The reader already has the first part on
 * screen, so a continuation that reintroduces itself ("Continuing from where I
 * left off:"), restates the last paragraph, or re-opens a heading it has
 * already written shows up as a visible stutter in the middle of the answer.
 */
export const GEMINI_CONTINUE_INSTRUCTION =
  "Your previous message was cut off because the response budget ran out. " +
  "Continue it from exactly where it stops. Do not repeat any text you have already written, " +
  "do not summarise it, and do not open with a preamble or a heading you have already used — " +
  "resume mid-sentence if that is where it ended. Keep the same voice, format and depth.";
