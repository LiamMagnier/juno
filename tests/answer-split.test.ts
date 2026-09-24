import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_COMMENTARY_BYTES,
  commentaryForRound,
  cutPreservedBlocks,
  splitAnswer,
  type TextSegment,
} from "@/lib/chat/answer-split";

/*
 * WHICH TEXT IS THE ANSWER (SPEC §2.8, DECISIONS T6).
 *
 * "Let me check.The answer…" was one string: the text of a round that ended in
 * tool calls glued onto the final answer. The split keeps that text as
 * commentary, keeps every preserved tag in the answer wherever it was written
 * (INV-12), and never loses anything to a cap.
 */

const seg = (round: number, text: string, opts: { phase?: "commentary" | "answer"; tools?: boolean } = {}): TextSegment => ({
  round,
  phase: opts.phase ?? null,
  text,
  endedInTools: opts.tools ?? false,
});

test("text in a round that ended in client tool calls is commentary; the final round is the answer", () => {
  const result = splitAnswer([seg(0, "Let me check.", { tools: true }), seg(1, "The answer is 42.")]);
  assert.equal(result.answer, "The answer is 42.");
  assert.deepEqual(result.commentary, [{ round: 0, text: "Let me check." }]);
});

test("a provider search inside the response never demotes text: both steps are answer, joined by a blank line", () => {
  const result = splitAnswer([seg(0, "Searching the latest figures. "), seg(1, "Sales rose 18%.")]);
  assert.equal(result.answer, "Searching the latest figures.\n\nSales rose 18%.");
  assert.deepEqual(result.commentary, []);
});

test("a declared commentary item and a final_answer item in one round", () => {
  const result = splitAnswer([seg(0, "I'll look that up.", { phase: "commentary" }), seg(0, "It was April.", { phase: "answer" })]);
  assert.equal(result.answer, "It was April.");
  assert.deepEqual(result.commentary, [{ round: 0, text: "I'll look that up." }]);
});

test("a declared answer is answer even in a round that ended in tools", () => {
  const result = splitAnswer([seg(0, "Here is part one.", { phase: "answer", tools: true }), seg(1, "And part two.")]);
  assert.equal(result.answer, "Here is part one.\n\nAnd part two.");
  assert.deepEqual(result.commentary, []);
});

test("commentary over 64 KiB stays in the answer instead: nothing is lost to the cap", () => {
  const long = "x".repeat(MAX_COMMENTARY_BYTES + 1);
  const result = splitAnswer([seg(0, long, { tools: true }), seg(1, "Done.")]);
  assert.equal(result.answer, `${long}\n\nDone.`);
  assert.deepEqual(result.commentary, []);
  assert.equal(commentaryForRound([seg(0, long, { tools: true })], 0), null);
});

test("preserved blocks are cut out of commentary and kept in the answer, in order (INV-12)", () => {
  const memory = "<juno:memory>Prefers metric units</juno:memory>";
  const artifact = '<juno:artifact identifier="plan" type="MARKDOWN" title="Plan">\n# Plan\n</juno:artifact>';
  const wizard = ":::clarification-wizard\n{\"questions\":[]}\n:::";
  const forget = "<juno:forget>old address</juno:forget>";
  const result = splitAnswer([
    seg(0, `Noted. ${memory} Let me draft it. ${artifact}`, { tools: true }),
    seg(1, `A question first. ${wizard}`, { tools: true }),
    seg(2, `Here it is. ${forget}`),
  ]);
  assert.deepEqual(result.commentary, [
    { round: 0, text: "Noted.  Let me draft it." },
    { round: 1, text: "A question first." },
  ]);
  assert.equal(result.answer, `Here it is. ${forget}\n\n${memory}\n\n${artifact}\n\n${wizard}`);
});

test("a commentary round made only of a tag leaves no commentary item, and the tag moves", () => {
  const memory = "<juno:memory>Likes tea</juno:memory>";
  const result = splitAnswer([seg(0, `  ${memory}  `, { tools: true }), seg(1, "Sure.")]);
  assert.deepEqual(result.commentary, []);
  assert.equal(result.answer, `Sure.\n\n${memory}`);
});

test("an unterminated block in a commentary round keeps the whole round as answer", () => {
  const result = splitAnswer([seg(0, 'Drafting <juno:artifact identifier="a" type="CODE" title="A">let', { tools: true }), seg(1, "Done.")]);
  assert.match(result.answer, /<juno:artifact identifier="a"/);
  assert.deepEqual(result.commentary, []);
});

test("fallback: when no round wrote an answer, today's concatenation, and no commentary shown twice", () => {
  const result = splitAnswer([seg(0, "Let me check.", { tools: true }), seg(1, "Still checking.", { tools: true })]);
  assert.equal(result.answer, "Let me check.\n\nStill checking.");
  assert.deepEqual(result.commentary, []);
});

test("content is non-empty whenever any text was produced (INV-12)", () => {
  const cases: TextSegment[][] = [
    [seg(0, "Only commentary.", { tools: true })],
    [seg(0, "x", { phase: "commentary" })],
    [seg(0, "Answer.")],
    [seg(0, "a", { tools: true }), seg(1, " ")],
  ];
  for (const segments of cases) assert.ok(splitAnswer(segments).answer.trim().length > 0, JSON.stringify(segments));
  assert.deepEqual(splitAnswer([]), { answer: "", commentary: [] });
});

test("rounds are joined with one blank line, trimmed at the joins only", () => {
  const result = splitAnswer([seg(0, "  First.  \n"), seg(1, "\n  Second.  ")]);
  assert.equal(result.answer, "  First.\n\nSecond.  ");
});

test("segments of one round are concatenated as they streamed", () => {
  const result = splitAnswer([seg(0, "Hel"), seg(0, "lo", { phase: "answer" })]);
  assert.equal(result.answer, "Hello");
});

test("cutPreservedBlocks keeps the text around blocks and never double-cuts a nested match", () => {
  const artifact = '<juno:artifact identifier="d" type="MARKDOWN" title="Doc">\n:::clarification-wizard\n:::\n</juno:artifact>';
  const { blocks, rest } = cutPreservedBlocks(`before ${artifact} after`);
  assert.deepEqual(blocks, [artifact]);
  assert.equal(rest, "before  after");
});

test("the split module stays free of server-only (harness rule 1)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/answer-split.ts"), "utf8");
  assert.doesNotMatch(source, /^import /m, "pure: no imports at all");
});
