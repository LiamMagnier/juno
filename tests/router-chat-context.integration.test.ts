import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

// Only an explicitly named disposable local database. Never DATABASE_URL.
const databaseUrl = process.env.JUNO_CONTEXT_TEST_DATABASE_URL;
if (!databaseUrl) {
  test("routing context database tests require JUNO_CONTEXT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(databaseUrl, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_context_test$/);
  process.env.DATABASE_URL = databaseUrl;
  process.env.DIRECT_URL = databaseUrl;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "routing-context-disposable-test";

  test("routing sees persisted context before model selection with tenant and private-mode boundaries", async (t) => {
    const { prisma } = await import("@/lib/prisma");
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const { autoRoutingContext } = await import("@/lib/router/chat-inputs");
    const { chatBodySchema } = await import("@/lib/chat/request");
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `routing-owner-${suffix}@example.test` } });
    const other = await prisma.user.create({ data: { email: `routing-other-${suffix}@example.test` } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("routing estimates must not call external services"); };
    t.after(async () => {
      globalThis.fetch = originalFetch;
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
      await prisma.$disconnect();
    });
    const conversation = await prisma.conversation.create({ data: { userId: owner.id, activeConnectors: ["github"] } });
    const foreign = await prisma.conversation.create({ data: { userId: other.id } });
    const messages = await Promise.all(Array.from({ length: 8 }, (_, index) => prisma.message.create({ data: {
      conversationId: conversation.id, role: index % 2 ? "ASSISTANT" : "USER", content: encryptMessageText("x".repeat(80_000)),
      createdAt: new Date(1_700_000_000_000 + index),
    } })));
    const foreignFile = await prisma.attachment.create({ data: {
      userId: other.id, kind: "IMAGE", mimeType: "image/png", fileName: "foreign.png", storageKey: "unused", size: 12_000,
    } });
    const context = (input: Partial<Parameters<typeof autoRoutingContext>[0]["input"]>, extra: Partial<Parameters<typeof autoRoutingContext>[0]> = {}) =>
      autoRoutingContext({ userId: owner.id, input: chatBodySchema.parse(input), privateHistory: [], workspaceConfig: {}, ...extra });

    await t.test("encrypted saved history and sticky connector schemas contribute", async () => {
      const result = await context({ conversationId: conversation.id, message: "continue" });
      assert.ok(result.contextTokens >= 160_000, String(result.contextTokens));
      assert.equal(result.hasImages, false);
    });
    await t.test("a foreign conversation and foreign attachment reveal no context or vision requirement", async () => {
      await prisma.message.create({ data: { conversationId: foreign.id, role: "USER", content: encryptMessageText("x".repeat(500_000)) } });
      const result = await context({ conversationId: foreign.id, message: "read", attachmentIds: [foreignFile.id] });
      assert.equal(result.contextTokens, 1);
      assert.equal(result.hasImages, false);
    });
    await t.test("deleted files are ignored while new unparsed files reserve input", async () => {
      const file = await prisma.attachment.create({ data: {
        userId: owner.id, kind: "FILE", mimeType: "text/plain", fileName: "fresh.txt", storageKey: "unused", size: 220_000,
      } });
      assert.equal((await context({ message: "read", attachmentIds: [file.id] })).contextTokens, 55_001);
      await prisma.attachment.updateMany({ where: { id: file.id, userId: owner.id }, data: { deletedAt: new Date() } });
      assert.equal((await context({ message: "read", attachmentIds: [file.id] })).contextTokens, 1);
    });
    await t.test("private mode ignores all saved context and counts its supplied user turn once", async () => {
      const result = await context({ privateMode: true, conversationId: conversation.id, message: "read", attachmentIds: [foreignFile.id] }, { privateHistory: [{ content: "read" }] });
      assert.equal(result.contextTokens, 1);
      assert.equal(result.hasImages, false);
    });
    await t.test("regenerate preserves the previous answer when this is a cross reply", async () => {
      const replaced = await context({ conversationId: conversation.id, regenerate: true });
      const followUp = await context({ conversationId: conversation.id, regenerate: true, crossReply: { linkId: "link" } });
      assert.ok(followUp.contextTokens - replaced.contextTokens >= 20_000);
    });
    await t.test("project file selection and indexed-document coverage are reflected", async () => {
      const project = await prisma.project.create({ data: { userId: owner.id, name: "Sources", instructions: "source policy" } });
      const file = await prisma.attachment.create({ data: {
        userId: owner.id, projectId: project.id, kind: "FILE", mimeType: "text/plain", fileName: "source.txt", storageKey: "unused", size: 400_000,
        extractedText: "x".repeat(400_000),
      } });
      const full = await context({ projectId: project.id, message: "read" });
      const none = await context({ projectId: project.id, message: "read" }, { selectedKnowledgeFileIds: [] });
      assert.ok(full.contextTokens > 100_000);
      assert.ok(none.contextTokens < 100);
      await prisma.knowledgeDocument.create({ data: {
        userId: owner.id, projectId: project.id, attachmentId: file.id, fileName: file.fileName, mimeType: file.mimeType, checksum: suffix, state: "ready",
      } });
      const indexed = await context({ projectId: project.id, message: "read" });
      assert.ok(indexed.contextTokens > 2_400 && indexed.contextTokens < 10_000);
    });
    await t.test("history is bounded by the next count window", async () => {
      await prisma.message.createMany({ data: Array.from({ length: 32 }, (_, index) => ({
        conversationId: conversation.id, role: index % 2 ? "ASSISTANT" as const : "USER" as const,
        content: encryptMessageText("small"), createdAt: new Date(1_700_000_010_000 + index),
      })) });
      const result = await context({ conversationId: conversation.id, message: "continue" });
      assert.ok(result.contextTokens < 5_000, `old long turns have left the prompt: ${result.contextTokens}`);
    });
    await t.test("index coverage respects the attachment retriever's first-20 selection bound", async () => {
      const project = await prisma.project.create({ data: { userId: owner.id, name: "Selected sources" } });
      const files = [];
      for (let index = 0; index < 21; index += 1) files.push(await prisma.attachment.create({ data: {
        userId: owner.id, projectId: project.id, kind: "FILE", mimeType: "text/plain", fileName: `selected-${index}.txt`, storageKey: "unused", size: 400_000,
        extractedText: index === 20 ? "x".repeat(400_000) : "small",
      } }));
      const last = files[20];
      await prisma.knowledgeDocument.create({ data: {
        userId: owner.id, projectId: project.id, attachmentId: last.id, fileName: last.fileName, mimeType: last.mimeType, checksum: `${suffix}-21`, state: "ready",
      } });
      const result = await context({ projectId: project.id, message: "read" }, { selectedKnowledgeFileIds: files.map((file) => file.id) });
      assert.ok(result.contextTokens > 100_000, "the 21st file is not replaced by indexed passages");
    });
    assert.equal(messages.length, 8);
  });
}
