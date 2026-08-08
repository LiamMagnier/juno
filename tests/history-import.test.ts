import test from "node:test";
import assert from "node:assert/strict";
import { detectFormat, parseHistoryExport } from "../src/lib/history-import";

test("detects Gemini Takeout entries without mistaking them for ChatGPT", () => {
  assert.equal(detectFormat(["My Activity.json", "Gemini Apps/readme.txt"]), "gemini");
});

test("imports Gemini conversation messages with provider role and date variants", () => {
  const parsed = parseHistoryExport(
    JSON.stringify({
      conversations: [
        {
          title: "Planning",
          createTime: "2026-08-08T10:00:00.000Z",
          messages: [
            { role: "user", content: { parts: [{ text: "Help me plan a launch." }] }, createTime: "2026-08-08T10:00:01.000Z" },
            { role: "model", content: { parts: [{ text: "Start with the audience and deadline." }] }, createTime: "2026-08-08T10:00:02.000Z" },
          ],
        },
      ],
    }),
    "gemini",
  );

  assert.equal(parsed.format, "gemini");
  assert.equal(parsed.conversations.length, 1);
  assert.deepEqual(
    parsed.conversations[0].messages.map((message) => [message.role, message.content]),
    [
      ["user", "Help me plan a launch."],
      ["assistant", "Start with the audience and deadline."],
    ],
  );
});

test("keeps ChatGPT and Claude shape sniffing when callers use the JSON path", () => {
  const chatgpt = parseHistoryExport(
    JSON.stringify([
      {
        title: "Old chat",
        create_time: 1_700_000_000,
        current_node: "n2",
        mapping: {
          n1: { parent: null, message: { author: { role: "user" }, content: { parts: ["Hello"] }, create_time: 1_700_000_001 } },
          n2: { parent: "n1", message: { author: { role: "assistant" }, content: { parts: ["Hi"] }, create_time: 1_700_000_002 } },
        },
      },
    ]),
    "gemini",
  );
  assert.equal(chatgpt.format, "chatgpt");
  assert.equal(chatgpt.conversations[0].messages.length, 2);
});
