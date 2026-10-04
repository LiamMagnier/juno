import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MIN_VERBATIM,
  HISTORY_TOKEN_TARGET,
  IMAGE_TOKEN_ESTIMATE,
  SUMMARY_INPUT_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  estimateMessageTokens,
  historySummaryUserMessage,
  historyTokenBudget,
  parseHistorySummary,
  planHistorySummary,
  planTokenTrim,
  renderHistorySummary,
  type WindowMessage,
} from "@/lib/chat/history-compaction";
import { HISTORY_STEP } from "@/lib/chat/context-assembly";

/** A conversation of `n` alternating messages, each `chars` long. */
function conversation(n: number, chars: number, from = 0): WindowMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${from + i}`,
    role: (from + i) % 2 === 0 ? "USER" : "ASSISTANT",
    content: "x".repeat(chars),
  }));
}

test("the budget is the smaller of 60K tokens and 40% of the model's window, with a floor", () => {
  assert.equal(historyTokenBudget(1_000_000), HISTORY_TOKEN_TARGET);
  assert.equal(historyTokenBudget(128_000), 51_200);
  assert.equal(historyTokenBudget(8_000), 8_000);
  assert.equal(historyTokenBudget(undefined), 51_200);
});

test("message estimates count attachment text (capped) and images", () => {
  const m: WindowMessage = {
    id: "a",
    role: "USER",
    content: "x".repeat(400),
    attachments: [
      { kind: "FILE", extractedText: "y".repeat(40_000) },
      { kind: "IMAGE" },
    ],
  };
  assert.equal(estimateMessageTokens(m), 100 + 10_000 + IMAGE_TOKEN_ESTIMATE);
  assert.equal(estimateMessageTokens(m, 4_000), 100 + 1_000 + IMAGE_TOKEN_ESTIMATE);
});

test("a window under budget is left alone", () => {
  assert.equal(planTokenTrim(conversation(24, 400), { budgetTokens: 60_000 }), 0);
});

test("an over-budget window drops whole HISTORY_STEP blocks from the front and opens on a user turn", () => {
  // 24 messages × 20K chars = 120K tokens against a 60K budget.
  const window = conversation(24, 20_000);
  const drop = planTokenTrim(window, { budgetTokens: 60_000 });
  assert.equal(drop % HISTORY_STEP, 0);
  assert.equal(drop, 16); // 8 left = 40K tokens; 16 left would be 80K
  assert.equal(window[drop].role, "USER");
});

test("the newest messages always stay verbatim, however heavy", () => {
  const window = conversation(12, 400_000); // each message alone is over budget
  const drop = planTokenTrim(window, { budgetTokens: 60_000 });
  assert.ok(window.length - drop >= HISTORY_MIN_VERBATIM - 1);
  assert.equal(drop % HISTORY_STEP, 0);
});

test("the cut is stable while the conversation grows between steps (cache-friendly)", () => {
  const drops = new Set<number>();
  for (let extra = 0; extra < 4; extra += 1) {
    // Two messages a turn: the cut must not move one message per turn.
    drops.add(planTokenTrim(conversation(24 + extra * 2, 6_000), { budgetTokens: 30_000 }));
  }
  assert.ok(drops.size <= 2, `cut moved ${drops.size} times in 4 turns: ${[...drops]}`);
  for (const drop of drops) assert.equal(drop % HISTORY_STEP, 0);
});

test("a recent user message with files is never trimmed away", () => {
  const window = conversation(24, 20_000);
  window[14] = { ...window[14], attachments: [{ kind: "FILE", extractedText: "report" }] }; // a USER row (even index)
  const drop = planTokenTrim(window, { budgetTokens: 10_000 });
  assert.ok(drop <= 14, `dropped past the attachment: ${drop}`);
});

test("summary plan: nothing outside the window means no summary", () => {
  assert.deepEqual(planHistorySummary({ stored: null, start: 0, windowFirstId: "m0" }), { action: "none" });
});

test("summary plan: a stored summary that ends where the window starts is reused byte for byte", () => {
  const stored = { text: "- The user is planning a trip.", coveredCount: 16, untilMessageId: "m16" };
  assert.deepEqual(planHistorySummary({ stored, start: 16, windowFirstId: "m16" }), { action: "reuse" });
});

test("summary plan: a window that moved extends the summary incrementally", () => {
  const stored = { text: "- earlier", coveredCount: 16, untilMessageId: "m16" };
  assert.deepEqual(planHistorySummary({ stored, start: 24, windowFirstId: "m24" }), {
    action: "extend",
    fromCount: 16,
    toCount: 24,
    previous: "- earlier",
  });
});

test("summary plan: a summary past the window (history deleted) is rebuilt from the start", () => {
  const stored = { text: "- earlier", coveredCount: 32, untilMessageId: "m32" };
  assert.deepEqual(planHistorySummary({ stored, start: 24, windowFirstId: "m24" }), {
    action: "extend",
    fromCount: 0,
    toCount: 24,
    previous: null,
  });
});

test("the summarizer reads the previous summary then the departing messages, newest kept when long", () => {
  const msg = historySummaryUserMessage("- old summary", [
    { role: "USER", content: "first question" },
    { role: "ASSISTANT", content: "first answer" },
    { role: "SYSTEM", content: "ignored" },
  ]);
  assert.match(msg, /^PREVIOUS SUMMARY:\n- old summary/);
  assert.match(msg, /User: first question\n\nAssistant: first answer/);
  assert.doesNotMatch(msg, /ignored/);

  const long = historySummaryUserMessage(null, conversation(100, 3_000).map(({ role, content }) => ({ role, content })));
  assert.ok(long.length <= SUMMARY_INPUT_MAX_CHARS + 200);
  assert.match(long, /older messages omitted for length/);
});

test("the summary reply is cleaned and bounded", () => {
  assert.equal(parseHistorySummary("short"), null);
  assert.equal(parseHistorySummary("```markdown\n- The user wants a budget spreadsheet.\n```"), "- The user wants a budget spreadsheet.");
  const huge = parseHistorySummary("- ".concat("z".repeat(SUMMARY_MAX_CHARS * 2)));
  assert.ok(huge && huge.length <= SUMMARY_MAX_CHARS);
});

test("the rendered summary is deterministic in its inputs, so the cached prefix holds between jumps", () => {
  const a = renderHistorySummary("- The user is building Pantry.", 16);
  const b = renderHistorySummary("- The user is building Pantry.", 16);
  assert.equal(a, b);
  assert.match(a, /16 earliest messages/);
  assert.match(a, /did not write it/);
});
