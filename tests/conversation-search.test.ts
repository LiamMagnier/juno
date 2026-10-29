import test from "node:test";
import assert from "node:assert/strict";
import {
  findInConversation,
  matchedMessageIds,
  searchConversation,
  selectedMatchIndex,
  stepMatch,
  type SearchableMessage,
} from "@/lib/conversation-search";

const thread: SearchableMessage[] = [
  { id: "m1", role: "USER", content: "How does the Prisma ownership guard work?" },
  { id: "m2", role: "ASSISTANT", content: "The guard inspects the where clause.\nEvery guard is per-model." },
  { id: "m3", role: "USER", content: "thanks" },
];

test("finds every occurrence in reading order", () => {
  const matches = findInConversation(thread, "guard");
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((m) => m.messageId), ["m1", "m2", "m2"]);
});

test("matching is case-insensitive", () => {
  assert.equal(findInConversation(thread, "PRISMA").length, 1);
  assert.equal(findInConversation(thread, "prisma").length, 1);
});

test("a query is literal text, not a pattern", () => {
  // A user typing punctuation into a find box means those characters. Treating
  // them as regex syntax would either throw or match the wrong thing.
  const messages = [{ id: "a", role: "USER", content: "cost is $0.42 (approx) [see docs] a+b" }];
  for (const q of ["$0.42", "(approx)", "[see docs]", "a+b", "."]) {
    assert.ok(findInConversation(messages, q).length > 0, `${q} should match literally`);
  }
  assert.equal(findInConversation(messages, "a.b").length, 0, "'.' must not match any char");
});

test("an empty or whitespace query matches nothing", () => {
  for (const q of ["", "   ", "\n\t"]) {
    assert.deepEqual(findInConversation(thread, q), []);
  }
});

test("overlapping occurrences terminate", () => {
  // "aa" in "aaaa" — a naive scanner that advanced by one would loop or
  // over-report; advancing past the match is what bounds it.
  const messages = [{ id: "a", role: "USER", content: "aaaa" }];
  const matches = findInConversation(messages, "aa");
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.start), [0, 2]);
});

test("the preview carries the match and points at it", () => {
  const long = "x".repeat(200) + "NEEDLE" + "y".repeat(200);
  const [match] = findInConversation([{ id: "a", role: "USER", content: long }], "needle");
  assert.ok(match.preview.includes("NEEDLE"), "preview must contain the match");
  assert.equal(
    match.preview.slice(match.previewStart, match.previewEnd),
    "NEEDLE",
    "the preview offsets must select the match, so highlighting lands on it"
  );
  assert.ok(match.preview.startsWith("…") && match.preview.endsWith("…"), "elided on both sides");
  assert.ok(match.preview.length < 140, "a preview is a line, not the message");
});

test("a match spanning a line break still reads as one line", () => {
  const [match] = findInConversation(
    [{ id: "a", role: "USER", content: "the\nguard\nworks" }],
    "guard"
  );
  assert.doesNotMatch(match.preview, /\n/);
  assert.equal(match.preview.slice(match.previewStart, match.previewEnd), "guard");
});

test("offsets index the original content, so a jump can scroll to it", () => {
  const [match] = findInConversation(thread, "Prisma");
  assert.equal(thread[0].content.slice(match.start, match.end), "Prisma");
});

test("results are capped so a common word cannot hang the UI", () => {
  const messages = [{ id: "a", role: "USER", content: "e ".repeat(5_000) }];
  assert.equal(findInConversation(messages, "e", { limit: 100 }).length, 100);
});

test("matched messages are deduplicated but keep their order", () => {
  assert.deepEqual(matchedMessageIds(findInConversation(thread, "guard")), ["m1", "m2"]);
});

test("stepping through matches wraps at both ends", () => {
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0, "forward from the last wraps to the first");
  assert.equal(stepMatch(0, 3, -1), 2, "back from the first wraps to the last");
  assert.equal(stepMatch(0, 0, 1), 0, "no matches is not a division by zero");
});

test("messages with no content are skipped safely", () => {
  const messages = [
    { id: "a", role: "ASSISTANT", content: "" },
    { id: "b", role: "USER", content: "found" },
  ];
  assert.deepEqual(findInConversation(messages, "found").map((m) => m.messageId), ["b"]);
});

test("a Unicode case expansion before a hit cannot move its source offsets", () => {
  const content = "İstanbul: the NEEDLE is here. 😀 Another needle.";
  const matches = findInConversation([{ id: "a", role: "USER", content }], "needle");
  assert.equal(matches.length, 2);
  for (const match of matches) {
    assert.equal(content.slice(match.start, match.end).toLowerCase(), "needle");
    assert.equal(match.preview.slice(match.previewStart, match.previewEnd), content.slice(match.start, match.end));
  }
});

test("literal search preserves Unicode characters and every regex metacharacter", () => {
  const content = "Find [a-z]+? ^x$ (a|b) {2} path\\file. Café CAFÉ 😀.";
  for (const query of ["[a-z]+?", "^x$", "(a|b)", "{2}", "path\\file", "café", "😀"]) {
    const matches = findInConversation([{ id: "a", role: "USER", content }], query);
    assert.equal(matches.length, query === "café" ? 2 : 1);
    assert.equal(content.slice(matches[0].start, matches[0].end).toLowerCase(), query.toLowerCase());
  }
});

test("an exact cap is distinguished from additional results", () => {
  const messages = [{ id: "a", role: "USER", content: "needle ".repeat(500) }];
  const exact = searchConversation(messages, "needle");
  assert.equal(exact.matches.length, 500);
  assert.equal(exact.truncated, false);
  const extra = searchConversation([...messages, { id: "b", role: "ASSISTANT", content: "one more needle" }], "needle");
  assert.equal(extra.matches.length, 500);
  assert.equal(extra.truncated, true);
});

test("invalid or empty result budgets cannot produce an unbounded scan", () => {
  const messages = [{ id: "a", role: "USER", content: "needle ".repeat(600) }];
  for (const limit of [0, -1]) assert.deepEqual(searchConversation(messages, "needle", { limit }), { matches: [], truncated: false });
  assert.equal(searchConversation(messages, "needle", { limit: Infinity }).matches.length, 500);
  assert.equal(searchConversation(messages, "needle", { limit: 2.9 }).matches.length, 2);
});

test("selection follows the same occurrence when older history is prepended", () => {
  const matches = findInConversation(thread, "guard");
  const selection = { ...matches[2], index: 2 };
  const expanded = findInConversation([{ id: "older", role: "USER", content: "An earlier guard" }, ...thread], "guard");
  const index = selectedMatchIndex(expanded, selection);
  assert.equal(index, 3);
  assert.equal(expanded[index].messageId, selection.messageId);
  assert.equal(expanded[index].start, selection.start, "two occurrences in one message remain distinct");
});

test("selection stays in bounds after a branch or edit removes matches", () => {
  const matches = findInConversation(thread, "guard");
  const selection = { ...matches[2], index: 2 };
  assert.equal(selectedMatchIndex(matches.slice(0, 1), selection), 0);
  assert.equal(selectedMatchIndex([], selection), 0);
  assert.equal(selectedMatchIndex(matches, null), 0);
  assert.equal(stepMatch(499, 2, -1), 0, "navigation clamps the previous index before stepping");
});
