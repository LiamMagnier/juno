import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

/*
 * The citation inspector is deliberately exercised against PostgreSQL here.
 * Its important guarantee is not just that a mock-shaped object is projected
 * correctly: the event-to-run-to-claim graph must be read with the requesting
 * user's ownership boundary intact.
 *
 * The suite is opt-in and never falls back to DATABASE_URL. Use a throwaway
 * database that has the current migrations applied:
 *
 *   createdb juno_research_test
 *   DATABASE_URL=postgresql:///juno_research_test \
 *   DIRECT_URL=postgresql:///juno_research_test npx prisma migrate deploy
 *   RESEARCH_TEST_DATABASE_URL=postgresql:///juno_research_test \
 *   npx tsx --test tests/research-inspector-db.test.ts
 */

const DB_URL = process.env.RESEARCH_TEST_DATABASE_URL;

if (!DB_URL) {
  test("research inspector database suite is skipped without RESEARCH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  test("projects the durable citation graph and enforces owner isolation", async () => {
    const claims = await import("@/lib/research/claims");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await prisma.user.create({
      data: { email: `research-inspector-owner-${suffix}@example.invalid`, name: "Research inspector owner" },
    });
    const other = await prisma.user.create({
      data: { email: `research-inspector-other-${suffix}@example.invalid`, name: "Research inspector other" },
    });

    try {
      const conversation = await prisma.conversation.create({
        data: { userId: owner.id, title: "Research audit fixture" },
      });
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: "The fixture claim is supported. [1]",
        },
      });
      const run = await prisma.researchRun.create({
        data: {
          userId: owner.id,
          conversationId: conversation.id,
          assistantMessageId: message.id,
          goal: "Verify the fixture claim",
          state: "completed",
          report: "The fixture claim is supported. [1]",
          reportRevision: 1,
        },
      });
      const source = await prisma.researchSource.create({
        data: {
          userId: owner.id,
          runId: run.id,
          url: "https://example.invalid/fixture",
          title: "Fixture source",
          snapshot: "The fixture claim is supported by the source.",
          authority: 0.9,
          freshness: 0.8,
          directness: 0.95,
          independence: 0.85,
          composite: 0.88,
          sourceType: "primary",
        },
      });
      const passage = await prisma.researchPassage.create({
        data: {
          userId: owner.id,
          sourceId: source.id,
          text: "The fixture claim is supported by the source.",
          locator: "paragraph:1",
          ordinal: 0,
        },
      });
      const claim = await prisma.researchClaim.create({
        data: {
          userId: owner.id,
          runId: run.id,
          text: "The fixture claim is supported.",
          type: "fact",
          status: "supported",
          supportStrength: 0.92,
          answerSpan: "The fixture claim is supported.",
        },
      });
      await prisma.researchClaimLink.create({
        data: {
          claimId: claim.id,
          passageId: passage.id,
          stance: "supports",
          strength: 0.92,
        },
      });
      await prisma.researchEvent.create({
        data: {
          userId: owner.id,
          runId: run.id,
          seq: 1,
          kind: "citation_audit",
          payload: {
            messageId: message.id,
            sourceOrder: [source.id],
            truncatedSources: [],
          },
        },
      });

      const view = await claims.loadCitationAuditForMessage(owner.id, message.id);
      assert.ok(view);
      assert.equal(view.runId, run.id);
      assert.equal(view.state, "completed");
      assert.equal(view.summary.claims, 1);
      assert.equal(view.summary.supported, 1);
      assert.equal(view.summary.unsupported, 0);
      assert.deepEqual(view.sources.map((item) => ({ index: item.index, title: item.title, truncated: item.truncated })), [
        { index: 1, title: "Fixture source", truncated: false },
      ]);
      assert.equal(view.claims[0]?.id, claim.id);
      assert.equal(view.claims[0]?.status, "supported");
      assert.equal(view.claims[0]?.links[0]?.sourceIndex, 1);
      assert.equal(view.claims[0]?.links[0]?.passage, passage.text);

      assert.equal(
        await claims.loadCitationAuditForMessage(other.id, message.id),
        null,
        "a message id alone cannot cross the requesting user's research boundary"
      );
      assert.equal(await claims.loadCitationAuditForMessage(owner.id, "missing-message"), null);
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.user.delete({ where: { id: other.id } });
      await prisma.$disconnect();
    }
  });
}
