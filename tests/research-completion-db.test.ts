import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { ResearchCompletionInput } from "@/lib/research/completion";
import type { ParsedArtifact } from "@/lib/message-content";
import type { ArtifactTx } from "@/lib/artifact-writes";

/**
 * Real PostgreSQL completion atomicity. Opt in with a disposable, migrated
 * loopback database via RESEARCH_TEST_DATABASE_URL. Never falls back to an
 * application DATABASE_URL and never connects to a nonlocal host.
 *
 * RESEARCH_TEST_DATABASE_URL=postgresql://localhost/juno_research_test \
 * NODE_OPTIONS=--conditions=react-server \
 * npx tsx --test tests/research-completion-db.test.ts
 */
const DB_URL = process.env.RESEARCH_TEST_DATABASE_URL;

if (!DB_URL) {
  test("research completion database suite requires RESEARCH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const url = new URL(DB_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.searchParams.has("host")) {
    throw new Error("Research completion tests require an explicit loopback PostgreSQL host with no host override.");
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  // Test rows use an ephemeral key; no existing ciphertext is read or changed.
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "research-completion-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  test("research completion and Library persistence share the real PostgreSQL transaction", async (t) => {
    const { finalizeResearchRun } = await import("@/lib/research/completion");
    const { persistArtifacts } = await import("@/lib/artifacts-store");
    const { decryptMessageText } = await import("@/lib/message-crypto");
    const { prismaUnguarded } = await import("@/lib/prisma");
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `research-completion-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `research-completion-other-${suffix}@example.invalid` } });
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Completion isolation test" } });
    const lastMessageAt = new Date("2026-01-01T00:00:00Z");

    async function fixture(label: string, state = "validating_citations") {
      const conversation = await prisma.conversation.create({ data: { userId: owner.id, projectId: project.id, title: label, lastMessageAt } });
      const run = await prisma.researchRun.create({ data: { userId: owner.id, conversationId: conversation.id, goal: label, state, workerLeaseOwner: "fixture-worker", workerLeaseUntil: new Date(Date.now() + 60_000) } });
      const input: ResearchCompletionInput = {
        runId: run.id, userId: owner.id, conversationId: conversation.id,
        title: label, summary: "The checked source supports the fixture finding. [1]",
        report: "# Evidence\n\nThe checked source supports the fixture finding. [1]",
        sources: [{ title: "Primary fixture", url: "https://example.invalid/fixture", snippet: "", origin: "research" }],
        leadModel: "fixture-no-model-call",
        fact: { key: "research", runId: run.id, title: label, workedMs: 1500, cited: 1, read: 1, pages: 1, leadModel: "fixture-no-model-call", state: "completed" },
      };
      return { conversation, run, input };
    }
    async function savedState(conversationId: string, runId: string) {
      const [run, messages, artifacts, conversation] = await Promise.all([
        prisma.researchRun.findUniqueOrThrow({ where: { id: runId } }),
        prisma.message.findMany({ where: { conversationId } }),
        prisma.artifact.findMany({ where: { conversationId }, include: { versions: true } }),
        prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
      ]);
      return { run, messages, artifacts, conversation };
    }
    try {
      for (const terminal of ["completed", "partially_completed"] as const) {
        await t.test(`${terminal}: message, report, terminal run and conversation timestamp become visible together`, async () => {
          const { input, conversation, run } = await fixture(terminal);
          input.fact.state = terminal;
          input.to = terminal;
          let checkedUncommitted = false;
          const result = await finalizeResearchRun(input, {
            persistArtifacts: async (...args: Parameters<typeof persistArtifacts>) => {
              assert.ok(args[3]?.tx, "the caller must supply its real transaction");
              const stored = await persistArtifacts(...args);
              assert.equal(stored.length, 1);
              // A separate connection must see none of the staged writes.
              const beforeCommit = await savedState(conversation.id, run.id);
              assert.equal(beforeCommit.run.state, "validating_citations");
              assert.equal(beforeCommit.run.assistantMessageId, null);
              assert.equal(beforeCommit.messages.length, 0);
              assert.equal(beforeCommit.artifacts.length, 0);
              assert.equal(beforeCommit.conversation.lastMessageAt.getTime(), lastMessageAt.getTime());
              checkedUncommitted = true;
              return stored;
            },
          });
          assert.equal(checkedUncommitted, true);
          assert.ok(result.messageId);
          const saved = await savedState(conversation.id, run.id);
          assert.equal(saved.run.state, terminal);
          assert.equal(saved.run.assistantMessageId, result.messageId);
          assert.equal(saved.run.report, input.report);
          assert.equal(saved.run.workerLeaseOwner, null);
          assert.equal(saved.run.workerLeaseUntil, null);
          assert.equal(saved.messages.length, 1);
          assert.match(decryptMessageText(saved.messages[0].content), /<juno:artifact/);
          assert.equal(saved.artifacts.length, 1);
          assert.equal(saved.artifacts[0].messageId, result.messageId);
          assert.equal(saved.artifacts[0].userId, owner.id);
          assert.equal(saved.artifacts[0].projectId, project.id);
          assert.equal(saved.artifacts[0].identifier, `research-report-${run.id}`);
          assert.equal(saved.artifacts[0].versions.length, 1);
          assert.equal(saved.artifacts[0].versions[0].content, input.report);
          assert.ok(saved.conversation.lastMessageAt > lastMessageAt);
          // Restart/retry after commit must return the same pointer and never
          // call the artifact writer again or append a duplicate version.
          const replay = await finalizeResearchRun(input, { persistArtifacts: async () => { throw new Error("idempotent replay wrote again"); } });
          assert.equal(replay.messageId, result.messageId);
          const afterReplay = await savedState(conversation.id, run.id);
          assert.equal(afterReplay.messages.length, 1);
          assert.equal(afterReplay.artifacts.length, 1);
          assert.equal(afterReplay.artifacts[0].versions.length, 1);
        });
      }

      await t.test("an artifact failure after the real insert rolls back every completion write", async () => {
        const { input, conversation, run } = await fixture("Rollback after report insert");
        let insertedArtifactId: string | null = null;
        await assert.rejects(finalizeResearchRun(input, {
          persistArtifacts: async (...args: Parameters<typeof persistArtifacts>) => {
            const stored = await persistArtifacts(...args);
            assert.equal(stored.length, 1);
            insertedArtifactId = stored[0].id;
            throw new Error("Injected failure after the transactional artifact/version insert");
          },
        }), /Injected failure/);
        assert.ok(insertedArtifactId);
        const saved = await savedState(conversation.id, run.id);
        assert.equal(saved.run.state, "validating_citations");
        assert.equal(saved.run.assistantMessageId, null);
        assert.equal(saved.run.report, null);
        assert.equal(saved.run.finishedAt, null);
        assert.equal(saved.run.workerLeaseOwner, "fixture-worker");
        assert.equal(saved.messages.length, 0);
        assert.equal(saved.artifacts.length, 0);
        assert.equal(saved.conversation.lastMessageAt.getTime(), lastMessageAt.getTime());
        assert.equal(await prisma.artifactVersion.count({ where: { artifactId: insertedArtifactId! } }), 0);
        // The same run can subsequently finish; failure did not poison its state.
        assert.ok((await finalizeResearchRun(input)).messageId);
      });

      await t.test("concurrent finalizers emit one message and one Library report", async () => {
        const { input, conversation, run } = await fixture("Concurrent finalizers");
        let artifactWrites = 0;
        const persist = async (...args: Parameters<typeof persistArtifacts>) => {
          artifactWrites++;
          return persistArtifacts(...args);
        };
        const results = await Promise.all([
          finalizeResearchRun(input, { persistArtifacts: persist }),
          finalizeResearchRun(input, { persistArtifacts: persist }),
        ]);
        assert.ok(results[0].messageId);
        assert.equal(results[0].messageId, results[1].messageId);
        assert.equal(artifactWrites, 1);
        const saved = await savedState(conversation.id, run.id);
        assert.equal(saved.messages.length, 1);
        assert.equal(saved.artifacts.length, 1);
        assert.equal(saved.artifacts[0].versions.length, 1);
      });

      await t.test("the artifact owner read sees a conversation created inside the caller's transaction", async () => {
        let createdConversationId = "";
        const artifactId = await prisma.$transaction(async (tx) => {
          const conversation = await tx.conversation.create({ data: { userId: owner.id, projectId: project.id, title: "Uncommitted owner" } });
          createdConversationId = conversation.id;
          const message = await tx.message.create({ data: { conversationId: conversation.id, role: "ASSISTANT", content: "Transaction fixture" } });
          assert.equal(await prisma.conversation.findUnique({ where: { id: conversation.id } }), null);
          const parsed: ParsedArtifact[] = [{ identifier: "uncommitted-report", type: "MARKDOWN", title: "Report", content: "# Report" }];
          // The test's own client is untyped by the app's guarded extension; at
          // runtime the store takes any transaction client (asTx). Naming the
          // type here also sidesteps a TypeScript 5.9 checker crash on this call.
          const artifacts = await persistArtifacts(conversation.id, message.id, parsed, { tx: tx as ArtifactTx, userId: owner.id });
          assert.equal(artifacts.length, 1);
          return artifacts[0].id;
        });
        const saved = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
        assert.equal(saved.conversationId, createdConversationId);
        assert.equal(saved.userId, owner.id);
        assert.equal(saved.projectId, project.id);
      });

      await t.test("a cancelled run rolls the staged message and report back", async () => {
        const { input, conversation, run } = await fixture("Cancelled before completion", "cancelled");
        const result = await finalizeResearchRun(input);
        assert.deepEqual(result, { messageId: null, raced: true });
        const saved = await savedState(conversation.id, run.id);
        assert.equal(saved.run.state, "cancelled");
        assert.equal(saved.messages.length, 0);
        assert.equal(saved.artifacts.length, 0);
        assert.equal(saved.conversation.lastMessageAt.getTime(), lastMessageAt.getTime());
      });

      await t.test("a foreign user cannot finalize another account's run", async () => {
        const { input, conversation, run } = await fixture("Ownership boundary");
        assert.deepEqual(await finalizeResearchRun({ ...input, userId: other.id }), { messageId: null, raced: true });
        const saved = await savedState(conversation.id, run.id);
        assert.equal(saved.run.state, "validating_citations");
        assert.equal(saved.messages.length, 0);
        assert.equal(saved.artifacts.length, 0);
      });
    } finally {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.user.delete({ where: { id: other.id } });
      await prisma.$disconnect();
      await prismaUnguarded.$disconnect();
    }
  });
}
