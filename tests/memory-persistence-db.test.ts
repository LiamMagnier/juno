import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Long-term memory, end to end against real PostgreSQL:
 * learn → correct → recall → forget → reload.
 *
 * Everything runs through the production write and read paths — saveCandidates,
 * forgetStatements, getMemoryProfile, consolidateMemories and the /api/memory
 * route handlers — with only the session, `after()` and the models faked.
 * The models are deterministic fakes (an extractor-free fact list, an echoing
 * consolidator and a three-axis embedder), so this proves persistence and the
 * lifecycle rules, not any provider's judgement. Live model quality is not
 * measured here.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_memory_eval \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/memory-persistence-db.test.ts
 *
 * The database must be disposable and on loopback; the suite refuses anything else.
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("memory persistence suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-persistence-local-test";

  let signedIn: { id: string } | null = null;
  // Summary rebuilds the routes schedule with after(). Queued, not run, so each
  // check can ask what the NEXT turn sees before (or without) the rebuild —
  // the window in which a consolidation is slow, throttled or failing.
  const afterQueue: (() => unknown)[] = [];

  test.before(async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
    mock.module("@/lib/native-request", {
      namedExports: {
        requireNativeRequest: async () => {
          if (!signedIn) throw new Error("unauthenticated");
          return { user: { id: signedIn.id }, deviceSession: { id: "device-1" } };
        },
      },
    });
    const server = await import("next/server");
    mock.module("next/server", {
      namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) },
    });
  });

  const FAKE_MODEL = { id: "test:three-axis", provider: "openai", providerModel: "three-axis", dimensions: 3 } as const;
  // Home/city facts and "where do I live" share an axis; coffee another;
  // everything else the third. Enough for a paraphrase to find its fact.
  const vectorOf = (text: string): number[] => {
    const t = text.toLowerCase();
    if (/lisbon|porto|live|home|city/.test(t)) return [1, 0, 0];
    if (/coffee|espresso|caffeine/.test(t)) return [0, 1, 0];
    return [0, 0, 1];
  };
  const embed = async ({ texts }: { texts: string[] }) => ({ ok: true as const, model: FAKE_MODEL, vectors: texts.map(vectorOf) });
  const embedQuery = async ({ text }: { text: string }) => ({ ok: true as const, model: FAKE_MODEL, vector: vectorOf(text) });
  // Echoes the FACTS block, so the summary says exactly what it was fed.
  let consolidationPrompt = "";
  const echoConsolidator = async ({ userMsg }: { userMsg: string }) => {
    consolidationPrompt = userMsg;
    const facts = userMsg.split("FACTS (oldest to newest):")[1]?.split("\n\n")[0] ?? "";
    return `## Top of mind\n${facts.trim()}`;
  };

  const DAY = 86_400_000;

  test("learn → correct → recall → forget → reload, on real rows", async (t) => {
    // Assertions read with the unguarded client; the code under test uses the
    // ownership-guarded one, which is part of what is being exercised.
    const { prisma: guarded, prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const listRoute = await import("@/app/api/memory/route");
    const { encryptField, decryptField } = await import("@/lib/field-crypto");

    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `mem-a-${suffix}@example.invalid` } });
    const b = await prisma.user.create({ data: { email: `mem-b-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    });
    const chat = await prisma.conversation.create({ data: { userId: a.id, title: "Moving" } });
    const said = await prisma.message.create({
      data: { conversationId: chat.id, role: "USER", content: "I live in Lisbon these days." },
    });
    const profile = (userId: string, query: string, extra: { projectId?: string | null } = {}) =>
      memory.getMemoryProfile(userId, { conversationProvider: null, query, embed: embedQuery as never, ...extra });
    const fact = (userId: string, needle: string) =>
      prisma.memoryEntry.findFirst({ where: { userId, kind: "FACT", content: { contains: needle } } });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

    // ---- learn ---------------------------------------------------------
    await memory.saveCandidates(a.id, ["The user lives in Lisbon."], chat.id, {
      sourceMessageId: said.id,
      observedAt: new Date(Date.now() - 20 * DAY),
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    await memory.saveCandidates(a.id, ["The user drinks espresso every morning."], chat.id, {
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const lisbon = await fact(a.id, "Lisbon");
    assert.ok(lisbon, "the fact is written");
    assert.equal(lisbon.status, "active");
    assert.equal(lisbon.sourceRef, chat.id, "provenance: the chat it came from");
    assert.equal(lisbon.sourceMessageId, said.id, "provenance: the message it came from");
    assert.ok(lisbon.observedAt && lisbon.observedAt < lisbon.createdAt, "dated by when it was said, not when it was read");
    assert.equal(lisbon.embeddingModel, FAKE_MODEL.id, "embedded at write time");
    assert.deepEqual(lisbon.embedding, [1, 0, 0]);

    // ---- correct: a newer fact supersedes the older one ----------------
    await memory.saveCandidates(a.id, ["The user lives in Porto."], chat.id, {
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const porto = await fact(a.id, "Porto");
    const lisbonAfter = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: lisbon.id } });
    assert.ok(porto);
    assert.equal(porto.status, "active");
    assert.equal(lisbonAfter.status, "superseded", "the older belief is retired");
    assert.equal(lisbonAfter.supersededById, porto.id, "…and points at what replaced it");
    assert.ok(lisbonAfter.reason, "…with a reason the memory page can show");

    // An older statement arriving late (a re-read of history) never beats the newer one.
    await memory.saveCandidates(a.id, ["The user lives in Lisbon."], chat.id, {
      observedAt: new Date(Date.now() - 40 * DAY),
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: porto.id } })).status, "active");
    assert.equal(
      await prisma.memoryEntry.count({ where: { userId: a.id, kind: "FACT", status: "active", content: { contains: "Lisbon" } } }),
      0,
      "a stale restatement does not resurrect the old city",
    );

    // ---- recall --------------------------------------------------------
    const home = await profile(a.id, "Where is my home these days?");
    assert.ok(home.recent.some((c) => c.includes("Porto")), "the current fact is recalled, semantically");
    assert.ok(!home.recent.some((c) => c.includes("Lisbon")), "the superseded one is not");
    const used = home.used.find((m) => m.content.includes("Porto"));
    assert.equal(used?.sourceRef, chat.id, "the receipt carries provenance");
    assert.ok((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: porto.id } })).lastUsedAt, "used means stamped");

    // ---- stale: an expired temporary fact is not believed --------------
    const trip = await prisma.memoryEntry.create({
      data: {
        userId: a.id,
        content: "The user is in Berlin for a conference this week.",
        category: "temporary",
        expiresAt: new Date(Date.now() - DAY),
        observedAt: new Date(Date.now() - 8 * DAY),
      },
    });
    assert.ok(!(await profile(a.id, "Berlin conference plans")).recent.some((c) => c.includes("Berlin")));
    assert.equal(await memory.sweepExpiredMemories(a.id), 1);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: trip.id } })).status, "expired");

    // ---- project scoping ----------------------------------------------
    const thesis = await prisma.project.create({ data: { userId: a.id, name: "Thesis" } });
    await memory.saveCandidates(a.id, ["The thesis uses a mixed-methods design."], chat.id, {
      projectId: thesis.id,
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const ordinary = await profile(a.id, "thesis mixed-methods design");
    assert.ok(!ordinary.recent.some((c) => c.includes("thesis")), "a project fact stays out of ordinary chats");
    const inProject = await profile(a.id, "thesis mixed-methods design espresso", { projectId: thesis.id });
    assert.ok(inProject.recent.some((c) => c.includes("thesis")), "…and is recalled inside its project");
    assert.ok(!inProject.recent.some((c) => c.includes("espresso")), "a project chat reads its project in isolation");

    // ---- cross-account isolation --------------------------------------
    await memory.saveCandidates(b.id, ["The user lives in Oslo."], undefined, { policy: { mode: "any_allowed_provider" } as never });
    const bProfile = await profile(b.id, "Where do I live? Porto? Lisbon? espresso?");
    assert.ok(!bProfile.recent.some((c) => /Porto|Lisbon|espresso/.test(c)), "B never reads A's facts");
    const aProfile = await profile(a.id, "Do I live in Oslo?");
    assert.ok(!aProfile.recent.some((c) => c.includes("Oslo")), "A never reads B's facts");
    signedIn = { id: b.id };
    assert.equal((await itemRoute.DELETE(new Request("http://x", { method: "DELETE" }), ctx(porto.id))).status, 404);
    assert.equal(
      (await itemRoute.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ forget: true }) }), ctx(porto.id))).status,
      404,
    );
    await memory.forgetStatements(b.id, ["The user lives in Porto."]);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: porto.id } })).status, "active", "B's forget never touches A");
    const listedForB = (await (await listRoute.GET(new Request("http://x/api/memory"))).json()) as { memories: { id: string }[] };
    const aIds = new Set((await prisma.memoryEntry.findMany({ where: { userId: a.id }, select: { id: true } })).map((r) => r.id));
    assert.ok(listedForB.memories.length > 0 && !listedForB.memories.some((m) => aIds.has(m.id)), "the memory page lists only your own");

    // ---- consolidation, and its interaction with delete and forget -----
    signedIn = { id: a.id };
    const built = await memory.consolidateMemories({ userId: a.id, llm: echoConsolidator as never });
    assert.equal(built.status, "updated");
    assert.ok(!consolidationPrompt.includes("Lisbon"), "superseded beliefs are not fed to the summary");
    assert.ok(!consolidationPrompt.includes("thesis"), "project facts are not fed to the account summary");
    const sealed = await prisma.memorySummary.findUniqueOrThrow({ where: { userId: a.id } });
    assert.ok(!sealed.content.includes("Porto"), "the summary is encrypted at rest");
    assert.ok(decryptField(sealed.content).includes("Porto"));

    // Delete a fact the summary quotes. The rebuild is scheduled with after();
    // until it runs (or if it fails), the next turn must not hear the deleted
    // fact from the summary's prose.
    const espresso = await fact(a.id, "espresso");
    assert.ok(espresso);
    const deleted = await itemRoute.DELETE(new Request("http://x", { method: "DELETE" }), ctx(espresso.id));
    assert.equal(deleted.status, 200);
    assert.equal(await prisma.memoryEntry.count({ where: { id: espresso.id } }), 0, "the row is gone");
    assert.equal(
      (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "MemoryEntry" WHERE "userId" = ${a.id} AND content ILIKE '%espresso%'`)[0].n,
      BigInt(0),
      "…with its embedding (same row) — no derived copy left in the table",
    );
    const afterDelete = await profile(a.id, "what do I drink in the morning, coffee?");
    assert.ok(!(afterDelete.summary ?? "").includes("espresso"), "a deleted fact is not injected from the old summary");
    assert.ok(!afterDelete.recent.some((c) => c.includes("espresso")));
    assert.equal(afterQueue.length, 1, "a summary rebuild was scheduled");
    afterQueue.length = 0;

    // Forget through the page. The retired row keeps its text (the trail) but
    // not a semantic vector of what the person asked to be forgotten.
    await memory.consolidateMemories({ userId: a.id, llm: echoConsolidator as never });
    const forgot = await itemRoute.PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ forget: true }) }),
      ctx(porto.id),
    );
    assert.equal(forgot.status, 200);
    const portoForgotten = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: porto.id } });
    assert.equal(portoForgotten.status, "suppressed");
    assert.deepEqual(portoForgotten.embedding, [], "a forgotten fact's embedding is removed");
    assert.equal(portoForgotten.embeddingModel, null);
    const afterForget = await profile(a.id, "Where is my home these days?");
    assert.ok(!(afterForget.summary ?? "").includes("Porto"), "the old summary is benched after a forget");
    assert.ok(!afterForget.recent.some((c) => c.includes("Porto")));
    // The chat it came from, read again, does not bring it back.
    const relearn = await memory.saveCandidates(a.id, ["The user lives in Porto."], chat.id, { policy: { mode: "any_allowed_provider" } as never });
    assert.equal(relearn.created, 0, "a forgotten fact is refused on re-extraction");
    const rebuilt = await memory.consolidateMemories({ userId: a.id, llm: echoConsolidator as never });
    assert.ok(rebuilt.status !== "updated" || !rebuilt.content.includes("Porto"), "the rebuilt summary leaves it out");
    assert.ok(consolidationPrompt.includes("SUPPRESSED"), "…because the consolidator is told");

    // Forget from inside a chat takes the same path.
    await memory.saveCandidates(a.id, ["The user's dog is called Biscuit."], chat.id, {
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const outcome = await memory.forgetStatements(a.id, ["The user's dog is called Biscuit."]);
    assert.equal(outcome.retired, 1);
    const biscuit = await fact(a.id, "Biscuit");
    assert.equal(biscuit?.status, "suppressed");
    assert.deepEqual(biscuit?.embedding, [], "forgetStatements removes the vector too");

    // ---- compaction: duplicate merge keeps one belief, history intact --
    await prisma.memoryEntry.createMany({
      data: [
        { userId: a.id, content: "The user prefers tea over coffee.", observedAt: new Date(Date.now() - 3 * DAY), source: "AUTO" },
        { userId: a.id, content: "User prefers tea over coffee", observedAt: new Date(Date.now() - DAY), source: "AUTO" },
      ],
    });
    await memory.reconcileMemoryTimeline(a.id);
    const teas = await prisma.memoryEntry.findMany({ where: { userId: a.id, content: { contains: "tea over coffee" } } });
    assert.equal(teas.filter((r) => r.status === "active").length, 1, "near-duplicates compact to one active belief");
    const retiredTea = teas.find((r) => r.status !== "active");
    assert.ok(retiredTea?.supersededById, "…and the merged row points at the survivor");
    const teaRecall = await profile(a.id, "tea or coffee preference");
    assert.equal(teaRecall.recent.filter((c) => c.includes("tea over coffee")).length, 1, "recall says it once");
    assert.ok(!teaRecall.recent.some((c) => /Porto|Biscuit/.test(c)), "compaction resurrects nothing forgotten");

    // ---- reload: a fresh connection reads the same state ---------------
    await guarded.$disconnect();
    await prisma.$disconnect();
    const reloaded = await profile(a.id, "tea or coffee, and where do I live?");
    assert.ok(reloaded.recent.some((c) => c.includes("tea over coffee")));
    assert.ok(!reloaded.recent.some((c) => /Porto|Lisbon|Biscuit|espresso/.test(c)), "nothing deleted or forgotten returns");

    // ---- reset: everything derived goes ------------------------------
    await prisma.conversationMemory.upsert({
      where: { conversationId: chat.id },
      create: { userId: a.id, conversationId: chat.id, processedAt: new Date(), digest: "Moving to Porto", factCount: 3 },
      update: { digest: "Moving to Porto" },
    });
    await prisma.projectMemorySummary.create({ data: { userId: a.id, projectId: thesis.id, content: encryptField("Mixed methods.") } });
    await prisma.memoryEdit.create({ data: { userId: a.id, clientId: "c1", instruction: "forget Porto" } });
    const reset = await listRoute.DELETE(new Request("http://x/api/memory", { method: "DELETE" }));
    assert.equal(reset.status, 200);
    assert.equal(await prisma.memoryEntry.count({ where: { userId: a.id } }), 0, "every fact, suppression and vector");
    assert.equal(await prisma.memorySummary.count({ where: { userId: a.id } }), 0);
    assert.equal(await prisma.projectMemorySummary.count({ where: { userId: a.id } }), 0);
    assert.equal(await prisma.memoryEdit.count({ where: { userId: a.id } }), 0);
    const state = await prisma.conversationMemory.findUniqueOrThrow({ where: { conversationId: chat.id } });
    assert.equal(state.digest, null, "chat digests (summary inputs) are erased");
    assert.deepEqual(await memory.pendingBackfill(a.id), [], "and nothing is queued to be re-learned");
    assert.ok(await prisma.memoryEntry.count({ where: { userId: b.id } }) > 0, "B's memory is untouched by A's reset");
    const empty = await profile(a.id, "where do I live?");
    assert.equal(empty.summary, null);
    assert.deepEqual(empty.recent, []);
  });

  test("every delete and rewrite path takes a summary that quotes the old fact out of service", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const applyRoute = await import("@/app/api/memory/edit/apply/route");
    const mutations = await import("@/app/api/v1/mutations/route");
    const { encryptField } = await import("@/lib/field-crypto");

    const user = await prisma.user.create({ data: { email: `mem-paths-${randomUUID()}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    signedIn = { id: user.id };
    const project = await prisma.project.create({ data: { userId: user.id, name: "Garden" } });
    const seed = async (content: string, projectId: string | null = null) => {
      const row = await prisma.memoryEntry.create({
        data: { userId: user.id, content, projectId, source: "MANUAL", observedAt: new Date(Date.now() - DAY) },
      });
      return row;
    };
    // A summary written after the facts, quoting all of them — what a rebuild
    // that has not happened yet leaves in place.
    const summarize = async () => {
      const facts = await prisma.memoryEntry.findMany({ where: { userId: user.id, kind: "FACT", status: "active" } });
      const account = facts.filter((f) => f.projectId === null).map((f) => f.content).join(" ");
      const garden = facts.filter((f) => f.projectId === project.id).map((f) => f.content).join(" ");
      await prisma.memorySummary.upsert({
        where: { userId: user.id },
        create: { userId: user.id, content: encryptField(account), entryCount: 99 },
        update: { content: encryptField(account) },
      });
      await prisma.projectMemorySummary.upsert({
        where: { userId_projectId: { userId: user.id, projectId: project.id } },
        create: { userId: user.id, projectId: project.id, content: encryptField(garden), entryCount: 99 },
        update: { content: encryptField(garden) },
      });
    };
    const injected = async (projectId: string | null = null) => {
      const p = await memory.getMemoryProfile(user.id, { conversationProvider: null, query: "anything", projectId });
      return [p.summary ?? "", ...p.recent].join("\n");
    };
    // The current revision, as a synced device would hold it (triggers bump it on every write).
    const native = async (operation: { entityId: string }) => {
      const baseRevision =
        (await prisma.entityRevision.findFirst({ where: { accountId: user.id, entityType: "memory", entityId: operation.entityId } }))
          ?.revision ?? 0;
      return mutations.POST(
        new Request("http://x/api/v1/mutations", {
          method: "POST",
          body: JSON.stringify({ clientMutationId: randomUUID(), baseRevision, operation }),
        }),
      );
    };

    // Web: rewrite a fact. The account summary quoting the old text is benched.
    const job = await seed("The user works at Initech.");
    await seed("The user has a cat named Miso.");
    await summarize();
    assert.ok((await injected()).includes("Initech"), "precondition: the summary quotes it");
    const patched = await itemRoute.PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ content: "The user works at Globex." }) }),
      { params: Promise.resolve({ id: job.id }) },
    );
    assert.equal(patched.status, 200);
    assert.ok(!(await injected()).includes("Initech"), "web rewrite: the old text is not injected");

    // Web: move a fact into a project. The account summary must stop quoting it everywhere.
    await summarize();
    const moved = await itemRoute.PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ projectId: project.id }) }),
      { params: Promise.resolve({ id: job.id }) },
    );
    assert.equal(moved.status, 200);
    assert.ok(!(await injected()).includes("Globex"), "web move: no longer quoted outside its project");

    // Natural-language edit: remove a project fact. Its project's summary is benched.
    const bed = await seed("The raised bed gets six hours of sun.", project.id);
    await summarize();
    assert.ok((await injected(project.id)).includes("six hours"), "precondition: the project summary quotes it");
    const applied = await applyRoute.POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ operations: [{ op: "remove", id: bed.id, before: bed.content }] }),
      }),
    );
    assert.equal(applied.status, 200);
    assert.ok(!(await injected(project.id)).includes("six hours"), "edit remove: the project summary no longer quotes it");

    // Native sync: rewrite, then delete. Neither path scheduled any rebuild before.
    const cat = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Miso" } } });
    await prisma.memoryEntry.update({ where: { id: cat.id }, data: { embedding: [1, 0, 0], embeddingModel: "test:three-axis" } });
    await summarize();
    const rewritten = await native({ type: "memory.update", entityId: cat.id, content: "The user has a cat named Tofu." } as never);
    assert.equal(rewritten.status, 200, await rewritten.clone().text());
    assert.ok(!(await injected()).includes("Miso"), "native rewrite: the old text is not injected");
    const catAfter = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: cat.id } });
    assert.deepEqual(catAfter.embedding, [], "native rewrite: the old sentence's vector is dropped");
    assert.ok(catAfter.normalized?.includes("tofu"), "native rewrite: the comparable form follows the new text");

    const older = await seed("The user has a cat named Miso.");
    await prisma.memoryEntry.update({ where: { id: older.id }, data: { status: "superseded", supersededById: cat.id } });
    await summarize();
    const removed = await native({ type: "memory.delete", entityId: cat.id } as never);
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.ok(!(await injected()).includes("Tofu"), "native delete: the deleted fact is not injected");
    const orphan = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: older.id } });
    assert.equal(orphan.supersededById, null, "native delete: no dangling 'replaced by'");
    afterQueue.length = 0;
  });
}
