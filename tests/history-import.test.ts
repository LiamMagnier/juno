import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectFormat, importArchiveBudgetProblems, parseHistoryExport } from "../src/lib/history-import";

const IMPORT_ROUTE_SOURCE = readFileSync(new URL("../src/app/api/import/route.ts", import.meta.url), "utf8");

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

test("round-trips the Juno export marker and branch/project pointers", () => {
  const parsed = parseHistoryExport(
    JSON.stringify({
      schemaVersion: "juno.export.v2",
      projects: [{ id: "project-source" }],
      conversations: [
        {
          id: "root-source",
          projectId: "project-source",
          title: "Root",
          createdAt: "2026-08-08T10:00:00.000Z",
          messages: [{ id: "message-source", role: "USER", content: "Start", attachmentIds: ["attachment-source"] }],
        },
        {
          id: "branch-source",
          projectId: "project-source",
          forkedFromId: "root-source",
          title: "Root (branch)",
          createdAt: "2026-08-08T10:01:00.000Z",
          messages: [{ role: "USER", content: "Continue differently" }],
        },
      ],
    }),
    "gemini",
  );

  assert.equal(parsed.format, "juno");
  assert.equal(parsed.conversations[1].sourceId, "branch-source");
  assert.equal(parsed.conversations[1].forkedFromSourceId, "root-source");
  assert.equal(parsed.conversations[1].projectSourceId, "project-source");
  assert.equal(parsed.conversations[0].messages[0].sourceId, "message-source");
  assert.deepEqual(parsed.conversations[0].messages[0].attachmentSourceIds, ["attachment-source"]);
});

test("preserves Juno message metadata and recognizes a full JSON account snapshot", () => {
  const parsed = parseHistoryExport(
    JSON.stringify({
      settings: { theme: "DARK" },
      memories: [{ id: "memory-source", content: "Prefers short answers." }],
      conversations: [{
        id: "conversation-source",
        model: "gpt-5.6-sol",
        pinned: true,
        messages: [{
          id: "message-source",
          role: "assistant",
          content: "Short answer.",
          reasoning: "Checked the constraints.",
          reasoningParts: ["Checked the constraints."],
          model: "gpt-5.6-sol",
          promptTokens: 12,
          completionTokens: 4,
          costMicroUsd: 99,
          sources: [{ title: "Juno", url: "https://example.com" }],
          activity: [{ id: "a1", kind: "done", title: "Done", createdAt: "2026-08-08T10:00:00.000Z" }],
        }],
      }],
    }),
    "juno",
  );

  assert.equal(parsed.format, "juno");
  assert.equal(parsed.conversations[0].model, "gpt-5.6-sol");
  assert.equal(parsed.conversations[0].pinned, true);
  assert.equal(parsed.conversations[0].messages[0].reasoning, "Checked the constraints.");
  assert.equal(parsed.conversations[0].messages[0].costMicroUsd, 99);
  assert.deepEqual(parsed.conversations[0].messages[0].sources, [{ title: "Juno", url: "https://example.com" }]);
});

test("import archive budgets reject ZIP inflation and case-folded collisions", () => {
  assert.match(
    importArchiveBudgetProblems([
      { name: "a.json", uncompressedSize: 64 * 1024 * 1024 + 1, compressedSize: 1 },
      { name: "A.JSON", uncompressedSize: 1, compressedSize: 1 },
    ]).join(" "),
    /per-entry limit|duplicate file names|compression ratio/,
  );
  assert.match(
    importArchiveBudgetProblems(
      Array.from({ length: 5_001 }, (_, index) => ({ name: `file-${index}.json`, uncompressedSize: 1, compressedSize: 1 })),
    ).join(" "),
    /5,000-file safety limit/,
  );
});

test("account imports commit database state atomically and schedule indexing after commit", () => {
  assert.match(IMPORT_ROUTE_SOURCE, /const result = await prisma\.\$transaction\(/);
  assert.match(IMPORT_ROUTE_SOURCE, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(IMPORT_ROUTE_SOURCE, /const uploadedStorageKeys: string\[\] = \[\]/);
  assert.match(IMPORT_ROUTE_SOURCE, /await cleanupStorageKeys\(uploadedStorageKeys\)/);
  assert.doesNotMatch(IMPORT_ROUTE_SOURCE, /scheduleIngest\(\{/);
  const transactionResult = IMPORT_ROUTE_SOURCE.indexOf("return { imported");
  const postCommitScheduling = IMPORT_ROUTE_SOURCE.indexOf("for (const ingest of scheduledIngests)");
  assert.ok(transactionResult >= 0 && postCommitScheduling > transactionResult);
});
