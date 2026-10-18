import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/*
 * G04 — A PICTURE MADE IN CHAT, THROUGH THE REAL METER.
 *
 * `generate_image` with its real server half: the shared media pipeline's
 * admission (plan, budget, rolling windows, health, moderation, rate limit,
 * message quota, spend hold), the ledger, the Library's locked quota check,
 * local storage, and the answer's sealing that links the files. The one
 * stand-in is THE PROVIDER (`@/lib/image-gen`), scripted per test; a fetch
 * tripwire proves nothing leaves the process, and the key is a dummy.
 *
 * Skipped unless IMAGE_PIPELINE_TEST_DATABASE_URL names a throwaway, migrated
 * local database (it never falls back to DATABASE_URL):
 *   IMAGE_PIPELINE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/juno_image_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-image-pipeline.integration.test.ts
 */

const DB_URL = process.env.IMAGE_PIPELINE_TEST_DATABASE_URL;

if (!DB_URL) {
  test("image pipeline suite is skipped without IMAGE_PIPELINE_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_image_test(?:_[a-z0-9]+)?$/, "only an explicit local disposable database");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "image-pipeline-test-secret";
  // A dummy key for one provider only, and its paid tier attested, so Auto
  // has exactly one lab to choose from. No request ever leaves (tripwire).
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$/.test(key)) delete process.env[key];
  }
  process.env.GOOGLE_API_KEY = "test-dummy-not-a-key";
  process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS = "google";
  delete process.env.S3_BUCKET;
  delete process.env.OWNER_EMAILS;

  // A real 1×1 PNG, so the AI-content marking has a file to mark.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  let providerCalls = 0;
  let providerFails: Error | null = null;
  mock.module("@/lib/image-gen", {
    namedExports: {
      async generateImage(_model: unknown, _prompt: string, _wire: unknown, count = 1) {
        providerCalls += 1;
        if (providerFails) throw providerFails;
        return Array.from({ length: count }, () => ({ bytes: Buffer.from(PNG), mimeType: "image/png", ext: "png" }));
      },
      async editImage() {
        providerCalls += 1;
        if (providerFails) throw providerFails;
        return { bytes: Buffer.from(PNG), mimeType: "image/png", ext: "png" };
      },
    },
  });

  const outbound: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    outbound.push(url);
    throw new Error(`unexpected network call to ${url}`);
  };

  test("generate_image meters, saves to the Library, links to the answer and refunds on failure", async (t) => {
    const { prisma } = await import("@/lib/prisma");
    const { createGenerateImageTool } = await import("@/lib/chat/image-tool");
    const { createAssistantTurnWriter } = await import("@/lib/chat/turn/persist");
    const { GenerationAccumulator } = await import("@/lib/chat/stream-accumulator");
    const { currentPeriod } = await import("@/lib/utils");
    type Activity = import("@/types/chat").ClientActivityEvent;

    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { email: `image-${suffix}@example.test`, name: "Image Test", emailVerified: new Date() },
    });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Images" } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
      await prisma.$disconnect();
    });

    const messageCount = async () =>
      (await prisma.usage.findUnique({ where: { userId_period: { userId: user.id, period: currentPeriod() } } }))?.messageCount ?? 0;

    const makeTool = (generated: string[], log: Activity[]) => {
      let seq = 0;
      return createGenerateImageTool({
        user: { id: user.id, email: user.email },
        conversation: { id: conversation.id, projectId: null },
        plan: "PRO",
        userRequest: "Draw me a fox in the snow",
        turnAttachmentIds: [],
        untrustedContent: false,
        sendActivity: (event) => {
          const entry = { ...event, id: `activity-${seq++}`, createdAt: new Date().toISOString() } as Activity;
          log.push(entry);
          return entry;
        },
        resendActivity: () => {},
        generatedAttachmentIds: generated,
      });
    };

    await t.test("a picture is made through the meter and saved as this conversation's generated file", async () => {
      const generated: string[] = [];
      const log: Activity[] = [];
      const before = await messageCount();
      const result = await makeTool(generated, log).execute({ prompt: "A fox in the snow, watercolour", aspect: "16:9" });
      assert.equal(result.ok, true, result.text);
      assert.equal(providerCalls, 1);
      assert.equal(generated.length, 1);
      const row = await prisma.attachment.findFirstOrThrow({ where: { id: generated[0]!, userId: user.id } });
      assert.equal(row.userId, user.id);
      assert.equal(row.conversationId, conversation.id);
      assert.equal(row.origin, "generated");
      assert.equal(row.kind, "IMAGE");
      assert.equal(row.messageId, null, "linked only when the answer is saved");
      assert.ok(existsSync(join(process.cwd(), ".uploads", row.storageKey)), "the file is in storage");
      // The meter: one message, one ledger row at the image's price, the hold settled.
      assert.equal(await messageCount(), before + 1);
      const spend = await prisma.apiSpend.findMany({ where: { userId: user.id, kind: "image" } });
      assert.equal(spend.length, 1);
      assert.ok(spend[0]!.costMicroUsd > 0);
      const holds = await prisma.spendReservation.findMany({ where: { userId: user.id, kind: "image" } });
      assert.deepEqual(holds.map((h) => h.state), ["settled"]);
      const done = log.at(-1)?.imageGeneration;
      assert.equal(done?.status, "done");
      assert.equal(done?.modelId?.startsWith("google:"), true, "Auto chose within the one attested, keyed lab");

      // Sealing the answer links the picture, so the done frame and a reload carry it.
      const writer = createAssistantTurnWriter({
        user: user as never,
        conversationId: conversation.id,
        staleAssistantId: null,
        modelId: "anthropic:claude-sonnet-4-6",
        acc: new GenerationAccumulator(),
        activityLog: log,
        roomTurnId: null,
        routingReceipt: null,
        generatedAttachmentIds: generated,
      });
      const assistant = await writer.persistAssistantTurn({
        content: "Here is your fox.",
        reasoning: "",
        reasoningParts: [],
        promptTokens: null,
        completionTokens: null,
      });
      const sealed = await writer.sealActivity(assistant.id);
      assert.deepEqual(sealed.attachments.map((a) => a.id), generated);
    });

    await t.test("a provider failure refunds the message, releases the hold and leaves no file", async () => {
      providerFails = new Error("upstream 500");
      const generated: string[] = [];
      const log: Activity[] = [];
      const before = await messageCount();
      const attachmentsBefore = await prisma.attachment.count({ where: { userId: user.id } });
      const result = await makeTool(generated, log).execute({ prompt: "Another fox" });
      providerFails = null;
      assert.equal(result.ok, false);
      assert.equal(log.at(-1)?.imageGeneration?.status, "failed");
      assert.equal(await messageCount(), before, "refunded");
      assert.equal(await prisma.attachment.count({ where: { userId: user.id } }), attachmentsBefore);
      const open = await prisma.spendReservation.count({ where: { userId: user.id, kind: "image", state: "open" } });
      assert.equal(open, 0, "no hold left open");
    });

    await t.test("a spent month is refused before the provider, by name", async () => {
      const calls = providerCalls;
      const row = await prisma.apiSpend.create({
        data: { userId: user.id, model: "test", kind: "chat", costMicroUsd: 2_000_000_000 },
      });
      const log: Activity[] = [];
      const result = await makeTool([], log).execute({ prompt: "A third fox" });
      await prisma.apiSpend.deleteMany({ where: { id: row.id, userId: user.id } });
      assert.equal(result.ok, false);
      assert.equal(log.at(-1)?.imageGeneration?.failure?.code, "budget_exceeded");
      assert.equal(providerCalls, calls, "the provider was never called");
    });

    await t.test("an account that cannot spend (unverified email) is refused before the provider", async () => {
      const calls = providerCalls;
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: null } });
      const log: Activity[] = [];
      const result = await makeTool([], log).execute({ prompt: "A fourth fox" });
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
      assert.equal(result.ok, false);
      assert.equal(log.at(-1)?.imageGeneration?.failure?.code, "quota_exhausted");
      assert.equal(providerCalls, calls);
      const open = await prisma.spendReservation.count({ where: { userId: user.id, kind: "image", state: "open" } });
      assert.equal(open, 0);
    });

    assert.deepEqual(outbound, [], "nothing left the process");
  });
}
