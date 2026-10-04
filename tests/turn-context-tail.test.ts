import test from "node:test";
import assert from "node:assert/strict";
import { appendVolatileTail, buildTurnContextTail, TURN_CONTEXT_HEADING } from "@/lib/chat/turn-context-tail";
import { appendToLastUserTurn } from "@/lib/chat/context-resolution";
import { splitVolatileTail } from "@/lib/anthropic-cache";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";

type Row = { role: string; content: string; volatileTail?: string };

const empty = { memoryNotes: [], memoryScope: "account" as const, hasMemorySummary: false, retrieved: "", references: "" };

test("a plain turn adds nothing", () => {
  assert.equal(buildTurnContextTail(empty), "");
  const history = [{ role: "USER", content: "hi" }];
  assert.deepEqual(appendVolatileTail(history, ""), history);
});

test("a turn that only names references sends the bytes it always did", () => {
  const references = "# Referenced in this message\nThe user named these…";
  const tail = buildTurnContextTail({ ...empty, references });
  assert.equal(tail, references);
  const history: Row[] = [
    { role: "USER", content: "first" },
    { role: "ASSISTANT", content: "answer" },
    { role: "USER", content: "second" },
  ];
  const withTail = appendVolatileTail(history, tail);
  assert.deepEqual(
    withTail.map(({ role, content }) => ({ role, content })),
    appendToLastUserTurn(history, references)
  );
  assert.equal(withTail[2].volatileTail, references);
});

test("ranked memory notes and retrieved extracts are framed as this reply's context", () => {
  const tail = buildTurnContextTail({
    ...empty,
    memoryNotes: ["The user prefers TypeScript.", "  "],
    hasMemorySummary: true,
    retrieved: "## Retrieved from project documents\n### a.pdf · page 2\n<<<passage>>>",
  });
  assert.ok(tail.startsWith(TURN_CONTEXT_HEADING));
  assert.match(tail, /did not write it/);
  assert.match(tail, /newer than the summary/);
  assert.match(tail, /- The user prefers TypeScript\./);
  assert.match(tail, /Retrieved from project documents/);
  assert.doesNotMatch(tail, /- \s*$/m);
});

test("the tail is recorded so the Anthropic adapter can keep the cache marker in front of it", () => {
  const tail = buildTurnContextTail({ ...empty, memoryNotes: ["Lives in Lyon."] });
  const [message] = appendVolatileTail([{ role: "USER", content: "where should I eat?" }], tail);
  assert.deepEqual(splitVolatileTail(message), { own: "where should I eat?", tail });
});

test("only the newest user turn carries it, and the history before it is byte-identical", () => {
  const history: Row[] = [
    { role: "USER", content: "one" },
    { role: "ASSISTANT", content: "two" },
    { role: "USER", content: "three" },
  ];
  const a = appendVolatileTail(history, buildTurnContextTail({ ...empty, memoryNotes: ["fact A"] }));
  const b = appendVolatileTail(history, buildTurnContextTail({ ...empty, memoryNotes: ["fact B", "fact C"] }));
  assert.deepEqual(a.slice(0, 2), b.slice(0, 2));
  assert.equal(a[0].volatileTail, undefined);
});

test("the cached system prompt no longer moves when the ranked notes do", () => {
  const base = { memoryEnabled: true, canvas: true, memorySummary: "Works as a nurse.", memories: [] as string[] };
  const one = buildSystemPromptSections(base);
  const two = buildSystemPromptSections({ ...base });
  assert.equal(one.variable, two.variable);
  assert.doesNotMatch(one.variable, /Recent notes/);
});
