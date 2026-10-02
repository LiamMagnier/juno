import assert from "node:assert/strict";
import test from "node:test";

import {
  answerStarted,
  classifyRounds,
  heldCommentary,
  isHeldRound,
  liveAnswerText,
  nextPeekState,
  type HoldInput,
  type PeekState,
} from "@/lib/run/provisional-text";

/*
 * The provisional hold (SPEC §7.3): a round's text is held until the client
 * can tell a preamble ("Let me look that up.") from the answer, so the
 * preamble never renders as answer text and then jumps.
 */

function hold(extra: Partial<HoldInput>): HoldInput {
  return {
    rounds: [],
    toolsOffered: true,
    callRounds: new Set(),
    streaming: true,
    firstSeenAt: new Map(),
    now: 0,
    verdicts: {},
    ...extra,
  };
}

test("a call for the round within the hold makes it commentary", () => {
  const rounds = [{ round: 0, text: "Let me look that up." }];
  const held = classifyRounds(hold({ rounds, firstSeenAt: new Map([[0, 0]]), now: 200 }));
  assert.deepEqual(held.verdicts, {}, "still held");
  assert.equal(held.nextCheckAt, 600, "look again when the 600 ms expire");
  const called = classifyRounds(hold({ rounds, firstSeenAt: new Map([[0, 0]]), now: 300, callRounds: new Set([0]) }));
  assert.deepEqual(called.verdicts, { 0: "commentary" });
  assert.equal(called.nextCheckAt, null);
  assert.equal(answerStarted(called.verdicts), false);
  assert.deepEqual(heldCommentary(rounds, called.verdicts), [{ round: 0, text: "Let me look that up." }]);
});

test("600 ms, 280 characters or a paragraph break release the round as answer", () => {
  const seen = new Map([[0, 0]]);
  assert.deepEqual(classifyRounds(hold({ rounds: [{ round: 0, text: "Paris." }], firstSeenAt: seen, now: 599 })).verdicts, {});
  assert.deepEqual(classifyRounds(hold({ rounds: [{ round: 0, text: "Paris." }], firstSeenAt: seen, now: 600 })).verdicts, { 0: "answer" });
  assert.deepEqual(
    classifyRounds(hold({ rounds: [{ round: 0, text: "x".repeat(281) }], firstSeenAt: seen, now: 10 })).verdicts,
    { 0: "answer" },
  );
  assert.deepEqual(
    classifyRounds(hold({ rounds: [{ round: 0, text: "Short.\n\nSecond paragraph" }], firstSeenAt: seen, now: 10 })).verdicts,
    { 0: "answer" },
  );
});

test("the stream ending, or a later round starting without a call, releases it as answer", () => {
  const rounds = [{ round: 0, text: "Hm." }];
  assert.deepEqual(classifyRounds(hold({ rounds, streaming: false, now: 1 })).verdicts, { 0: "answer" });
  // An in-response provider search moved to round 1 without a client call: never demotes text (§2.8 rule 1).
  const next = [...rounds, { round: 1, text: "More." }];
  assert.equal(classifyRounds(hold({ rounds: next, firstSeenAt: new Map([[0, 0], [1, 5]]), now: 10 })).verdicts[0], "answer");
});

test("no hold with a declared phase or without offered tools", () => {
  assert.equal(isHeldRound({ phase: "answer" }, true), false);
  assert.equal(isHeldRound({ phase: "commentary" }, true), false);
  assert.equal(isHeldRound({}, false), false);
  assert.equal(isHeldRound({}, true), true);
  assert.deepEqual(
    classifyRounds(hold({ rounds: [{ round: 0, text: "Answer", phase: "answer" }], now: 0 })).verdicts,
    { 0: "answer" },
  );
  assert.deepEqual(classifyRounds(hold({ rounds: [{ round: 0, text: "Answer" }], toolsOffered: false, now: 0 })).verdicts, {
    0: "answer",
  });
  // Declared commentary never enters the answer area and is never "held commentary" either.
  const declared = [{ round: 0, text: "I'll search.", phase: "commentary" as const }];
  const verdicts = classifyRounds(hold({ rounds: declared, now: 0 })).verdicts;
  assert.equal(answerStarted(verdicts), false);
  assert.deepEqual(heldCommentary(declared, { 0: "commentary" }), []);
});

test("verdicts are sticky and returned by identity when nothing changed", () => {
  const rounds = [{ round: 0, text: "Paris." }];
  const verdicts = { 0: "answer" as const };
  const again = classifyRounds(hold({ rounds, verdicts, callRounds: new Set([0]), now: 5 }));
  assert.equal(again.verdicts, verdicts, "a late call does not demote an answer; the server moves it instead");
});

test("the answer area renders only released rounds, and only once the peek is out of the way", () => {
  const message = {
    content: "Let me check.The answer.",
    liveRounds: [
      { round: 0, text: "Let me check." },
      { round: 1, text: "The answer." },
    ],
  };
  const verdicts = { 0: "commentary" as const, 1: "answer" as const };
  assert.equal(liveAnswerText(message, { verdicts, revealed: false }), "", "held until the collapse ends");
  assert.equal(liveAnswerText(message, { verdicts, revealed: true }), "The answer.");
  assert.equal(
    liveAnswerText(
      { content: "", liveRounds: [{ round: 0, text: "One." }, { round: 2, text: "Two." }] },
      { verdicts: { 0: "answer", 2: "answer" }, revealed: true },
    ),
    "One.\n\nTwo.",
    "rounds joined like the persisted answer",
  );
  assert.equal(liveAnswerText({ content: "Profile 1 text" }, null), "Profile 1 text", "no liveRounds: content as is");
});

test("the peek opens once, collapses at the first answer text, and never reopens", () => {
  const step = (state: PeekState, input: Partial<Parameters<typeof nextPeekState>[1]>) =>
    nextPeekState(state, { streaming: true, hasStep: false, answerStarted: false, ...input });
  assert.equal(step("closed", {}), "closed", "nothing to show yet");
  assert.equal(step("closed", { hasStep: true }), "open");
  assert.equal(step("closed", { hasStep: true, answerStarted: true }), "closed", "never opens once text has begun");
  assert.equal(step("open", { hasStep: true }), "open");
  assert.equal(step("open", { hasStep: true, answerStarted: true }), "collapsed");
  assert.equal(step("open", { hasStep: true, streaming: false }), "collapsed", "Stop or failure before any text");
  // Re-entry: a tool after the answer began changes the line only.
  assert.equal(step("collapsed", { hasStep: true, answerStarted: false }), "collapsed");
});
