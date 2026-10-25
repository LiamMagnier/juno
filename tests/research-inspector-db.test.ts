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
      // An audit recorded before read states, rivals and invented-citation
      // receipts existed reads back as "not known", never as "opened" / "none".
      assert.equal(view.sources[0]?.readState, null);
      assert.equal(view.claims[0]?.unresolvedCitations, null);
      assert.deepEqual(view.claims[0]?.rivals, []);
      assert.equal(view.claims[0]?.contested, false);

      assert.equal(
        await claims.loadCitationAuditForMessage(other.id, message.id),
        null,
        "a message id alone cannot cross the requesting user's research boundary"
      );
      assert.equal(await claims.loadCitationAuditForMessage(owner.id, "missing-message"), null);
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.user.delete({ where: { id: other.id } });
    }
  });

  test("records how each source was read, disagreement and invented citations, and the inspector reads them back", async () => {
    const claims = await import("@/lib/research/claims");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await prisma.user.create({
      data: { email: `research-audit-e2e-${suffix}@example.invalid`, name: "Research audit e2e" },
    });
    try {
      const report = [
        "# Fleet report",
        "",
        "Installed capacity reached 16.5 GW at the end of June 2026 [1]. Reviewers rated the mobile app 4.8 out of 5 [2].",
        "",
        "The fleet currently has 13.8 GW of capacity installed [4]. The operator was founded in Aberdeen in 2019 [9].",
      ].join("\n");
      const conversation = await prisma.conversation.create({ data: { userId: owner.id, title: "Audit e2e" } });
      const message = await prisma.message.create({
        data: { conversationId: conversation.id, role: "ASSISTANT", content: report },
      });
      const run = await prisma.researchRun.create({
        data: { userId: owner.id, conversationId: conversation.id, goal: "Fleet capacity", state: "validating_citations" },
      });
      const bodies = {
        opened: "Installed capacity reached 16.5 GW at the end of June 2026, the department's quarterly statistics show. Three projects reached full output in the quarter.",
        preview: "A capable app for fleet operators. We tested it for a month and found the dashboard fast and the mobile app solid.",
        rival: "On a stricter basis installed capacity stood at 15.1 GW at the end of June 2026, the industry review found. It counts a project only once every turbine exports power.",
        old: "The fleet currently has 13.8 GW of capacity installed, the largest in Europe. Further projects are planned for later in the decade.",
      };
      const rows = await Promise.all(
        (["opened", "preview", "rival", "old"] as const).map((key, i) =>
          prisma.researchSource.create({
            data: {
              userId: owner.id,
              runId: run.id,
              url: `https://src${i + 1}.example/${key}`,
              canonicalUrl: `https://src${i + 1}.example/${key}`,
              title: `Source ${key}`,
              snapshot: bodies[key],
              publishedAt: key === "old" ? new Date("2023-02-10T00:00:00Z") : new Date("2026-09-25T00:00:00Z"),
            },
          })
        )
      );
      // The run's ledger: three pages opened by a fetching stage, the preview
      // only ever seen as search-provider text, and the READ stage's
      // bookkeeping line for every source (which is not a fetch).
      const ledger = [
        ...[rows[0]!, rows[2]!, rows[3]!].map((row) => ({ url: row.url, title: row.title })),
        ...rows.map((row) => ({ url: row.url, title: row.title, ranked: true })),
      ];
      for (const [i, payload] of ledger.entries()) {
        await prisma.researchEvent.create({ data: { userId: owner.id, runId: run.id, seq: i + 1, kind: "source_read", payload } });
      }

      const result = await claims.recordCitationAudit({
        userId: owner.id,
        conversationId: conversation.id,
        messageId: message.id,
        runId: run.id,
        goal: "Fleet capacity",
        report,
        sources: rows.map((row) => ({
          sourceId: row.id,
          url: row.url,
          title: row.title,
          body: row.snapshot ?? "",
          publishedAt: row.publishedAt,
        })),
        judge: async () => ({ verdict: "supported", strength: 0.95 }),
        asOf: new Date("2026-10-25T12:00:00Z"),
      });
      assert.ok(result);
      assert.equal(result.claims, 4);
      assert.equal(result.supported, 1);
      assert.equal(result.contested, 1, "the uncited review gives 15.1 GW for the same date");
      assert.equal(result.unverified, 1, "the rating was checked only against a preview");
      assert.equal(result.partiallySupported, 1, "a 2023 page cannot say what is installed now");
      assert.equal(result.unsupported, 1);
      assert.equal(result.unresolvedCitations, 1);
      assert.doesNotMatch(result.report, /\[9\]/, "a citation to a source the corpus does not have never survives");
      assert.match(result.report, /Possibly out of date: The fleet currently has 13\.8 GW/);

      const audit = await prisma.researchEvent.findFirst({
        where: { runId: run.id, userId: owner.id, kind: "citation_audit" },
        orderBy: { seq: "desc" },
        select: { payload: true },
      });
      const payload = audit?.payload as Record<string, unknown>;
      assert.deepEqual(payload.readStates, {
        [rows[0]!.id]: "opened",
        [rows[1]!.id]: "search_preview",
        [rows[2]!.id]: "opened",
        [rows[3]!.id]: "opened",
      });
      assert.deepEqual(payload.truncatedSources, [rows[1]!.id]);
      assert.equal(payload.asOf, "2026-10-25T12:00:00.000Z");
      assert.equal((payload.rivals as unknown[]).length, 1);
      // A rival is never written as a link: the sources pill and the native
      // evidence list read links as "the claims that cite this source".
      const rivalLinks = await prisma.researchClaimLink.count({ where: { passage: { sourceId: rows[2]!.id } } });
      assert.equal(rivalLinks, 0);

      const view = await claims.loadCitationAuditForMessage(owner.id, message.id);
      assert.ok(view);
      assert.deepEqual(
        view.sources.map((source) => [source.index, source.readState, source.truncated]),
        [
          [1, "opened", false],
          [2, "search_preview", true],
          [3, "opened", false],
          [4, "opened", false],
        ]
      );
      const byText = (needle: string) => view.claims.find((claim) => claim.text.includes(needle))!;
      const capacity = byText("16.5 GW");
      assert.equal(capacity.status, "supported");
      assert.equal(capacity.contested, true);
      assert.equal(capacity.rivals.length, 1);
      assert.equal(capacity.rivals[0]!.sourceIndex, 3);
      assert.ok(capacity.rivals[0]!.codedReasons.every((reason) => reason.code === "figure_mismatch"));
      assert.deepEqual(capacity.unresolvedCitations, []);
      assert.equal(byText("4.8 out of 5").status, "unverified");
      const stale = byText("currently has 13.8 GW");
      assert.equal(stale.label, "partially supported");
      assert.ok(stale.links.some((link) => link.codedReasons.some((reason) => reason.code === "source_stale")));
      assert.deepEqual(byText("founded in Aberdeen").unresolvedCitations, [9]);
      assert.equal(view.summary.contested, 1);
      assert.equal(view.summary.unresolvedCitations, 1);
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.$disconnect();
    }
  });
}
