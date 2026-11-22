import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationMarkdown } from "@/components/chat/conversation-export";
import { codeExportMessages } from "@/lib/code-v2/session-transcript";
import type { TurnItem } from "@/lib/code-v2/contracts";

test("Code exports the visible conversation and attachment names only", () => {
  const createdAt = "2026-11-22T00:00:00.000Z";
  const items: TurnItem[] = [
    { kind: "user_message", id: "prompt", createdAt, text: "Check the tests", delivery: "send", attachments: [
      { ref: "private-upload-ref", name: "spec.md", mediaType: "text/markdown" },
    ] },
    { kind: "reasoning", id: "reasoning", createdAt, text: "Private reasoning", streaming: false, summary: true },
    { kind: "assistant_message", id: "agent", agentId: "worker", createdAt, text: "Nested reply", streaming: false },
    { kind: "assistant_message", id: "answer", createdAt, text: "Tests passed.", streaming: true },
  ];
  const markdown = conversationMarkdown({
    title: "Code session",
    exportedAt: new Date(createdAt),
    messages: codeExportMessages(items),
  });
  assert.match(markdown, /Check the tests[\s\S]*spec\.md[\s\S]*Tests passed\.[\s\S]*Still being written/);
  assert.doesNotMatch(markdown, /private-upload-ref|Private reasoning|Nested reply/);
  assert.deepEqual(codeExportMessages(items.slice(1, 3)), []);
});
