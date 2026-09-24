import test from "node:test";
import assert from "node:assert/strict";
import { toReasoningLines } from "@/lib/reasoning-lines";
import { appendReasoningDelta, emptyReasoning, type ReasoningState } from "@/lib/reasoning-parts";

/*
 * The rule this file exists to defend: `toReasoningLines` may WRAP a trace, and
 * may never INVENT a boundary in it.
 *
 * `reasoning-parts.ts` is explicit that a step boundary is a fact carried from
 * the wire — OpenAI's Responses API announces each summary part, and Anthropic,
 * Zhipu, Mistral and Google do not. The AIcss viewport needs lines regardless, so
 * this splits on boundaries the model itself wrote (its blank lines) and, only
 * then, on sentence ends inside a paragraph too long to read two lines at a time.
 * The tests below pin both halves of that: parts are used verbatim, and prose is
 * never split on anything the model did not put there.
 */

test("provider parts become one line each, in order", () => {
  const lines = toReasoningLines("flattened text nobody should read here", [
    "**Reading the middleware**\nThe verify call sets no allowlist.",
    "**Pinning the algorithm**\nHS256, plus issuer and audience checks.",
  ]);
  assert.deepEqual(lines, ["Reading the middleware", "Pinning the algorithm"]);
});

test("a part with no bold title falls back to its own opening line", () => {
  const lines = toReasoningLines(null, ["Tracing where the secret is loaded from.\nThen confirming it never leaks."]);
  assert.deepEqual(lines, ["Tracing where the secret is loaded from."]);
});

test("a title-only part is a line — they are real and common", () => {
  const lines = toReasoningLines(null, ["**Designing high-traffic caching**"]);
  assert.deepEqual(lines, ["Designing high-traffic caching"]);
});

test("empty parts are dropped rather than rendered as blank slots", () => {
  const lines = toReasoningLines(null, ["**First**", "   ", "", "**Second**"]);
  assert.deepEqual(lines, ["First", "Second"]);
});

test("with no parts, the model's own blank lines are the boundaries", () => {
  const lines = toReasoningLines("First thought.\n\nSecond thought.\n\n\nThird thought.");
  assert.deepEqual(lines, ["First thought.", "Second thought.", "Third thought."]);
});

test("a single-newline break is NOT a boundary — it is a wrap in the model's prose", () => {
  const lines = toReasoningLines("One clause\nand its continuation.");
  assert.deepEqual(lines, ["One clause and its continuation."]);
});

test("a short paragraph is never split, however many sentences it holds", () => {
  const short = "One. Two. Three. Four.";
  assert.deepEqual(toReasoningLines(short), [short]);
});

test("a long paragraph is wrapped at sentence ends, losing no text", () => {
  const sentence = "This clause is long enough on its own to matter to the wrapper. ";
  const paragraph = sentence.repeat(4).trim();
  const lines = toReasoningLines(paragraph);
  assert.ok(lines.length > 1, "a 260-character paragraph should wrap");
  // Every wrap point is a sentence end the model wrote, so rejoining restores
  // the paragraph exactly. This is the property that makes it a wrap and not an
  // edit.
  assert.equal(lines.join(" "), paragraph);
  for (const line of lines) {
    assert.ok(/[.!?…]$/.test(line), `line does not end at a sentence: ${line}`);
  }
});

test("one oversized sentence gets a line of its own rather than being cut", () => {
  const monster = `${"word ".repeat(60).trim()}.`;
  const lines = toReasoningLines(monster);
  assert.deepEqual(lines, [monster]);
});

test("no trace is no lines — never a placeholder", () => {
  assert.deepEqual(toReasoningLines(null), []);
  assert.deepEqual(toReasoningLines(""), []);
  assert.deepEqual(toReasoningLines("   \n\n  "), []);
  assert.deepEqual(toReasoningLines(undefined, []), []);
});

test("parts win over the flat text, so the two can never disagree", () => {
  // The flat text is the parts run together (see appendReasoningDelta), so
  // reading it when parts exist would double every line.
  const lines = toReasoningLines("**A**\nbody\n\n**B**\nbody", ["**A**\nbody", "**B**\nbody"]);
  assert.deepEqual(lines, ["A", "B"]);
});

// ── Rounds (SPEC §2.11) ──────────────────────────────────────────────────────

const fold = (deltas: Array<[string, number | undefined, number | undefined]>): ReasoningState =>
  deltas.reduce((state, [text, part, round]) => appendReasoningDelta(state, text, part, round), emptyReasoning());

test("thinking before and after a tool call is two passages, never glued", () => {
  const state = fold([
    ["I need the page.", undefined, 0],
    [" Fetching it.", undefined, 0],
    ["Now that I have it, summarise.", undefined, 1],
  ]);
  assert.equal(state.text, "I need the page. Fetching it.\n\nNow that I have it, summarise.");
  assert.deepEqual(state.parts, [], "a round boundary is not a declared part");
  assert.deepEqual(toReasoningLines(state.text), ["I need the page. Fetching it.", "Now that I have it, summarise."]);
});

test("a round boundary and a part boundary at once give one blank line, not two", () => {
  const state = fold([
    ["**One**", 0, 0],
    ["**Two**", 1, 1],
  ]);
  assert.equal(state.text, "**One**\n\n**Two**");
  assert.deepEqual(state.parts, ["**One**", "**Two**"]);
});

test("deltas with no round fold exactly as before the rework", () => {
  const state = fold([
    ["a", undefined, undefined],
    ["b", undefined, undefined],
  ]);
  assert.equal(state.text, "ab");
  const legacy: ReasoningState = { text: "x", parts: [], lastPart: null };
  assert.equal(appendReasoningDelta(legacy, "y", undefined, 3).text, "xy", "a state from before rounds has no round to differ from");
});
