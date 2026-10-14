import test from "node:test";
import assert from "node:assert/strict";
import { autoContextTokens, estimateAutoContext } from "@/lib/router/chat-context";
import { estimateTokens } from "@/lib/router/task-class";
import { routeAuto } from "@/lib/router/decide";
import { MODEL_LIST } from "@/lib/models";
import { buildProjectContext, buildProjectReferenceFiles } from "@/lib/chat/context-assembly";
import { historyTokenBudget, planTokenTrim, SUMMARY_MAX_CHARS, type WindowMessage } from "@/lib/chat/history-compaction";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";

const history = (count: number, content = "short turn"): WindowMessage[] =>
  Array.from({ length: count }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? "ASSISTANT" : "USER", content }));

test("saved history excludes a model that only fits the newest question", () => {
  const contextTokens = autoContextTokens({ message: "continue" }, [], { history: history(8, "x".repeat(80_000)) });
  const base = MODEL_LIST.find((model) => model.id === "openai:gpt-6-luna")!;
  const candidates = [
    { ...base, id: "short-context", contextWindow: 64_000 },
    { ...base, id: "long-context", contextWindow: 512_000 },
  ];
  const decision = routeAuto({ message: "continue", plan: "PRO", contextTokens, catalogue: candidates, isConfigured: () => true, canUse: () => true });
  assert.ok(contextTokens >= 160_000);
  assert.equal(decision.profile.taskClass, "long_context");
  assert.equal(decision.ranked[0].modelId, "long-context");
  assert.equal(decision.excluded.context_too_small, 1);
});

test("a thousand-message chat estimates the count window, not its full transcript", () => {
  const tokens = autoContextTokens({ message: "continue" }, [], { history: history(31, "x".repeat(1_000)), totalMessages: 1_000 });
  assert.ok(tokens > 6_000 && tokens < 10_000, String(tokens));
});

test("the pending turn advances the block window before routing", () => {
  const messages = history(31);
  for (const message of messages.slice(0, 8)) message.content = "x".repeat(100_000);
  const tokens = autoContextTokens({ message: "next" }, [], { history: messages, totalMessages: 31 });
  assert.ok(tokens < 2_000, `old block is no longer sent: ${tokens}`);
});

test("compaction retains protected recent context and reserves the rolling summary", () => {
  const messages = history(24);
  for (const message of messages.slice(0, 16)) message.content = "x".repeat(100_000);
  const compacted = autoContextTokens({ message: "next" }, [], { history: messages });
  const full = autoContextTokens({ message: "next" }, [], { history: messages, compactionEnabled: false });
  assert.ok(compacted <= 62_000 && compacted >= 60_000, String(compacted));
  assert.ok(full > 400_000);
});

test("the estimate covers candidate-specific compaction and document budgets", () => {
  const messages = history(24);
  messages[0].attachments = [{ kind: "DOCUMENT", extractedText: "x".repeat(800_000) }];
  messages[4].content = "日".repeat(90_000);
  messages[16].attachments = [{ kind: "DOCUMENT", extractedText: "x".repeat(400_000) }];
  const pending: WindowMessage = { id: "pending", role: "USER", content: "continue" };
  const window = [...messages, pending];
  const estimate = autoContextTokens({ message: pending.content }, [], { history: messages });
  for (const contextWindow of [16_000, 32_000, 128_000, 1_000_000]) {
    const cap = attachmentTextBudget(contextWindow);
    const drop = planTokenTrim(window, { budgetTokens: historyTokenBudget(contextWindow), attachmentCharCap: cap });
    let actual = window.slice(drop).reduce((sum, message) => sum + estimateTokens(message.content) + (message.attachments ?? []).reduce(
      (total, attachment) => total + estimateTokens((attachment.extractedText ?? "").slice(0, cap)), 0
    ), 0);
    if (drop > 0) actual += Math.ceil(SUMMARY_MAX_CHARS / 4);
    assert.ok(estimate >= actual, `${contextWindow}: ${estimate} must cover ${actual}`);
  }
});

test("regeneration excludes the replaced answer and includes hidden clarification content", () => {
  const messages = history(2);
  messages[1].content = "x".repeat(600_000);
  const tokens = autoContextTokens({ regenerate: true, replacementUserContent: "y".repeat(40_000) }, [], { history: messages });
  assert.equal(tokens, 10_000);
});

test("private history includes the newest turn exactly once and ignores saved context", () => {
  const text = "private question";
  const tokens = autoContextTokens({ privateMode: true, message: text }, [{ content: text }], {
    history: history(31, "x".repeat(100_000)),
    project: { name: "unrelated", instructions: "private", files: [] },
    attachments: [{ id: "foreign", kind: "IMAGE" }],
    connectorCount: 10,
  });
  assert.equal(tokens, estimateTokens(text));
});

test("new files, image payloads, instructions and connector schemas contribute before selection", () => {
  const tokens = autoContextTokens({ message: "read" }, [], {
    attachments: [{ id: "file", kind: "DOCUMENT", extractedText: "x".repeat(80_000) }, { id: "image", kind: "IMAGE" }],
    instructions: "日".repeat(300), connectorCount: 2,
  });
  assert.equal(tokens, 1 + 20_000 + 1_600 + 200 + 2_400);
});

test("project references are estimated using their actual prompt envelopes", () => {
  const project = { name: "Test", instructions: "follow these instructions", files: [{ fileName: "brief.txt", extractedText: "x".repeat(20_000) }] };
  const tokens = autoContextTokens({ message: "read" }, [], { project });
  assert.equal(tokens, 1 + estimateTokens(buildProjectContext(project)) + estimateTokens(buildProjectReferenceFiles(project)));
});

test("an indexed project reserves retrieved passages rather than its entire library", () => {
  const project = { name: "Library", instructions: "Answer from sources", files: Array.from({ length: 64 }, (_, index) => ({ fileName: `file-${index}`, extractedText: "x".repeat(100_000) })) };
  const indexed = project.files.map((file) => file.fileName);
  const full = autoContextTokens({ message: "read" }, [], { project });
  const retrieved = autoContextTokens({ message: "read" }, [], { project, indexedProjectFileNames: indexed });
  assert.ok(full > 1_600_000);
  assert.ok(retrieved > 2_400 && retrieved < 10_000, String(retrieved));
});

test("fresh uploads without extracted text reserve input using file metadata", () => {
  const text = autoContextTokens({ message: "read" }, [], { attachments: [{ kind: "FILE", size: 220_000, mimeType: "text/plain", extractedText: null }] });
  const compressed = autoContextTokens({ message: "read" }, [], { attachments: [{ kind: "FILE", size: 30_000, mimeType: "application/pdf", extractedText: null }] });
  assert.equal(text, 55_001);
  assert.equal(compressed, 30_001);
});

test("cross replies and room follow-ups retain the preceding assistant context", () => {
  const messages = history(2);
  messages[1].content = "x".repeat(200_000);
  const tokens = autoContextTokens({ regenerate: true, preserveLastAssistant: true }, [], { history: messages });
  assert.ok(tokens > 50_000);
});

test("images outside the count window no longer force vision routing", () => {
  const messages = history(31);
  messages[0].attachments = [{ kind: "IMAGE" }];
  assert.equal(estimateAutoContext({ message: "next" }, [], { history: messages, totalMessages: 31 }).hasImages, false);
  messages[30].attachments = [{ kind: "IMAGE" }];
  assert.equal(estimateAutoContext({ message: "next" }, [], { history: messages, totalMessages: 31 }).hasImages, true);
});

test("vision remains required when a candidate-specific document cap retains the image", () => {
  const messages = history(24);
  messages[10].attachments = [{ kind: "IMAGE" }];
  messages[12].attachments = [{ kind: "FILE", extractedText: "x".repeat(400_000) }];
  assert.equal(estimateAutoContext({ message: "continue" }, [], { history: messages }).hasImages, true);
});
