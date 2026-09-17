import test from "node:test";
import assert from "node:assert/strict";

import {
  GEMINI_CONTINUE_INSTRUCTION,
  MAX_GEMINI_CONTINUATIONS,
  decideGeminiFinish,
  geminiFinishNote,
  geminiShouldContinue,
} from "@/lib/gemini-finish";
import { GEMINI_CONTINUE_TAIL_CHARS, appendGeminiContinuation } from "@/lib/gemini-round";
import { geminiContinuationConfig, geminiGenerationConfig } from "@/lib/gemini-core";
import type { GeminiContent, GeminiPart } from "@/lib/gemini-core";
import type { ModelInfo } from "@/lib/models";

/*
 * FINISHING A THINKING-STARVED ANSWER INSTEAD OF EXPLAINING IT.
 *
 * Reported as: Gemini 3.8 Flash on HIGH stops at around 6,000 tokens of answer.
 * The label for that was fixed first (tests/gemini-thinking-budget.test.ts) and
 * the label was never the complaint — the reply is still a stub. `maxOutputTokens`
 * is a COMBINED budget on Gemini 3, the model expands its thinking to fill nearly
 * all of it, and 65,536 is already Google's published maximum, so there is no
 * larger number to ask for.
 *
 * The lever the old note named does not work here, and that is the crux: Continue
 * re-runs the turn at the same thinking level into the same ceiling, so it
 * reproduces the same split and the reader presses it again. The thinking for this
 * answer has already happened, so the adapter resumes the reply itself with
 * thinking dropped to the model's floor, where nearly the whole ceiling is prose.
 *
 * These tests pin WHEN that happens (narrowly), what the second request asks for,
 * and that the seam is staged as the model's own words rather than described.
 */

/** The reported turn, in the shape the decision layer reads it. */
const STARVED = {
  sawUsage: true,
  answerTokens: 6_012,
  thoughtTokens: 59_400,
  maxTokens: 65_536,
};

test("a thinking-starved length finish is continued", () => {
  assert.equal(geminiShouldContinue("length", STARVED), true);
});

test("an answer that merely ran long is left to the reader", () => {
  // The whole budget went to prose. Continue works for this one, the reader can
  // see how long it already is, and spending a second request on every long
  // reply is a cost decision the adapter has no standing to make.
  assert.equal(
    geminiShouldContinue("length", {
      sawUsage: true,
      answerTokens: 65_000,
      thoughtTokens: 400,
      maxTokens: 65_536,
    }),
    false,
  );
});

test("nothing else is ever continued", () => {
  // A safety stop resumed is a safety stop asked twice.
  assert.equal(geminiShouldContinue("sensitive", STARVED), false);
  assert.equal(geminiShouldContinue("stop", STARVED), false);
  // No usage frame means the counts are zeros, not evidence.
  assert.equal(geminiShouldContinue("length", { ...STARVED, sawUsage: false }), false);
  // Thought to the wall and never started writing: there is no answer to resume
  // from, and stitching a continuation onto nothing yields a reply with no
  // beginning.
  assert.equal(geminiShouldContinue("length", { ...STARVED, answerTokens: 0 }), false);
});

test("the allowance is bounded", () => {
  // Two passes at the floor is ~130k of prose on top of the first attempt. An
  // unbounded loop against a model that keeps ending at `length` spends a lot of
  // somebody's money quietly.
  assert.ok(MAX_GEMINI_CONTINUATIONS >= 1 && MAX_GEMINI_CONTINUATIONS <= 3);
});

/* ── what the second request asks for ─────────────────────────────────────── */

const gemini3 = (over: Partial<ModelInfo> = {}) =>
  ({
    id: "gemini-3-8-flash",
    provider: "google",
    providerModel: "gemini-3.8-flash",
    reasoning: true,
    ...over,
  }) as ModelInfo;

test("the continuation drops thinking to the model's floor", () => {
  const first = geminiGenerationConfig(gemini3(), 65_536, "high");
  assert.deepEqual(
    first.thinkingConfig,
    { includeThoughts: true, thinkingLevel: "HIGH" },
    "the first pass honours the level the reader chose",
  );

  const resumed = geminiContinuationConfig(gemini3(), 65_536);
  const level = (resumed.thinkingConfig as { thinkingLevel?: string }).thinkingLevel;
  assert.notEqual(
    level,
    "HIGH",
    "a continuation at HIGH re-spends the same budget on thinking and returns another stub — this is the whole bug, repeated",
  );
  assert.equal(resumed.maxOutputTokens, 65_536, "the ceiling is unchanged; only the split moves");
});

test("the floor comes from the model's own ladder, not from clamping", () => {
  /*
   * THE TRAP THIS PINS. `clampReasoningEffort(model, "minimal")` hands back the
   * model's DEFAULT for any tier it does not declare, and some Gemini 3 ids
   * accept only low|high — where the default is `high`. Built that way the
   * continuation would think its way to the ceiling again and the fix would
   * silently do nothing at all.
   */
  const lowHighOnly = gemini3({ id: "gemini-3-pro", providerModel: "gemini-3-pro" });
  const level = (
    geminiContinuationConfig(lowHighOnly, 65_536).thinkingConfig as { thinkingLevel?: string }
  ).thinkingLevel;
  assert.notEqual(level, "HIGH");
  assert.notEqual(level, "MEDIUM", "MEDIUM is a 400 on this id — it would cost the rest of the answer");
});

test("a model with no thinking is asked for nothing extra", () => {
  const config = geminiContinuationConfig(gemini3({ reasoning: false }), 8_192);
  assert.equal(config.thinkingConfig, undefined);
  assert.equal(config.maxOutputTokens, 8_192);
});

/* ── the seam ─────────────────────────────────────────────────────────────── */

/** `GeminiPart` is a union (text | inlineData | functionCall …); read the text arm. */
const partText = (part: GeminiPart): string => ("text" in part ? (part.text ?? "") : "");

test("the partial answer is staged as the model's own turn", () => {
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "Write me a portfolio." }] }];
  appendGeminiContinuation(contents, "…an interactive command palette (", GEMINI_CONTINUE_INSTRUCTION);

  assert.equal(contents.length, 3);
  assert.equal(
    contents[1].role,
    "model",
    "handed back in its own role the model is mid-sentence; merely DESCRIBED, it re-enters the topic from outside and writes an introduction",
  );
  assert.equal(partText(contents[1].parts[0]), "…an interactive command palette (");
  assert.equal(contents[2].role, "user");
  assert.match(partText(contents[2].parts[0]), /Do not repeat/);
});

test("only the tail is re-sent", () => {
  const contents: GeminiContent[] = [];
  appendGeminiContinuation(contents, "x".repeat(50_000), GEMINI_CONTINUE_INSTRUCTION);
  // Re-sending 60k tokens of prose the model was already billed for, on the one
  // request whose purpose is to buy room for more prose, spends what it is
  // trying to save.
  assert.equal(partText(contents[0].parts[0]).length, GEMINI_CONTINUE_TAIL_CHARS);
});

test("an empty tail never stages a partless turn", () => {
  const contents: GeminiContent[] = [];
  appendGeminiContinuation(contents, "", GEMINI_CONTINUE_INSTRUCTION);
  // Gemini rejects a content with no parts, and a 400 here would replace the
  // rest of somebody's answer rather than shortening it.
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, "user");
});

/* ── what the reader is told afterwards ───────────────────────────────────── */

test("a turn that still runs out after continuing says so, in its own terms", () => {
  const note = geminiFinishNote("length", { ...STARVED, continued: 2 });
  assert.ok(note);
  assert.match(note, /continued 2 times automatically/);
  // The first request's split describes a third of what the reader is looking
  // at, and "lower the thinking level" points at a lever the continuations have
  // already pulled twice.
  assert.doesNotMatch(note, /Lower the thinking level/);
});

test("the un-continued turn keeps the sentence it had", () => {
  const note = geminiFinishNote("length", { ...STARVED, continued: 0 });
  assert.ok(note);
  assert.match(note, /Lower the thinking level/);
  assert.equal(note, geminiFinishNote("length", STARVED), "absent and zero mean the same thing");
});

test("a continuation that finishes cleanly is not annotated at all", () => {
  // The lesson this adapter already learned once: never print a banner over a
  // complete answer. A resumed reply that ends with STOP is just an answer.
  const decision = decideGeminiFinish({
    lastFinishReason: "STOP",
    sawUsage: true,
    answerTokens: 40_000,
    thoughtTokens: 900,
    maxTokens: 65_536,
    answerTail: "…and that is the last of the four sections.",
    continued: 1,
  });
  assert.equal(decision.reason, "stop");
  assert.equal(decision.note, undefined);
});
