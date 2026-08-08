import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHiddenUserContent,
  buildAttachmentContext,
  buildPrivateHistory,
  buildProjectContext,
  contextActivityDetail,
  historyWindowStart,
  HISTORY_LIMIT,
  HISTORY_STEP,
  promptChars,
  replaceLastUserTurn,
} from "@/lib/chat/context-assembly";
import { composeSystemPrompt, SELECTION_ANCHOR_NUDGE, WEB_SEARCH_NUDGE } from "@/lib/chat/prompt-sections";
import type { MessageForModel } from "@/types/llm";

/*
 * Characterisation tests for context assembly — everything the model is shown,
 * decided before a provider is called.
 */

const turn = (role: "USER" | "ASSISTANT", content: string): MessageForModel => ({
  role,
  content,
  attachments: [],
});

test("a short conversation is sent whole", () => {
  assert.equal(historyWindowStart(0), 0);
  assert.equal(historyWindowStart(HISTORY_LIMIT), 0);
});

test("the window start is anchored to blocks, so the prompt prefix survives a turn", () => {
  // This is the whole reason chunked truncation exists. A per-turn sliding
  // window shifts the prefix on every request and defeats provider-side
  // implicit prompt caching; anchoring means HISTORY_STEP consecutive turns
  // send a byte-identical prefix.
  const starts = new Set<number>();
  for (let total = HISTORY_LIMIT; total <= HISTORY_LIMIT + HISTORY_STEP - 1; total++) {
    starts.add(historyWindowStart(total));
  }
  assert.deepEqual([...starts], [0]);
  // And the next message after that run advances by exactly one block.
  assert.equal(historyWindowStart(HISTORY_LIMIT + HISTORY_STEP), HISTORY_STEP);
});

test("the window holds between the limit and limit + step - 1 messages", () => {
  for (let total = 0; total <= 200; total++) {
    const start = historyWindowStart(total);
    const kept = total - start;
    assert.ok(start % HISTORY_STEP === 0, `start ${start} is not block-aligned`);
    assert.ok(kept >= Math.min(total, HISTORY_LIMIT), `dropped below the limit at ${total}`);
    assert.ok(kept <= HISTORY_LIMIT + HISTORY_STEP - 1, `kept ${kept} at ${total}`);
  }
});

test("private history is trimmed, blank turns dropped, and capped at the limit", () => {
  // Client-supplied and never stored, so it is normalised rather than trusted.
  const built = buildPrivateHistory([
    { role: "USER", content: "  hello  " },
    { role: "ASSISTANT", content: "   " },
    { role: "USER", content: "again" },
  ]);
  assert.deepEqual(built.map((m) => m.content), ["hello", "again"]);
  assert.deepEqual(built[0].attachments, []);

  const long = buildPrivateHistory(
    Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => ({ role: "USER" as const, content: `m${i}` }))
  );
  assert.equal(long.length, HISTORY_LIMIT);
  // The most recent turns are the ones kept.
  assert.equal(long.at(-1)?.content, `m${HISTORY_LIMIT + 9}`);
});

test("undefined private history is an empty history, not a crash", () => {
  assert.deepEqual(buildPrivateHistory(undefined), []);
});

test("a clarification reply rewrites only the most recent user turn", () => {
  const history = [turn("USER", "first"), turn("ASSISTANT", "reply"), turn("USER", "second")];
  const next = replaceLastUserTurn(history, "DIRECTIVE");

  assert.deepEqual(next.map((m) => m.content), ["first", "reply", "DIRECTIVE"]);
  // The caller's array is untouched — the route reads the original for other
  // purposes on the same request.
  assert.deepEqual(history.map((m) => m.content), ["first", "reply", "second"]);
});

test("replacing the last user turn is a no-op when there is no user turn", () => {
  const history = [turn("ASSISTANT", "hello")];
  assert.deepEqual(replaceLastUserTurn(history, "x").map((m) => m.content), ["hello"]);
});

test("hidden model content diverges from what the user sees, for one turn only", () => {
  const history = [
    { id: "a", content: "visible answers" },
    { id: "b", content: "other" },
  ];
  const next = applyHiddenUserContent(history, "a", "model directive");

  assert.deepEqual(next.map((m) => m.content), ["model directive", "other"]);
  // Nothing is written back: a reload shows the visible text.
  assert.equal(history[0].content, "visible answers");
});

test("no hidden content, or no message to attach it to, leaves history alone", () => {
  const history = [{ id: "a", content: "visible" }];
  assert.deepEqual(applyHiddenUserContent(history, "a", null), history);
  assert.deepEqual(applyHiddenUserContent(history, null, "directive"), history);
});

test("project context omits sections that would be empty", () => {
  // A heading with nothing under it reads to the model as a file that exists
  // and is blank.
  const context = buildProjectContext({
    name: "Juno",
    instructions: "   ",
    files: [
      { fileName: "spec.md", extractedText: "the spec" },
      { fileName: "image.png", extractedText: null },
      { fileName: "blank.txt", extractedText: "  " },
    ],
  });

  assert.ok(context.includes("# Project: Juno"));
  assert.ok(!context.includes("## Project instructions"));
  assert.ok(context.includes("### spec.md\nthe spec"));
  assert.ok(!context.includes("image.png"));
  assert.ok(!context.includes("blank.txt"));
});

test("a project with nothing extractable is still named", () => {
  const context = buildProjectContext({ name: "Empty", instructions: "", files: [] });
  assert.equal(context, "# Project: Empty");
});

test("no project is no context at all", () => {
  assert.equal(buildProjectContext(null), "");
});

test("direct attachments expose indexed passages and honest parser states", () => {
  const context = buildAttachmentContext({
    passages: [
      {
        documentId: "d1",
        fileName: "brief.pdf",
        locator: "page 2",
        blockIds: ["b1"],
        text: "The launch is scheduled for June.",
      },
    ],
    indexedFileNames: ["brief.pdf"],
    pendingFiles: [{ fileName: "new.pdf", state: "indexing" }],
    unavailableFiles: [{ fileName: "scan.pdf", state: "failed" }],
  });

  assert.match(context, /Retrieved from attached documents/);
  assert.match(context, /brief\.pdf · page 2/);
  assert.match(context, /new\.pdf \(indexing\)/);
  assert.match(context, /scan\.pdf \(failed\)/);
  assert.match(context, /Do not claim to have read it/);
  assert.match(context, /Do not invent contents/);
});

test("an indexed direct attachment with no matching passage stays explicit", () => {
  const context = buildAttachmentContext({ passages: [], indexedFileNames: ["brief.pdf"] });
  assert.match(context, /No relevant passage matched this question/);
  assert.match(context, /brief\.pdf/);
});

test("the context line never claims context that is not there", () => {
  assert.equal(
    contextActivityDetail({ messages: 1, attachments: 0, memories: 0, hasProjectContext: false }),
    "1 message"
  );
  assert.equal(
    contextActivityDetail({ messages: 12, attachments: 2, memories: 1, hasProjectContext: true }),
    "12 messages · 2 attachments · 1 memory · project context"
  );
  assert.equal(
    contextActivityDetail({ messages: 0, attachments: 0, memories: 3, hasProjectContext: false }),
    "0 messages · 3 memories"
  );
  assert.equal(
    contextActivityDetail({ messages: 1, attachments: 1, memories: 0, hasProjectContext: false, hasAttachmentContext: true }),
    "1 message · 1 attachment · attached document context"
  );
});

test("prompt characters floor the real prompt size", () => {
  assert.equal(promptChars("sys", [turn("USER", "ab"), turn("ASSISTANT", "c")]), 6);
});

test("the system prompt appends only the sections that apply", () => {
  const base = "BASE";
  assert.equal(composeSystemPrompt({ base, webSearch: false, canvasOn: false }), "BASE");
  assert.equal(
    composeSystemPrompt({ base, webSearch: true, canvasOn: false }),
    `BASE\n\n${WEB_SEARCH_NUDGE}`
  );
  assert.equal(
    composeSystemPrompt({ base, webSearch: false, canvasOn: true }),
    `BASE\n\n${SELECTION_ANCHOR_NUDGE}`
  );
});

test("a canvas edit's patch instructions REPLACE the selection nudge", () => {
  // The two describe different output protocols. A model given both emits a
  // mix of the two, which parses as neither.
  const composed = composeSystemPrompt({
    base: "BASE",
    webSearch: false,
    canvasOn: true,
    targetedArtifactEditPrompt: "PATCH PROTOCOL",
  });
  assert.equal(composed, "BASE\n\nPATCH PROTOCOL");
  assert.ok(!composed.includes(SELECTION_ANCHOR_NUDGE));
});

test("private mode's composition matches the saved path's for the same inputs", () => {
  // They were two hand-written expressions that happened to agree. Now they
  // are one call, and this is the equivalence that was being relied on.
  const base = "BASE";
  const privateStyle = `${base}\n\n${WEB_SEARCH_NUDGE}`;
  assert.equal(
    composeSystemPrompt({ base, webSearch: true, canvasOn: false, targetedArtifactEditPrompt: null }),
    privateStyle
  );
});
