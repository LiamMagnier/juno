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
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script) so
 * the `server-only` guard inside the lib import chain resolves to a no-op.
 */
import { prisma } from "../src/lib/prisma";
import {
  backfillMemories,
  consolidateMemories,
  extractConversationMemory,
  getMemoryProfile,
  pendingBackfill,
  saveCandidates,
  type MemoryEmbedder,
  type UtilityLlm,
} from "../src/lib/memory";
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
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    console.log("\nCleaned up throwaway user.");
  }

  if (failures.length) {
    console.error(`\n${failures.length} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll memory-pipeline tests passed.");
  process.exit(0);
}

void main();
