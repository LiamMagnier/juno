import test from "node:test";
import assert from "node:assert/strict";
import type { Attachment } from "@prisma/client";
import { geminiGenerationConfig, geminiThinkingBudget, geminiThinkingConfig, resolveGroundingUrls, toGeminiContents } from "@/lib/gemini-core";
import type { ModelInfo } from "@/lib/models";
import type { MessageForModel } from "@/types/llm";

test("toGeminiContents converts history into Gemini content format", async () => {
  const history: MessageForModel[] = [
    {
      role: "USER",
      content: "Hello Gemini",
      attachments: [],
    },
    {
      role: "ASSISTANT",
      content: "Hello! How can I assist you?",
      attachments: [],
    },
  ];

  const contents = await toGeminiContents(history, true);
  assert.equal(contents.length, 2);
  assert.equal(contents[0].role, "user");
  assert.deepEqual(contents[0].parts, [{ text: "Hello Gemini" }]);
  assert.equal(contents[1].role, "model");
  assert.deepEqual(contents[1].parts, [{ text: "Hello! How can I assist you?" }]);
});

test("toGeminiContents handles attachments with extracted text", async () => {
  const attachment = {
    id: "att-1",
    userId: "user-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    kind: "FILE",
    fileName: "notes.txt",
    mimeType: "text/plain",
    size: 100,
    storageKey: "notes.txt",
    extractedText: "Key meeting notes here.",
    parserState: null,
    parserError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    previewKey: null,
    thumbnailKey: null,
    indexedAt: null,
    chunkCount: 0,
    projectId: null,
  } as unknown as Attachment;

  const history: MessageForModel[] = [
    {
      role: "USER",
      content: "Summarize this file",
      attachments: [attachment],
    },
  ];

  const contents = await toGeminiContents(history, true);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].parts.length, 2);
  assert.deepEqual(contents[0].parts[0], { text: "Summarize this file" });
  assert.match(
    (contents[0].parts[1] as { text: string }).text,
    /Attached file "notes\.txt":\n\nKey meeting notes here\./
  );
});

test("Gemini 3.7 serializes its exact supported thinking budget", () => {
  const model: ModelInfo = {
    id: "google:gemini-3.7-flash",
    provider: "google",
    providerModel: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    minPlan: "FREE",
    vision: true,
    reasoning: true,
    agenticTools: true,
    cost: 2,
    modality: "chat",
    webSearch: true,
  };

  assert.deepEqual(geminiThinkingConfig(model, "low"), { thinkingBudget: 2048 });
  assert.deepEqual(geminiThinkingConfig(model, "medium"), { thinkingBudget: 8192 });
  assert.deepEqual(geminiThinkingConfig(model, "high"), { thinkingBudget: 16384 });
  assert.deepEqual(geminiThinkingConfig(model, "minimal"), { thinkingBudget: 8192 });
  assert.deepEqual(geminiThinkingConfig(model, "xhigh"), { thinkingBudget: 8192 });
  assert.deepEqual(geminiThinkingConfig(model, "max"), { thinkingBudget: 8192 });
  assert.deepEqual(geminiThinkingConfig(model, null), { thinkingBudget: 8192 });
  assert.deepEqual(geminiGenerationConfig(model, 4096, "high"), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingBudget: 16384 },
  });
  assert.equal("temperature" in geminiGenerationConfig(model, 4096, "high"), false);
  assert.equal("topP" in geminiGenerationConfig(model, 4096, "high"), false);
  assert.equal("topK" in geminiGenerationConfig(model, 4096, "high"), false);
});

test("legacy Gemini 2.5 retains the thinking budget transport", () => {
  const model = {
    id: "google:gemini-2.5-pro", provider: "google", providerModel: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro", minPlan: "PRO", vision: true, reasoning: true,
    agenticTools: true, cost: 3, modality: "chat", webSearch: true,
  } as ModelInfo;
  assert.deepEqual(geminiThinkingConfig(model, "low"), { thinkingBudget: 2048 });
  assert.equal(geminiThinkingBudget(model, "high"), 16384);
});

test("resolveGroundingUrls keeps regular urls intact", async () => {
  const sources = [
    { title: "Example", url: "https://example.com/article", snippet: "" },
  ];
  const resolved = await resolveGroundingUrls(sources);
  assert.deepEqual(resolved, sources);
});
