import test from "node:test";
import assert from "node:assert/strict";

import { decideGeminiFinish, geminiAtCap, geminiFinishNote } from "@/lib/gemini-finish";
import { appendFinishWarning } from "@/lib/chat-responses";
import { finishReasonDetail } from "@/lib/finish-reason";

/*
 * `maxOutputTokens` bounds THINKING AND ANSWER TOGETHER on Gemini 3.
 *
 * Reported as: a reply that stopped mid-sentence under "Response hit the token
 * limit", by someone who reasonably read that as Juno capping the model and
 * asked for the cap to be lifted. It is not Juno's cap — Juno already requests
 * Google's own published maximum for this model, 65,536 — and lifting it is not
 * on offer either: an unset max_output_tokens makes Gemini hang with no
 * server-side timeout (googleapis/python-genai#2062).
 *
 * What actually happened is that Gemini 3 spends thinking tokens out of that
 * same 65,536 and expands its thinking to fill nearly all of whatever budget it
 * is given. At HIGH it thought for ~64k and the answer was cut off with ~1.3k
 * left. Google reports the two counts SEPARATELY — `thoughtsTokenCount` and
 * `candidatesTokenCount` — and the adapter compared only the second against the
 * budget, so the one turn that unambiguously exhausted the ceiling read as
 * comfortably under it.
 */

/** The reported turn. 1,270 + 64,266 = 65,536 exactly. */
const REPORTED = {
  lastFinishReason: null,
  sawUsage: true,
  answerTokens: 1_270,
  thoughtTokens: 64_266,
  maxTokens: 65_536,
  answerTail:
    "Here is a high-performance, responsive portfolio designed with an editorial " +
    "aesthetic and an interactive command palette (",
};

test("the reported turn is at the cap once thinking is counted", () => {
  assert.equal(
    geminiAtCap(REPORTED),
    true,
    "1,270 answer tokens + 64,266 thinking tokens IS the 65,536 ceiling — reading the answer count alone called this a finished reply",
  );
  // The old rule, kept as the thing that must never come back.
  assert.equal(REPORTED.answerTokens >= REPORTED.maxTokens - 32, false);
});

test("the cap is not reached by an answer that had room left", () => {
  assert.equal(geminiAtCap({ ...REPORTED, answerTokens: 400, thoughtTokens: 900 }), false);
  // No usage frame means no numbers, and no numbers is not evidence of a cap.
  assert.equal(geminiAtCap({ ...REPORTED, sawUsage: false }), false);
  // Both counts zero is a turn that produced nothing, not a turn at its ceiling.
  assert.equal(geminiAtCap({ ...REPORTED, answerTokens: 0, thoughtTokens: 0 }), false);
});

test("the reader is told thinking took the budget, not just that a limit was hit", () => {
  const decision = decideGeminiFinish(REPORTED);
  assert.equal(decision.reason, "length");
  assert.ok(decision.note, "no note: the reader gets 'Use Continue', which resumes into the same budget");
  // Every number needed to act, and the lever that actually works.
  assert.match(decision.note!, /64,266/);
  assert.match(decision.note!, /65,536/);
  assert.match(decision.note!, /1,270/);
  assert.match(decision.note!, /thinking level/i);
});

test("an answer that was simply long gets no thinking note", () => {
  // At the cap, but thinking was a rounding error — this really is "the reply
  // ran out of room", and Continue is the right advice. A note here would blame
  // the thinking level for something it did not do.
  const decision = decideGeminiFinish({
    ...REPORTED,
    answerTokens: 65_000,
    thoughtTokens: 536,
    answerTail: "…and the last thing to note is that",
  });
  assert.equal(decision.reason, "length");
  assert.equal(decision.note, undefined);
});

test("Google's own MAX_TOKENS still carries the thinking note", () => {
  // The provider naming the reason does not make the reason useful.
  const decision = decideGeminiFinish({ ...REPORTED, lastFinishReason: "MAX_TOKENS" });
  assert.equal(decision.reason, "length");
  assert.equal(decision.decidedOnEvidence, false);
  assert.match(decision.note ?? "", /Thinking used 64,266/);
});

test("a finished answer stays finished, however long it thought", () => {
  const decision = decideGeminiFinish({
    ...REPORTED,
    lastFinishReason: "STOP",
    answerTail: "That should do it.",
  });
  assert.equal(decision.reason, "stop");
  assert.equal(decision.note, undefined, "a note under a finished answer is an alarm with nothing behind it");
});

test("a safety stop is never relabelled as a token limit", () => {
  // Thinking dominance is not a licence to overwrite what the provider said.
  const decision = decideGeminiFinish({ ...REPORTED, lastFinishReason: "PROHIBITED_CONTENT" });
  assert.equal(decision.reason, "sensitive");
  assert.equal(decision.note, undefined);
});

test("no terminal frame, no cap, but visibly cut prose is still `length`", () => {
  // The earlier fix, kept working: the cap is not the only way an answer is cut.
  const decision = decideGeminiFinish({
    ...REPORTED,
    answerTokens: 300,
    thoughtTokens: 100,
    answerTail: "Options include A, B,",
  });
  assert.equal(decision.atCap, false);
  assert.equal(decision.truncated, true);
  assert.equal(decision.reason, "length");
  assert.equal(decision.note, undefined, "thinking was 100 tokens — it did not eat anything");
});

test("no terminal frame and prose that ends properly is a finished answer", () => {
  const decision = decideGeminiFinish({
    ...REPORTED,
    answerTokens: 300,
    thoughtTokens: 100,
    answerTail: "That should do it.",
  });
  assert.equal(decision.reason, "stop");
  assert.equal(decision.decidedOnEvidence, true);
});

test("the note is withheld when there are no counts to quote", () => {
  assert.equal(geminiFinishNote("length", { ...REPORTED, sawUsage: false }), undefined);
});

test("the warning shows the adapter's sentence instead of the generic one", () => {
  const sent: Array<{ title: string; detail?: string }> = [];
  const sink = ((event: { kind: string; title: string; detail?: string }) => {
    sent.push({ title: event.title, detail: event.detail });
    return event;
  }) as never;

  const note = decideGeminiFinish(REPORTED).note!;
  appendFinishWarning("length", sink, note);
  assert.equal(sent[0].detail, note);
  assert.equal(sent[0].title, "Response hit the token limit");

  // …and falls back when the adapter has nothing to add.
  appendFinishWarning("length", sink, null);
  assert.equal(sent[1].detail, finishReasonDetail("length"));

  // A blank note is not a note.
  appendFinishWarning("length", sink, "   ");
  assert.equal(sent[2].detail, finishReasonDetail("length"));

  // A finished turn still warns about nothing.
  appendFinishWarning("stop", sink, "ignored");
  assert.equal(sent.length, 3);
});
