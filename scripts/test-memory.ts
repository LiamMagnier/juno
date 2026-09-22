/**
 * Memory-pipeline integration tests — run with `npm run test:memory`.
 *
 * Runs against the real dev database with a throwaway user and DETERMINISTIC
 * fake models (the `UtilityLlm` / embedder injection points), so they prove
 * the pipeline mechanics rather than any provider's mood:
 *
 *   1. old chats are included in memory (resumable backfill)
 *   2. new messages update memory incrementally (high-water mark)
 *   3. suppressed memories never come back — not on re-extraction of the old
 *      chat that contained them, and not in the rebuilt summary
 *   4. conversations far beyond 250 messages are fully covered (chunked)
 *   5. semantic retrieval: facts embed at write time, a paraphrased query
 *      finds them, and an embedding failure degrades to lexical — never dies
 *   6. capturing a new fact emits the "Memory updated" timeline activity
 *   7. the edit ledger is server rows with an idempotent import
 *   8. forgetting — facts retired, suppression written, and a summary written
 *      before the forget is benched rather than injected
 *   9. the dreamer's account query honours pause, the background-learning
 *      switch and already-distilled history; an active account is skipped
 *  10. Code is shown coding facts only — never identity or a sensitive fact
 *  11. imports are MANUAL; an AUTO sensitive fact is refused until opted in
 *  12. per-project summaries: each project distils its own facts and chats,
 *      a project chat reads that summary and no other memory, the account
 *      summary no longer reads project chats, and nothing survives lost access
 *  13. re-reading history: newest-first reading judged by when things were
 *      said, old processing-order data repaired by the re-judge pass, and a
 *      re-read after a reader upgrade that never re-learns what a reset erased
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script) so
 * the `server-only` guard inside the lib import chain resolves to a no-op.
 */
import { prisma } from "../src/lib/prisma";
import {
  backfillMemories,
  consolidateMemories,
  consolidateProjectMemory,
  extractConversationMemory,
  forgetStatements,
  getCodingMemory,
  getMemoryProfile,
  getProjectMemorySummary,
  pendingBackfill,
  queueRereads,
  reconcileMemoryTimeline,
  saveCandidates,
  type MemoryEmbedder,
  type UtilityLlm,
} from "../src/lib/memory";
import { isEncryptedMessageText } from "../src/lib/message-crypto";
import { dreamForAccount, findAccountsToDream } from "../src/lib/memory-dreamer";
import { encryptField } from "../src/lib/field-crypto";
import type { MemoryUpdateActivity } from "../src/lib/memory-lifecycle";
import type { EmbeddingModelInfo } from "../src/lib/knowledge/embed";

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// Deterministic "extractor": one fact per `token:<id>` found in the chunk
// (capped to 12 by the pipeline's parser, like a real model call would be).
let extractCalls = 0;
const fakeExtractor: UtilityLlm = async ({ userMsg }) => {
  extractCalls++;
  const tokens = [...userMsg.matchAll(/token:([\w-]+)/g)].map((m) => m[1]);
  const facts = tokens.map((t) => `The user mentioned token:${t}.`);
  return JSON.stringify({ facts, digest: `Chat about ${tokens[0] ?? "nothing"}` });
};

// Deterministic "consolidator": echoes the FACTS block it received, so the
// summary content mirrors exactly what the pipeline fed it.
let lastConsolidationPrompt = "";
const fakeConsolidator: UtilityLlm = async ({ userMsg }) => {
  lastConsolidationPrompt = userMsg;
  const factsBlock = userMsg.split("FACTS (oldest to newest):")[1]?.split("\n\n")[0] ?? "";
  return `## Top of mind\n${factsBlock.trim()}`;
};

// Deterministic "embedder": a 3-dimension space where cat-facts and feline
// queries share an axis, coffee-facts and caffeine queries another. Enough to
// prove that a paraphrase with ZERO shared tokens still finds its fact.
const FAKE_EMBED_MODEL: EmbeddingModelInfo = {
  id: "test:fake-embed",
  provider: "openai",
  providerModel: "fake-embed",
  dimensions: 3,
};
const fakeVector = (text: string): number[] => {
  const t = text.toLowerCase();
  if (/cat|feline/.test(t)) return [1, 0, 0];
  if (/coffee|espresso|caffeine/.test(t)) return [0, 1, 0];
  return [0, 0, 1];
};
const fakeEmbedTexts: MemoryEmbedder = async ({ texts }) => ({
  ok: true,
  model: FAKE_EMBED_MODEL,
  vectors: texts.map((text) => fakeVector(text)),
});
const failingEmbedTexts: MemoryEmbedder = async () => ({ ok: false, reason: "provider_failed" });
const fakeEmbedQuery = async ({ text }: { text: string }) => ({
  ok: true as const,
  model: FAKE_EMBED_MODEL,
  vector: fakeVector(text),
});
const failingEmbedQuery = async () => ({ ok: false as const, reason: "provider_failed" as const });

async function seedConversation(userId: string, title: string, tokenPrefix: string, count: number, startAt: Date) {
  const convo = await prisma.conversation.create({
    data: { userId, title, lastMessageAt: new Date(startAt.getTime() + count * 1000) },
  });
  await prisma.message.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      conversationId: convo.id,
      role: "USER" as const,
      content: `Some filler context number ${i + 1} mentioning token:${tokenPrefix}${i + 1} in passing.`,
      createdAt: new Date(startAt.getTime() + (i + 1) * 1000),
    })),
  });
  return convo;
}

async function factExists(userId: string, needle: string): Promise<boolean> {
  const row = await prisma.memoryEntry.findFirst({
    where: { userId, kind: "FACT", content: { contains: needle } },
    select: { id: true },
  });
  return !!row;
}

/** Throwaway accounts for sections 8+, deleted with the main one. */
const extraUsers: string[] = [];
async function extraUser(
  tag: string,
  settings: { memoryEnabled?: boolean; memoryBackgroundLearning?: boolean } = {}
): Promise<string> {
  const created = await prisma.user.create({
    data: { email: `memory-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`, name: tag },
  });
  extraUsers.push(created.id);
  await prisma.settings.create({ data: { userId: created.id, ...settings } });
  return created.id;
}

/** A stored fact, written directly — these sections test what READS memory. */
async function rawFact(userId: string, content: string, extra: { category?: string } = {}) {
  await prisma.memoryEntry.create({
    data: { userId, content, kind: "FACT", source: "AUTO", status: "active", category: extra.category ?? "preferences" },
  });
}

async function main() {
  const user = await prisma.user.create({
    data: { email: `test-memory-${Date.now()}@example.com`, name: "Memory Test" },
  });
  console.log(`Seeded throwaway user ${user.id}`);

  try {
    // Three chats: one OLD and huge (>250 msgs), one mid, one recent.
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    const oldChat = await seedConversation(user.id, "Old huge chat", "OLD", 300, monthAgo);
    const midChat = await seedConversation(user.id, "Mid chat", "MID", 5, weekAgo);
    const newChat = await seedConversation(user.id, "Recent chat", "NEW", 3, hourAgo);

    // ------------------------------------------------------------------
    console.log("\n1+4. Backfill covers every chat, including 300 messages in one");
    // ------------------------------------------------------------------
    let remaining = (await pendingBackfill(user.id)).length;
    check("all three chats start pending", remaining === 3, `remaining=${remaining}`);

    for (let i = 0; i < 50 && remaining > 0; i++) {
      const res = await backfillMemories({ userId: user.id, llm: fakeExtractor });
      remaining = res.remaining;
    }
    check("backfill drains to zero pending", remaining === 0, `remaining=${remaining}`);

    const oldState = await prisma.conversationMemory.findFirst({ where: { conversationId: oldChat.id, userId: user.id } });
    const lastOldMsg = await prisma.message.findFirst({
      where: { conversationId: oldChat.id },
      orderBy: { createdAt: "desc" },
    });
    check(
      "old chat's high-water mark covers all 300 messages",
      !!oldState && !!lastOldMsg && oldState.processedAt >= lastOldMsg.createdAt
    );
    check("300 messages were processed in chunks (8 × 40)", extractCalls >= 8, `extractCalls=${extractCalls}`);
    check("facts from the old chat's FIRST message exist", await factExists(user.id, "token:OLD1."));
    for (const [label, convo] of [["old", oldChat], ["mid", midChat], ["new", newChat]] as const) {
      const n = await prisma.memoryEntry.count({ where: { userId: user.id, sourceRef: convo.id } });
      check(`${label} chat contributed facts (sourceRef set)`, n > 0, `count=${n}`);
    }

    // ------------------------------------------------------------------
    console.log("\n2. New messages update memory incrementally");
    // ------------------------------------------------------------------
    const callsBefore = extractCalls;
    await prisma.message.create({
      data: { conversationId: oldChat.id, role: "USER", content: "By the way, token:INCREMENT matters to me." },
    });
    await prisma.conversation.update({ where: { id: oldChat.id, userId: user.id }, data: { lastMessageAt: new Date() } });

    const inc = await extractConversationMemory({ userId: user.id, conversationId: oldChat.id, llm: fakeExtractor });
    check("exactly one extraction call for one new message", extractCalls - callsBefore === 1);
    check("incremental run reports done", inc.done && inc.chunksProcessed === 1);
    check("the new fact landed", await factExists(user.id, "token:INCREMENT"));
    const incState = await prisma.conversationMemory.findFirst({ where: { conversationId: oldChat.id, userId: user.id } });
    check("high-water mark advanced", !!incState && !!oldState && incState.processedAt > oldState.processedAt);

    // ------------------------------------------------------------------
    console.log("\n3. Suppressed memories never come back");
    // ------------------------------------------------------------------
    // "Forget token:OLD1" — same operations the apply route runs.
    const target = await prisma.memoryEntry.findFirst({
      where: { userId: user.id, kind: "FACT", content: { contains: "token:OLD1." } },
    });
    check("target fact exists before forgetting", !!target);
    if (target) {
      await prisma.$transaction([
        prisma.memoryEntry.delete({ where: { id: target.id, userId: user.id } }),
        prisma.memoryEntry.create({
          data: { userId: user.id, content: target.content, source: "MANUAL", kind: "SUPPRESSION", sourceRef: "edit" },
        }),
      ]);
    }
    check("fact is gone after forget", !(await factExists(user.id, "token:OLD1.")));

    // Force a full re-extraction of the old chat that contained it.
    await prisma.conversationMemory.delete({ where: { conversationId: oldChat.id, userId: user.id } });
    let rem = (await pendingBackfill(user.id)).length;
    for (let i = 0; i < 50 && rem > 0; i++) {
      rem = (await backfillMemories({ userId: user.id, llm: fakeExtractor })).remaining;
    }
    check("re-backfill completes", rem === 0);
    check(
      "suppressed fact was NOT re-created by re-extraction",
      !(await factExists(user.id, "token:OLD1."))
    );
    check("other old facts survived the round trip", await factExists(user.id, "token:OLD2."));

    // Rebuild the summary and prove the suppression layer reaches it.
    const consolidation = await consolidateMemories({ userId: user.id, llm: fakeConsolidator });
    // consolidateMemories now reports WHY it produced nothing (empty / denied by
    // the background-provider policy / provider failure) instead of a bare null.
    const summary = consolidation.status === "updated" ? consolidation.content : null;
    check("summary rebuilt", !!summary);
    check(
      "consolidator was told about the suppression",
      lastConsolidationPrompt.includes("SUPPRESSED") && lastConsolidationPrompt.includes("token:OLD1.")
    );
    const factsBlock = lastConsolidationPrompt.split("FACTS (oldest to newest):")[1] ?? "";
    check("suppressed content is absent from the consolidator's FACTS", !factsBlock.includes("token:OLD1."));
    check("visible summary does not contain the suppressed content", !!summary && !summary.includes("token:OLD1."));
    check("visible summary still contains other memories", !!summary && summary.includes("token:OLD2."));

    // The suppression is global: mentioning the forgotten thing in a DIFFERENT
    // chat must not bring it back either.
    await prisma.message.create({
      data: { conversationId: midChat.id, role: "USER", content: "Anyway, about token:OLD1 again — still relevant?" },
    });
    await prisma.conversation.update({ where: { id: midChat.id, userId: user.id }, data: { lastMessageAt: new Date() } });
    await extractConversationMemory({ userId: user.id, conversationId: midChat.id, llm: fakeExtractor });
    check(
      "suppression blocks the same content coming from a different chat",
      !(await factExists(user.id, "token:OLD1."))
    );

    // ------------------------------------------------------------------
    console.log("\n5. Semantic retrieval: write-time embedding, hybrid ranking, honest fallback");
    // ------------------------------------------------------------------
    await saveCandidates(
      user.id,
      ["The user has a cat called Miso.", "The user drinks espresso every morning."],
      undefined,
      { embed: fakeEmbedTexts }
    );
    const embeddedRows = await prisma.memoryEntry.findMany({
      where: { userId: user.id, embeddingModel: FAKE_EMBED_MODEL.id },
      select: { content: true, embedding: true },
    });
    check(
      "facts are embedded at write time (vector + model stored)",
      embeddedRows.length === 2 && embeddedRows.every((row) => row.embedding.length === 3),
      `rows=${embeddedRows.length}`
    );

    await saveCandidates(user.id, ["The user plays badminton on Sundays."], undefined, {
      embed: failingEmbedTexts,
    });
    const badminton = await prisma.memoryEntry.findFirst({
      where: { userId: user.id, content: { contains: "badminton" } },
      select: { embeddingModel: true },
    });
    check(
      "a failed embed still stores the fact, lexical-only",
      !!badminton && badminton.embeddingModel === null
    );

    // "caffeine" shares no token with "drinks espresso every morning" — only
    // the vectors connect them. The tight budget forces a single pick, so the
    // assertion is about RANKING, not about everything fitting anyway.
    const hybrid = await getMemoryProfile(user.id, {
      query: "Anything about my caffeine ritual?",
      budgetTokens: 14,
      embed: fakeEmbedQuery,
    });
    check(
      "a paraphrased query selects the semantically-matching fact",
      hybrid.used.length === 1 && hybrid.used[0].content.includes("espresso"),
      hybrid.used.map((m) => m.content).join(" | ")
    );

    const fallback = await getMemoryProfile(user.id, {
      query: "Anything about my caffeine ritual?",
      budgetTokens: 14,
      embed: failingEmbedQuery,
    });
    check("an embedding failure still returns a selection (no throw)", fallback.used.length === 1);
    // Without vectors the paraphrase link is genuinely gone: "caffeine" cannot
    // reach the espresso fact, so recency/category rank instead. What exactly
    // wins is the lexical tie-break's business — what must not win is the
    // semantic match the failed provider never got to make.
    check(
      "the fallback ranking carries no semantic evidence",
      !(fallback.used[0]?.content.includes("espresso") ?? false),
      fallback.used.map((m) => m.content).join(" | ")
    );

    // ------------------------------------------------------------------
    console.log("\n6. Capturing a new fact emits the 'Memory updated' activity");
    // ------------------------------------------------------------------
    // A ref object rather than a let: the closure assignment is invisible to
    // control-flow narrowing, which would otherwise type these reads `never`.
    const captured: { current: MemoryUpdateActivity | null } = { current: null };
    await saveCandidates(user.id, ["The user is training for a marathon."], undefined, {
      embed: failingEmbedTexts,
      onActivity: (event) => {
        captured.current = event;
      },
    });
    check("a new fact emits a 'Memory updated' activity", captured.current?.title === "Memory updated");
    check("the activity deep-links to /memory", captured.current?.url === "/memory");
    check("the activity names the fact rather than counting it", !!captured.current?.detail?.includes("marathon"));

    captured.current = null;
    await saveCandidates(user.id, ["The user is training for a marathon."], undefined, {
      embed: failingEmbedTexts,
      onActivity: (event) => {
        captured.current = event;
      },
    });
    check("a restated (deduplicated) fact emits nothing", captured.current === null);

    // ------------------------------------------------------------------
    console.log("\n7. Edit ledger: server rows with an idempotent import");
    // ------------------------------------------------------------------
    const ledgerRow = {
      userId: user.id,
      clientId: "test-edit-1",
      instruction: "Remember that I like tea.",
      status: "applied",
      operations: [{ op: "add", content: "The user likes tea." }],
      inverse: [{ op: "remove", id: "fact-1", before: "The user likes tea." }],
    };
    await prisma.memoryEdit.createMany({ data: [ledgerRow], skipDuplicates: true });
    // The localStorage import path retries after failures — the (userId,
    // clientId) constraint is what keeps the retry from duplicating history.
    await prisma.memoryEdit.createMany({ data: [ledgerRow], skipDuplicates: true });
    const ledgerCount = await prisma.memoryEdit.count({ where: { userId: user.id } });
    check("a retried import cannot duplicate a ledger record", ledgerCount === 1, `count=${ledgerCount}`);

    // ------------------------------------------------------------------
    console.log("\n8. Forgetting reaches the next chat — the stale summary is benched");
    // ------------------------------------------------------------------
    const fu = await extraUser("forget");
    await rawFact(fu, "The user works at Acme.", { category: "identity" });
    await rawFact(fu, "The user works at Acme as a staff designer.", { category: "identity" });
    await rawFact(fu, "The user prefers metric units.");
    // Written BEFORE the forget, and quoting the forgotten fact in prose.
    await prisma.memorySummary.create({
      data: { userId: fu, content: encryptField("## Work context\nThe user works at Acme."), entryCount: 3 },
    });
    const beforeForget = await getMemoryProfile(fu, { query: "where do I work" });
    check("before the forget, the summary is injected", !!beforeForget.summary?.includes("Acme"));
    await new Promise((r) => setTimeout(r, 20));
    const forgot = await forgetStatements(fu, ["The user works at Acme."]);
    check("every covering fact is retired", forgot.retired === 2, `retired=${forgot.retired}`);
    const fuRows = await prisma.memoryEntry.findMany({ where: { userId: fu } });
    check("retired, not deleted", fuRows.filter((r) => r.kind === "FACT" && r.status === "suppressed").length === 2);
    check("one suppression written", fuRows.filter((r) => r.kind === "SUPPRESSION").length === 1);
    const afterForget = await getMemoryProfile(fu, { query: "where do I work" });
    check("the summary written before the forget is benched", afterForget.summary === null);
    check("nothing retired reaches context", !afterForget.recent.some((f) => f.includes("Acme")));
    check("active facts still do", afterForget.recent.includes("The user prefers metric units."));
    const twice = await forgetStatements(fu, ["The user works at Acme."]);
    check("forgetting the same thing twice writes nothing", twice.statements.length === 0 && twice.retired === 0);

    // ------------------------------------------------------------------
    console.log("\n9. The dreamer draws only idle, consenting accounts with unread history");
    // ------------------------------------------------------------------
    const idle = await extraUser("dream-idle");
    const pausedU = await extraUser("dream-paused", { memoryEnabled: false });
    const optedOut = await extraUser("dream-optout", { memoryBackgroundLearning: false });
    const distilled = await extraUser("dream-done");
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    for (const id of [idle, pausedU, optedOut, distilled]) {
      const convo = await prisma.conversation.create({ data: { userId: id, title: "t", lastMessageAt: longAgo } });
      if (id === distilled) {
        await prisma.conversationMemory.create({ data: { userId: id, conversationId: convo.id, processedAt: longAgo } });
      }
    }
    const drawn = await findAccountsToDream(10_000);
    check("an idle account with an unread chat is drawn", drawn.includes(idle));
    check("a paused account is never drawn", !drawn.includes(pausedU));
    check("an account that switched background learning off is never drawn", !drawn.includes(optedOut));
    check("an account with nothing unread is not drawn", !drawn.includes(distilled));
    const busy = await extraUser("dream-active");
    await prisma.conversation.create({ data: { userId: busy, title: "now", lastMessageAt: new Date() } });
    check("an account mid-session is skipped", (await dreamForAccount(busy)).skipped === "active");
    check("an idle account is visited", (await dreamForAccount(idle)).skipped === null);

    // ------------------------------------------------------------------
    console.log("\n10. Code is shown how the user works — nothing about who they are");
    // ------------------------------------------------------------------
    const cu = await extraUser("code");
    await rawFact(cu, "The user uses pnpm and Vitest.", { category: "workflows" });
    await rawFact(cu, "The user lives in Lisbon.", { category: "identity" });
    await rawFact(cu, "The user prefers dark mode because of migraines.");
    const coding = await getCodingMemory(cu, "add a pnpm test script");
    check("coding facts reach Code", coding.includes("The user uses pnpm and Vitest."));
    check("identity never reaches Code", !coding.some((f) => f.includes("Lisbon")));
    check("a sensitive preference never reaches Code", !coding.some((f) => /migraine/i.test(f)));
    const cuPaused = await extraUser("code-paused", { memoryEnabled: false });
    await rawFact(cuPaused, "The user uses pnpm.", { category: "workflows" });
    check("a paused account gives Code nothing", (await getCodingMemory(cuPaused, "pnpm")).length === 0);

    // ------------------------------------------------------------------
    console.log("\n11. Imports are the user's choice; AUTO sensitive facts wait for consent");
    // ------------------------------------------------------------------
    const iu = await extraUser("import");
    const imported = await saveCandidates(iu, ["The user speaks Portuguese.", "The user has ADHD."], "import", {
      source: "MANUAL",
    });
    check("a MANUAL import stores what was ticked, sensitive included", imported.created === 2);
    check(
      "imported rows say where they came from",
      (await prisma.memoryEntry.findMany({ where: { userId: iu } })).every((r) => r.sourceRef === "import")
    );
    const refused = await saveCandidates(iu, ["The user was diagnosed with diabetes."], "chat-a", { source: "AUTO" });
    check("an AUTO sensitive fact is refused, naming its topic", refused.sensitiveSkipped === 1 && refused.sensitiveTopics[0] === "health");
    await prisma.settings.update({ where: { userId: iu }, data: { memorySensitiveTopics: ["health"] } });
    const admitted = await saveCandidates(iu, ["The user was diagnosed with diabetes."], "chat-b", { source: "AUTO" });
    check("…and admitted once the topic is opted in", admitted.created === 1);

    // ------------------------------------------------------------------
    // 12. Per-project summaries stay inside their project
    // ------------------------------------------------------------------
    console.log("\n12. Per-project summaries stay inside their project");
    const pu = await extraUser("project");
    const thesis = await prisma.project.create({
      data: { userId: pu, name: "Thesis", instructions: "Help me write my thesis on urban heat islands." },
    });
    const pantry = await prisma.project.create({ data: { userId: pu, name: "Pantry" } });
    const projectFact = (projectId: string, content: string) =>
      prisma.memoryEntry.create({
        data: { userId: pu, content, kind: "FACT", source: "AUTO", status: "active", category: "projects", projectId },
      });
    await rawFact(pu, "The user prefers short answers.");
    await projectFact(thesis.id, "The thesis uses APA citations.");
    await projectFact(thesis.id, "The thesis defense is in December.");
    await projectFact(pantry.id, "Pantry stores its data in Postgres.");
    const thesisChat = await prisma.conversation.create({ data: { userId: pu, title: "Methods", projectId: thesis.id } });
    const plainChat = await prisma.conversation.create({ data: { userId: pu, title: "Groceries" } });
    await prisma.conversationMemory.createMany({
      data: [
        { userId: pu, conversationId: thesisChat.id, processedAt: new Date(), digest: "Restructuring the methodology chapter" },
        { userId: pu, conversationId: plainChat.id, processedAt: new Date(), digest: "Planning the weekly shop" },
      ],
    });

    let projectPrompt = "";
    const projectConsolidator: UtilityLlm = async ({ userMsg }) => {
      projectPrompt = userMsg;
      return "## Purpose & context\nA thesis on urban heat islands, cited in APA.";
    };
    const built = await consolidateProjectMemory({ userId: pu, projectId: thesis.id, llm: projectConsolidator });
    check("a project summary is built", built.status === "updated", built.status);
    check(
      "…from the project's own facts and chats",
      projectPrompt.includes("The thesis uses APA citations.") &&
        projectPrompt.includes("The thesis defense is in December.") &&
        projectPrompt.includes("Restructuring the methodology chapter")
    );
    check(
      "…and nothing from the account, another project or another chat",
      !projectPrompt.includes("short answers") &&
        !projectPrompt.includes("Postgres") &&
        !projectPrompt.includes("weekly shop")
    );
    const sealedRow = await prisma.projectMemorySummary.findUnique({
      where: { userId_projectId: { userId: pu, projectId: thesis.id } },
    });
    check("the summary is sealed at rest", !!sealedRow && isEncryptedMessageText(sealedRow.content), sealedRow?.content.slice(0, 10));
    check(
      "…and reads back in cleartext",
      !!(await getProjectMemorySummary(pu, thesis.id))?.content.includes("urban heat islands")
    );

    let accountPrompt = "";
    await consolidateMemories({
      userId: pu,
      llm: async ({ userMsg }) => {
        accountPrompt = userMsg;
        return "## Preferences\nShort answers.";
      },
    });
    check(
      "the account summary reads ordinary chats but not a project's",
      accountPrompt.includes("Planning the weekly shop") && !accountPrompt.includes("methodology chapter"),
      accountPrompt.slice(0, 300)
    );
    check("…nor a project's facts", !accountPrompt.includes("APA") && !accountPrompt.includes("Postgres"));

    const inThesis = await getMemoryProfile(pu, { projectId: thesis.id, query: "citations" });
    check(
      "a project chat opens with its project's summary",
      inThesis.summaryScope === "project" && !!inThesis.summary?.includes("urban heat islands")
    );
    check(
      "…and none of the account's memory or another project's",
      !(inThesis.summary ?? "").includes("Short answers") &&
        !inThesis.recent.some((fact) => /short answers|Postgres/.test(fact))
    );
    check("facts its summary already says are not repeated as notes", !inThesis.recent.some((fact) => fact.includes("APA")));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await projectFact(thesis.id, "The thesis advisor is Dr. Rahman.");
    const later = await getMemoryProfile(pu, { projectId: thesis.id, query: "advisor" });
    check("a fact newer than the summary rides as a note", later.recent.some((fact) => fact.includes("Dr. Rahman")));
    const outside = await getMemoryProfile(pu, { query: "citations advisor Postgres" });
    check(
      "an ordinary chat reads the account's summary and no project's facts",
      outside.summaryScope === "account" &&
        !!outside.summary?.includes("Short answers") &&
        !outside.recent.some((fact) => /APA|Rahman|Postgres/.test(fact))
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await forgetStatements(pu, ["The thesis uses APA citations."]);
    const projectAfterForget = await getMemoryProfile(pu, { projectId: thesis.id, query: "citations" });
    check("a forget benches the project's summary written before it", projectAfterForget.summary === null);
    const rebuilt = await consolidateProjectMemory({ userId: pu, projectId: thesis.id, llm: projectConsolidator });
    const rebuiltFacts = projectPrompt.split("FACTS (oldest to newest):")[1] ?? "";
    check(
      "…and the rebuild is told to leave the forgotten fact out",
      rebuilt.status === "updated" &&
        projectPrompt.startsWith("SUPPRESSED (never include any of this):\n- The thesis uses APA citations.") &&
        !rebuiltFacts.includes("APA")
    );

    // Someone who lost access to a project keeps their facts from it, but a
    // summary is something a chat reads — so there is nothing to build.
    const former = await extraUser("project-former-member");
    await prisma.memoryEntry.create({
      data: { userId: former, content: "The former member's thesis note.", kind: "FACT", source: "AUTO", status: "active", projectId: thesis.id },
    });
    const denied = await consolidateProjectMemory({ userId: former, projectId: thesis.id, llm: projectConsolidator });
    check(
      "no access to the project, no summary of it",
      denied.status === "empty" &&
        (await prisma.projectMemorySummary.count({ where: { userId: former } })) === 0
    );

    await prisma.project.delete({ where: { id: thesis.id, userId: pu } });
    check(
      "deleting the project deletes its summary",
      (await prisma.projectMemorySummary.count({ where: { userId: pu } })) === 0
    );

    // ------------------------------------------------------------------
    // 13. Re-reading history
    // ------------------------------------------------------------------
    console.log("\n13. Re-reading history, judged by when things were said");
    // An extractor that returns what each message marks as a fact, verbatim.
    const markerExtractor: UtilityLlm = async ({ userMsg }) =>
      JSON.stringify({
        facts: [...userMsg.matchAll(/fact:([^|\n]+)/g)].map((m) => m[1].trim()),
        digest: "A chat",
      });
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    async function chat(userId: string, title: string, at: Date, texts: string[]) {
      const convo = await prisma.conversation.create({
        data: { userId, title, createdAt: at, lastMessageAt: new Date(at.getTime() + texts.length * 60_000) },
      });
      for (const [i, text] of texts.entries()) {
        await prisma.message.create({
          data: { conversationId: convo.id, role: "USER", content: text, createdAt: new Date(at.getTime() + (i + 1) * 60_000) },
        });
      }
      return convo;
    }

    // Newest first, as "Learn from past chats" reads: Porto (said later) is
    // read before Lisbon (said earlier) — and must still be what is believed.
    const hu = await extraUser("history");
    await chat(hu, "Old flat", days(200), ["I live in Lisbon. fact:The user lives in Lisbon."]);
    await chat(hu, "New flat", days(90), ["We moved. fact:The user lives in Porto."]);
    await chat(hu, "Trip", days(60), ["Off to Berlin this week. fact:The user is flying to Berlin this week."]);
    let guard = 0;
    while ((await pendingBackfill(hu)).length > 0 && guard++ < 10) {
      await backfillMemories({ userId: hu, maxConversations: 3, llm: markerExtractor });
    }
    const status = async (userId: string, content: string) =>
      (await prisma.memoryEntry.findFirst({ where: { userId, content }, select: { status: true } }))?.status;
    check("reading newest-first, the city said later is the one believed", (await status(hu, "The user lives in Porto.")) === "active");
    check("…and the one said earlier is history, not a rival", (await status(hu, "The user lives in Lisbon.")) === "superseded");
    check(
      "a trip mentioned two months ago is over when read today",
      (await status(hu, "The user is flying to Berlin this week.")) === "expired"
    );
    const dated = await prisma.memoryEntry.findFirst({
      where: { userId: hu, content: "The user lives in Lisbon." },
      select: { observedAt: true, createdAt: true },
    });
    check(
      "each fact carries when it was said, not when it was read",
      !!dated?.observedAt && dated.createdAt.getTime() - dated.observedAt.getTime() > 150 * 86_400_000
    );

    // Data the old rules wrote — judged in reading order, undated — repaired.
    const ru = await extraUser("repair");
    const madridChat = await chat(ru, "Old", days(300), ["I live in Madrid."]);
    const sevilleChat = await chat(ru, "New", days(30), ["I live in Seville now."]);
    const tripChat = await chat(ru, "Trip", days(70), ["Flying to Rome this week."]);
    const msgOf = async (conversationId: string) =>
      (await prisma.message.findFirst({ where: { conversationId }, select: { id: true } }))!.id;
    const seville = await prisma.memoryEntry.create({
      data: {
        userId: ru, content: "The user lives in Seville.", kind: "FACT", source: "AUTO", status: "superseded",
        category: "identity", confidence: 0.7, sourceRef: sevilleChat.id, sourceMessageId: await msgOf(sevilleChat.id),
      },
    });
    const madrid = await prisma.memoryEntry.create({
      data: {
        userId: ru, content: "The user lives in Madrid.", kind: "FACT", source: "AUTO", status: "active",
        category: "identity", confidence: 0.7, sourceRef: madridChat.id, sourceMessageId: await msgOf(madridChat.id),
      },
    });
    await prisma.memoryEntry.update({ where: { id: seville.id, userId: ru }, data: { supersededById: madrid.id } });
    const rome = await prisma.memoryEntry.create({
      data: {
        userId: ru, content: "The user is flying to Rome this week.", kind: "FACT", source: "AUTO", status: "active",
        category: "temporary", confidence: 0.55, expiresAt: days(-25), sourceRef: tripChat.id,
        sourceMessageId: await msgOf(tripChat.id),
      },
    });
    const typed = await prisma.memoryEntry.create({
      data: { userId: ru, content: "The user's name is Alex.", kind: "FACT", source: "MANUAL", status: "active", category: "identity", confidence: 0.9 },
    });
    const repaired = await reconcileMemoryTimeline(ru);
    check("undated rows are dated from their source messages", repaired.dated === 3, String(repaired.dated));
    check("the city said later is believed again", (await status(ru, "The user lives in Seville.")) === "active");
    const madridNow = await prisma.memoryEntry.findFirst({
      where: { id: madrid.id, userId: ru },
      select: { status: true, supersededById: true, reason: true },
    });
    check(
      "…and the one said earlier is marked replaced by it, with the reason",
      madridNow?.status === "superseded" && madridNow.supersededById === seville.id && /re-read your chats/.test(madridNow.reason ?? "")
    );
    check("a trip dated from when it was mentioned is over", (await status(ru, "The user is flying to Rome this week.")) === "expired");
    check("a fact the user typed is never touched", (await status(ru, "The user's name is Alex.")) === "active");
    const again = await reconcileMemoryTimeline(ru);
    check("a repaired timeline needs no second pass", again.changed === 0 && again.dated === 0, JSON.stringify(again));
    void rome;
    void typed;

    // A reader upgrade re-reads history — but never from before a reset.
    const xu = await extraUser("reread");
    const convo = await chat(xu, "Long chat", days(20), [
      "I work at Initech. fact:The user works at Initech.",
    ]);
    // The user reset memory ten days ago, then kept chatting in the same chat.
    await prisma.message.create({
      data: { conversationId: convo.id, role: "USER", content: "I love jazz. fact:The user likes jazz.", createdAt: days(2) },
    });
    await prisma.conversation.update({ where: { id: convo.id, userId: xu }, data: { lastMessageAt: days(2) } });
    await prisma.memoryEntry.create({
      data: { userId: xu, content: "The user likes jazz.", kind: "FACT", source: "AUTO", status: "active", category: "preferences", createdAt: days(3) },
    });
    // Distilled by the version-1 reader: a digest to show for it, read to the end.
    await prisma.conversationMemory.create({
      data: { userId: xu, conversationId: convo.id, processedAt: days(2), digest: "Jazz", factCount: 1, extractorVersion: 1 },
    });
    // A chat the reset marked read and nothing has distilled since.
    const erased = await chat(xu, "Erased", days(15), ["fact:The user has a secret hobby."]);
    await prisma.conversationMemory.create({
      data: { userId: xu, conversationId: erased.id, processedAt: days(10), extractorVersion: 1 },
    });
    const queued = await queueRereads(xu, 5);
    check("a chat an older reader distilled is queued to be read again", queued === 1, String(queued));
    // `days()` is evaluated again here, a few milliseconds later than when the
    // rows were written — so times are compared to the second.
    const near = (a: Date | undefined, b: Date) => !!a && Math.abs(a.getTime() - b.getTime()) < 5_000;
    const marks = await prisma.conversationMemory.findFirst({ where: { conversationId: convo.id, userId: xu } });
    check(
      "…from the oldest thing still remembered, not from the start",
      near(marks?.processedAt, days(3)) && marks?.extractorVersion === 2
    );
    const erasedMark = await prisma.conversationMemory.findFirst({ where: { conversationId: erased.id, userId: xu } });
    check(
      "a chat the reset marked read is never re-read",
      erasedMark?.extractorVersion === 1 && near(erasedMark.processedAt, days(10))
    );
    guard = 0;
    while ((await pendingBackfill(xu)).includes(convo.id) && guard++ < 5) {
      await extractConversationMemory({ userId: xu, conversationId: convo.id, llm: markerExtractor });
    }
    check("the re-read never re-learns what was said before the reset", !(await factExists(xu, "Initech")));
    check("…and nothing from the erased chat", !(await factExists(xu, "secret hobby")));
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    for (const id of extraUsers) await prisma.user.delete({ where: { id } }).catch(() => {});
    console.log("\nCleaned up throwaway users.");
  }

  if (failures.length) {
    console.error(`\n${failures.length} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll memory-pipeline tests passed.");
  process.exit(0);
}

void main();
