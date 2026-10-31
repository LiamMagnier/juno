import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Master brief §10.3 — transparent and accurate memory — end to end against
 * real PostgreSQL, through the production routes:
 *
 *   - a typed fact supersedes the inferred one it contradicts, with history,
 *     and a typed duplicate confirms instead of copying (POST /api/memory,
 *     PATCH /api/memory/[id], the native memory.create);
 *   - why / when / source and the history trail for one fact
 *     (GET /api/memory/[id]), including a chat that has since been deleted;
 *   - topic exclusion: retire, refuse on every writer, keep out of retrieval
 *     and out of the summary, and lift (POST /api/memory/topics);
 *   - switching a sensitive topic off stops inferred facts on it from being
 *     used and takes the summaries written while it was on out of service
 *     (PATCH /api/settings);
 *   - deletion propagation: a deleted fact leaves no pointer and no quote in
 *     the rows that remain, and deleting a chat benches the summary its digest
 *     went into (DELETE /api/memory/[id], DELETE /api/conversations/[id]);
 *   - the native app's update, delete and chat delete do the same
 *     (POST /api/v1/mutations: memory.update, memory.delete,
 *     conversation.delete);
 *   - Undo puts a retired row back as it was, a topic added on the memory page
 *     says so, and an edit cannot list the same topic twice
 *     (POST /api/memory/edit/apply, POST /api/memory/topics);
 *   - an export imported into another account still names the chats its
 *     facts came from (GET /api/account/export → POST /api/import).
 *
 * Same harness as memory-persistence-db.test.ts: only the session, `after()`
 * and the models are faked.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54481/juno_memory_eval \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/memory-transparency-db.test.ts
 *
 * The database must be disposable and on loopback; the suite refuses anything else.
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("memory transparency suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-transparency-local-test";

  let signedIn: { id: string } | null = null;
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
    // @/lib/auth pulls next-auth (and with it client navigation code React's
    // server build cannot load); the settings route only needs its defaults row.
    mock.module("@/lib/auth", {
      namedExports: {
        ensureUserDefaults: async (userId: string) => {
          const { prismaUnguarded } = await import("@/lib/prisma");
          await prismaUnguarded.settings.upsert({ where: { userId }, create: { userId }, update: {} });
        },
      },
    });
    const server = await import("next/server");
    mock.module("next/server", {
      namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) },
    });
  });

  const DAY = 86_400_000;
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let consolidationPrompt = "";
  const echoConsolidator = async ({ userMsg }: { userMsg: string }) => {
    consolidationPrompt = userMsg;
    const facts = userMsg.split("FACTS (oldest to newest):")[1]?.split("\n\n")[0] ?? "";
    return `## Top of mind\n${facts.trim()}`;
  };

  async function newUser(label: string) {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const user = await prisma.user.create({ data: { email: `mem-${label}-${randomUUID()}@example.invalid` } });
    signedIn = { id: user.id };
    return user;
  }

  test("a typed correction supersedes with history; a typed duplicate confirms; provenance and history explain both", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const listRoute = await import("@/app/api/memory/route");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const mutations = await import("@/app/api/v1/mutations/route");
    const user = await newUser("typed");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Moving house" } });
    const said = await prisma.message.create({ data: { conversationId: chat.id, role: "USER", content: "I live in Lisbon." } });
    const saidAt = new Date(Date.now() - 200 * DAY);
    await memory.saveCandidates(user.id, ["The user lives in Lisbon.", "The user prefers dark mode."], chat.id, {
      sourceMessageId: said.id,
      observedAt: saidAt,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const lisbon = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Lisbon" } } });

    // ---- a typed correction replaces the inferred belief ---------------
    const added = await listRoute.POST(new Request("http://x/api/memory", json({ content: "The user lives in Porto." })));
    assert.equal(added.status, 201);
    const body = (await added.json()) as { memory: { id: string; provenance: { why: string } }; action: string; replaced: { id: string }[] };
    assert.equal(body.action, "created");
    assert.deepEqual(body.replaced.map((r) => r.id), [lisbon.id], "the response names what it replaced");
    assert.match(body.memory.provenance.why, /^You added this yourself/);
    const lisbonAfter = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: lisbon.id } });
    assert.equal(lisbonAfter.status, "superseded");
    assert.equal(lisbonAfter.supersededById, body.memory.id);
    assert.match(lisbonAfter.reason ?? "", /You said this yourself/);
    const recalled = await memory.getMemoryProfile(user.id, { conversationProvider: null, query: "where do I live, Porto or Lisbon?" });
    assert.ok(recalled.recent.some((c) => c.includes("Porto")));
    assert.ok(!recalled.recent.some((c) => c.includes("Lisbon")), "only one answer to where the person lives");

    // ---- a typed duplicate confirms the row instead of copying it -------
    const dup = await listRoute.POST(new Request("http://x/api/memory", json({ content: "the user prefers dark mode" })));
    assert.equal(dup.status, 200);
    const dupBody = (await dup.json()) as { memory: { id: string; source: string }; action: string };
    assert.equal(dupBody.action, "confirmed");
    assert.equal(dupBody.memory.source, "MANUAL", "now something the person said");
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, content: { contains: "dark mode" } } }), 1);

    // ---- why / when / source, and the trail -------------------------
    const detail = (await (await itemRoute.GET(new Request("http://x"), ctx(lisbon.id))).json()) as {
      provenance: { source: { label: string; href: string | null }; when: { saidAt: string; recordedAt: string }; status: { label: string } };
      history: { later: { id: string }[]; current: { id: string } | null };
    };
    assert.equal(detail.provenance.source.label, "From “Moving house”");
    assert.equal(detail.provenance.source.href, `/chat/${chat.id}?m=${encodeURIComponent(said.id)}`);
    assert.equal(detail.provenance.when.saidAt, saidAt.toISOString(), "dated by when it was said");
    assert.notEqual(detail.provenance.when.recordedAt, detail.provenance.when.saidAt);
    assert.equal(detail.provenance.status.label, "Replaced");
    assert.deepEqual(detail.history.later.map((s) => s.id), [body.memory.id]);
    assert.equal(detail.history.current?.id, body.memory.id);
    const porto = (await (await itemRoute.GET(new Request("http://x"), ctx(body.memory.id))).json()) as { history: { earlier: { id: string }[] } };
    assert.deepEqual(porto.history.earlier.map((s) => s.id), [lisbon.id]);

    // ---- the pencil: a rewrite settles its scope too ------------------
    await memory.saveCandidates(user.id, ["The user works at Initech.", "The user drinks espresso."], chat.id, {
      policy: { mode: "any_allowed_provider" } as never,
    });
    const initech = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Initech" } } });
    const espresso = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "espresso" } } });
    const patched = await itemRoute.PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ content: "The user works at Hooli." }) }),
      ctx(espresso.id)
    );
    assert.equal(patched.status, 200);
    assert.deepEqual(((await patched.json()) as { replaced: { id: string }[] }).replaced.map((r) => r.id), [initech.id]);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: initech.id } })).status, "superseded");

    // ---- an applied edit settles its scope, and its Undo puts things back ----
    const applyRoute = await import("@/app/api/memory/edit/apply/route");
    const applied = await applyRoute.POST(
      new Request("http://x", json({ operations: [{ op: "add", content: "The user lives in Braga." }] }))
    );
    assert.equal(applied.status, 200, await applied.clone().text());
    const { inverse } = (await applied.json()) as { inverse: unknown[] };
    const braga = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Braga" } } });
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: body.memory.id } })).status, "superseded", "Porto replaced by the edit");
    const undone = await applyRoute.POST(new Request("http://x", json({ operations: inverse })));
    assert.equal(undone.status, 200, await undone.clone().text());
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: body.memory.id } })).status, "active", "Undo: Porto believed again");
    assert.equal(await prisma.memoryEntry.count({ where: { id: braga.id } }), 0, "Undo: the added fact is gone");

    // ---- another device: a typed duplicate maps onto the existing row ----
    const before = await prisma.memoryEntry.count({ where: { userId: user.id } });
    const nativeAdd = await mutations.POST(
      new Request("http://x/api/v1/mutations", {
        method: "POST",
        body: JSON.stringify({
          clientMutationId: randomUUID(),
          baseRevision: 0,
          operation: { type: "memory.create", clientEntityId: randomUUID(), content: "The user lives in Porto." },
        }),
      })
    );
    assert.equal(nativeAdd.status, 200, await nativeAdd.clone().text());
    const nativeBody = (await nativeAdd.json()) as { entityMappings?: Record<string, string>; entity?: { id: string } };
    const mappedId = nativeBody.entity?.id ?? Object.values(nativeBody.entityMappings ?? {})[0];
    assert.equal(mappedId, body.memory.id, "the device's new row resolves to the fact already believed");
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id } }), before, "no copy written");
    // And a native add of a NEW fact is classified like a web add.
    const nativeNew = await mutations.POST(
      new Request("http://x/api/v1/mutations", {
        method: "POST",
        body: JSON.stringify({
          clientMutationId: randomUUID(),
          baseRevision: 0,
          operation: { type: "memory.create", clientEntityId: randomUUID(), content: "The user prefers metric units." },
        }),
      })
    );
    assert.equal(nativeNew.status, 200, await nativeNew.clone().text());
    const metric = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "metric" } } });
    assert.equal(metric.category, "preferences");
    assert.equal(metric.confidence, 0.9);
    assert.ok(metric.normalized && metric.observedAt, "comparable form and said-at are written");
    afterQueue.length = 0;
  });

  test("excluding a topic retires it, refuses it everywhere, keeps it out of context and the summary — and can be lifted", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const listRoute = await import("@/app/api/memory/route");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const topicsRoute = await import("@/app/api/memory/topics/route");
    const user = await newUser("topic");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await memory.saveCandidates(
      user.id,
      ["The user is going through a divorce.", "The user's divorce lawyer is called Ana.", "The user lives in Porto."],
      undefined,
      { policy: { mode: "any_allowed_provider" } as never }
    );
    await memory.consolidateMemories({ userId: user.id, llm: echoConsolidator as never });
    assert.ok((await memory.getMemorySummary(user.id))?.content.includes("divorce"), "precondition: the summary says it");

    const added = await topicsRoute.POST(new Request("http://x", json({ topic: "Never remember anything about my divorce" })));
    assert.equal(added.status, 201);
    const addedBody = (await added.json()) as { topic: { id: string; topic: string }; retired: number };
    assert.equal(addedBody.topic.topic, "my divorce");
    assert.equal(addedBody.retired, 2);
    const row = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: addedBody.topic.id } });
    assert.equal(row.content, "Anything about my divorce", "stored in its one canonical phrasing");
    assert.equal(row.category, "topic");
    assert.equal(
      await prisma.memoryEntry.count({ where: { userId: user.id, kind: "FACT", status: "active", content: { contains: "divorce" } } }),
      0
    );
    const again = await topicsRoute.POST(new Request("http://x", json({ topic: "my divorce" })));
    assert.equal(again.status, 200, "the same topic twice is one row");
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, kind: "SUPPRESSION" } }), 1);

    // The summary that said it is benched at once, and rebuilt without it.
    const profile = await memory.getMemoryProfile(user.id, { conversationProvider: null, query: "what do you know about my divorce and Ana?" });
    assert.equal(profile.summary, null, "the old prose is not injected");
    assert.ok(!profile.recent.some((c) => /divorce/i.test(c)));
    await memory.consolidateMemories({ userId: user.id, llm: async () => "## Personal context\nThe user lives in Porto. They are going through a divorce." });
    const rebuilt = await memory.getMemorySummary(user.id);
    assert.ok(rebuilt && !/divorce/i.test(rebuilt.content), "a summariser that ignores the rule is checked, not trusted");
    assert.match(rebuilt!.content, /Porto/);

    // Every writer refuses the topic.
    const learned = await memory.saveCandidates(user.id, ["The user divorced their husband in 2025."], undefined, {
      policy: { mode: "any_allowed_provider" } as never,
    });
    assert.equal(learned.created, 0);
    assert.equal(learned.rejected, 1);
    const typed = await listRoute.POST(new Request("http://x/api/memory", json({ content: "The user's divorce is final." })));
    assert.equal(typed.status, 409);
    assert.match(((await typed.json()) as { error: string }).error, /not to remember anything about “my divorce”/);

    // Lifted: allowed from now on (retired facts stay retired).
    const lifted = await itemRoute.DELETE(new Request("http://x", { method: "DELETE" }), ctx(addedBody.topic.id));
    assert.equal(lifted.status, 200);
    assert.deepEqual(((await (await topicsRoute.GET()).json()) as { topics: unknown[] }).topics, []);
    const afterLift = await listRoute.POST(new Request("http://x/api/memory", json({ content: "The user's divorce is final." })));
    assert.equal(afterLift.status, 201);
    afterQueue.length = 0;
  });

  test("switching a sensitive topic off stops its inferred facts being used or summarised", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const settingsRoute = await import("@/app/api/settings/route");
    const { encryptField } = await import("@/lib/field-crypto");
    const user = await newUser("sensitive");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    await prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, memorySensitiveTopics: ["health"] },
      update: { memorySensitiveTopics: ["health"] },
    });
    await memory.saveCandidates(user.id, ["The user has asthma.", "The user lives in Porto."], undefined, {
      policy: { mode: "any_allowed_provider" } as never,
      allowedSensitiveTopics: ["health"],
    });
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, content: { contains: "asthma" } } }), 1);
    const asked = "running with asthma in the Porto heat";
    // getMemoryProfile reads the setting through a per-request cache; a fresh
    // import is not needed because the test changes it through the route.
    assert.ok((await memory.getMemoryProfile(user.id, { conversationProvider: null, query: asked })).recent.some((c) => c.includes("asthma")));
    await prisma.memorySummary.create({ data: { userId: user.id, content: encryptField("The user has asthma."), entryCount: 2 } });

    const res = await settingsRoute.PATCH(
      new Request("http://x/api/settings", { method: "PATCH", body: JSON.stringify({ memorySensitiveTopics: [] }) })
    );
    assert.equal(res.status, 200);
    assert.equal(await prisma.memorySummary.count({ where: { userId: user.id } }), 0, "the summary written while it was on is gone");
    const after = await memory.getMemoryProfile(user.id, { conversationProvider: null, query: asked });
    assert.ok(!after.recent.some((c) => c.includes("asthma")), "an inferred health fact is no longer used");
    assert.ok(after.recent.some((c) => c.includes("Porto")));
    await memory.consolidateMemories({ userId: user.id, llm: echoConsolidator as never });
    assert.ok(!consolidationPrompt.includes("asthma"), "nor shown to the summariser");
    afterQueue.length = 0;
  });

  test("deleting a fact or a chat leaves nothing of it behind in memory", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const listRoute = await import("@/app/api/memory/route");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const conversationRoute = await import("@/app/api/conversations/[id]/route");
    const { encryptField } = await import("@/lib/field-crypto");
    const user = await newUser("delete");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    // A merge: the re-judge pass retires one row into the other, quoting it.
    await memory.saveCandidates(
      user.id,
      ["The user prefers short answers with code examples.", "The user prefers short answers with examples."],
      undefined,
      { policy: { mode: "any_allowed_provider" } as never }
    );
    await memory.reconcileMemoryTimeline(user.id, new Date());
    const merged = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, status: "superseded" } });
    const keeper = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: merged.supersededById! } });
    assert.ok(merged.reason?.includes(keeper.content), "precondition: the merge reason quotes the kept fact");
    await prisma.memorySummary.create({ data: { userId: user.id, content: encryptField(keeper.content), entryCount: 2 } });

    const deleted = await itemRoute.DELETE(new Request("http://x", { method: "DELETE" }), ctx(keeper.id));
    assert.equal(deleted.status, 200);
    const left = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: merged.id } });
    assert.equal(left.supersededById, null, "no pointer at the deleted fact");
    assert.ok(!left.reason?.includes(keeper.content), "and no row quotes it");
    assert.equal(left.status, "superseded", "deleting is not a claim the older wording is true again");
    assert.equal(await prisma.memorySummary.count({ where: { userId: user.id } }), 0, "nor does a summary");

    // Deleting a chat: its digest stops speaking through the summary; its facts stay, honestly sourced.
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Trip planning" } });
    await prisma.conversationMemory.create({
      data: { userId: user.id, conversationId: chat.id, processedAt: new Date(), digest: "Planned a trip to Kyoto" },
    });
    await memory.saveCandidates(user.id, ["The user is planning a trip to Kyoto in spring."], chat.id, {
      policy: { mode: "any_allowed_provider" } as never,
    });
    await prisma.memorySummary.create({ data: { userId: user.id, content: encryptField("Planning a Kyoto trip."), entryCount: 3 } });
    const gone = await conversationRoute.DELETE(new Request("http://x", { method: "DELETE" }), ctx(chat.id));
    assert.equal(gone.status, 200);
    assert.equal(await prisma.memorySummary.count({ where: { userId: user.id } }), 0, "the summary built from its digest is benched");
    const listed = (await (await listRoute.GET(new Request("http://x/api/memory"))).json()) as {
      memories: { content: string; provenance: { source: { conversationUnavailable: boolean; label: string; href: string | null } } }[];
    };
    const kyoto = listed.memories.find((m) => m.content.includes("Kyoto"));
    assert.ok(kyoto, "the fact is the person's, and stays");
    assert.equal(kyoto!.provenance.source.conversationUnavailable, true);
    assert.equal(kyoto!.provenance.source.href, null);
    assert.equal(kyoto!.provenance.source.label, "From a chat that’s no longer available");
    afterQueue.length = 0;
  });

  // ---- the native app's paths (POST /api/v1/mutations) ---------------------

  async function revisionOf(accountId: string, entityType: string, entityId: string) {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const row = await prisma.entityRevision.findUnique({
      where: { accountId_entityType_entityId: { accountId, entityType, entityId } },
    });
    return row?.revision ?? 0;
  }
  async function mutate(operation: Record<string, unknown>, baseRevision: number) {
    const mutations = await import("@/app/api/v1/mutations/route");
    const res = await mutations.POST(
      new Request("http://x/api/v1/mutations", {
        method: "POST",
        body: JSON.stringify({ clientMutationId: randomUUID(), baseRevision, operation }),
      })
    );
    return { status: res.status, text: await res.text() };
  }

  test("another device: an update settles its scope, a delete propagates, a chat delete benches its summary", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const { encryptField } = await import("@/lib/field-crypto");
    const user = await newUser("native");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    // memory.update — the rewrite goes through settleRewrittenFact.
    await memory.saveCandidates(user.id, ["The user works at Initech.", "The user drinks espresso."], undefined, {
      policy: { mode: "any_allowed_provider" } as never,
    });
    const initech = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Initech" } } });
    const espresso = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "espresso" } } });
    const updated = await mutate(
      { type: "memory.update", entityId: espresso.id, content: "The user works at Hooli." },
      await revisionOf(user.id, "memory", espresso.id)
    );
    assert.equal(updated.status, 200, updated.text);
    const initechAfter = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: initech.id } });
    assert.equal(initechAfter.status, "superseded", "the device's rewrite replaced the old employer");
    assert.equal(initechAfter.supersededById, espresso.id);
    const hooli = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: espresso.id } });
    assert.equal(hooli.content, "The user works at Hooli.");
    assert.equal(hooli.category, "identity", "reclassified like a web rewrite");

    // memory.delete — deleteMemoryEntries: pointer cleared, summary benched.
    await prisma.memorySummary.create({ data: { userId: user.id, content: encryptField("Works at Hooli."), entryCount: 2 } });
    const deleted = await mutate({ type: "memory.delete", entityId: espresso.id }, await revisionOf(user.id, "memory", espresso.id));
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(await prisma.memoryEntry.count({ where: { id: espresso.id } }), 0);
    const initechAfterDelete = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: initech.id } });
    assert.equal(initechAfterDelete.supersededById, null, "no pointer at the deleted fact");
    assert.equal(initechAfterDelete.reason, "Replaced by a memory you have since deleted.");
    assert.equal(initechAfterDelete.status, "superseded", "deleting is not a claim the older fact is true again");
    assert.equal(await prisma.memorySummary.count({ where: { userId: user.id } }), 0, "the summary that said it is benched");

    // conversation.delete — invalidateSummariesForDeletedConversations.
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Trip" } });
    await prisma.conversationMemory.create({
      data: { userId: user.id, conversationId: chat.id, processedAt: new Date(), digest: "Planned a trip to Kyoto" },
    });
    await prisma.memorySummary.create({ data: { userId: user.id, content: encryptField("Planning Kyoto."), entryCount: 3 } });
    const chatGone = await mutate({ type: "conversation.delete", entityId: chat.id }, await revisionOf(user.id, "conversation", chat.id));
    assert.equal(chatGone.status, 200, chatGone.text);
    assert.equal(await prisma.conversation.count({ where: { id: chat.id } }), 0);
    assert.equal(await prisma.memorySummary.count({ where: { userId: user.id } }), 0, "the summary its digest fed is benched");
    afterQueue.length = 0;
  });

  test("Undo puts a retired fact back as it was; topics added on the page or twice by an edit say so and stay one row", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const applyRoute = await import("@/app/api/memory/edit/apply/route");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const topicsRoute = await import("@/app/api/memory/topics/route");
    const user = await newUser("undo");
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    // An inferred fact from a chat, said months ago.
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Career chat" } });
    const saidAt = new Date(Date.now() - 120 * DAY);
    await memory.saveCandidates(user.id, ["The user works at Initech."], chat.id, {
      observedAt: saidAt,
      policy: { mode: "any_allowed_provider" } as never,
    });
    const initech = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, content: { contains: "Initech" } } });
    assert.equal(initech.source, "AUTO");

    const applied = await applyRoute.POST(new Request("http://x", json({ operations: [{ op: "add", content: "The user works at Hooli." }] })));
    assert.equal(applied.status, 200, await applied.clone().text());
    const { inverse } = (await applied.json()) as { inverse: { op: string; restoreId?: string }[] };
    assert.ok(inverse.some((op) => op.op === "add" && op.restoreId === initech.id), "the inverse names the row to put back");
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: initech.id } })).status, "superseded");

    const undone = await applyRoute.POST(new Request("http://x", json({ operations: inverse })));
    assert.equal(undone.status, 200, await undone.clone().text());
    const back = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: initech.id } });
    assert.equal(back.status, "active", "believed again");
    assert.equal(back.source, "AUTO", "still something Juno inferred, not something typed today");
    assert.equal(back.observedAt?.toISOString(), saidAt.toISOString(), "still said when it was said");
    assert.equal(back.sourceRef, chat.id, "still from the chat it came from");
    assert.equal(back.confidence, initech.confidence);
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, content: { contains: "Hooli" } } }), 0, "the edit's fact is gone");
    const detail = (await (await itemRoute.GET(new Request("http://x"), ctx(initech.id))).json()) as {
      provenance: { why: string; when: { saidAt: string } };
    };
    assert.equal(detail.provenance.when.saidAt, saidAt.toISOString());
    assert.match(detail.provenance.why, /in “Career chat”/);
    assert.doesNotMatch(detail.provenance.why, /confirmed it yourself/);

    // A topic added on the memory page: the retired facts say where it was asked.
    await memory.saveCandidates(user.id, ["The user is going through a divorce."], undefined, {
      policy: { mode: "any_allowed_provider" } as never,
    });
    const added = await topicsRoute.POST(new Request("http://x", json({ topic: "my divorce" })));
    assert.equal(added.status, 201);
    const retired = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, kind: "FACT", content: { contains: "divorce" } } });
    assert.equal(retired.status, "suppressed");
    assert.match(retired.reason ?? "", /not to remember anything about “my divorce”, on the memory page\./);
    assert.doesNotMatch(retired.reason ?? "", /conversation/);
    const row = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: user.id, kind: "SUPPRESSION" } });
    assert.equal(row.sourceRef, "manual", "added on the page, not in a chat");

    // The same topic again through an applied edit, phrased another way: still one row.
    const again = await applyRoute.POST(
      new Request("http://x", json({ operations: [{ op: "add", suppress: true, content: "Never remember anything about my divorce" }] }))
    );
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, kind: "SUPPRESSION" } }), 1);
    const againBody = (await again.json()) as { inverse: unknown[] };
    assert.deepEqual(againBody.inverse, [], "nothing of its own for an Undo to remove");
    afterQueue.length = 0;
  });

  test("an export imported into another account names the chats its facts came from", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const exportRoute = await import("@/app/api/account/export/route");
    const importRoute = await import("@/app/api/import/route");
    const listRoute = await import("@/app/api/memory/route");
    const exporter = await newUser("exporter");
    const accounts = [exporter.id];
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: accounts } } });
    });
    const chat = await prisma.conversation.create({ data: { userId: exporter.id, title: "Moving to Porto" } });
    await prisma.message.create({ data: { conversationId: chat.id, role: "USER", content: "I live in Porto now." } });
    await memory.saveCandidates(exporter.id, ["The user lives in Porto."], chat.id, { policy: { mode: "any_allowed_provider" } as never });
    const payload = await (await exportRoute.GET(new Request("http://x/api/account/export"))).json();

    const importer = await newUser("importer");
    accounts.push(importer.id);
    const form = new FormData();
    form.set("file", new File([JSON.stringify(payload)], "export.json", { type: "application/json" }));
    const imported = await importRoute.POST(new Request("http://x/api/import", { method: "POST", body: form }));
    assert.equal(imported.status, 200, await imported.clone().text());
    const copy = await prisma.conversation.findFirstOrThrow({ where: { userId: importer.id } });
    const fact = await prisma.memoryEntry.findFirstOrThrow({ where: { userId: importer.id, content: { contains: "Porto" } } });
    assert.equal(fact.sourceRef, copy.id, "the ref names the restored chat, not the exporting account's");
    const listed = (await (await listRoute.GET(new Request("http://x/api/memory"))).json()) as {
      memories: { content: string; provenance: { source: { label: string; href: string | null; conversationUnavailable: boolean } } }[];
    };
    const porto = listed.memories.find((m) => m.content.includes("Porto"))!;
    assert.equal(porto.provenance.source.conversationUnavailable, false);
    assert.equal(porto.provenance.source.label, "From “Moving to Porto”");
    assert.ok(porto.provenance.source.href?.startsWith(`/chat/${copy.id}`));
    afterQueue.length = 0;
  });
}
