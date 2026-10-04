/**
 * Session recall against real Postgres, on a large synthetic account.
 *
 *   RECALL_BENCH_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_memory_test \
 *   npx tsx scripts/recall-bench.ts [--messages 100000] [--json]
 *
 * Creates one throwaway account (deleted at the end), writes the synthetic
 * corpus from src/lib/memory-eval.ts with real AES-GCM bodies, indexes it in
 * batches (throughput), then asks the planted questions through:
 *   - the index (searchRecall): latency split, found-or-not, rank;
 *   - the unified search exactly as it ran before (bounded 50-chat scan):
 *     latency and found-or-not.
 * Refuses any non-loopback database. Never touches an existing account.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const DB = process.env.RECALL_BENCH_DATABASE_URL;
if (!DB || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(DB).hostname)) {
  console.error("Set RECALL_BENCH_DATABASE_URL to a disposable loopback database.");
  process.exit(2);
}
process.env.DATABASE_URL = DB;
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.DATA_ENCRYPTION_KEYRING;
process.env.AUTH_SECRET ??= "recall-bench";

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
};

async function main() {
  const messages = Number(arg("--messages") ?? 100_000);
  const json = args.includes("--json");
  const { encryptMessageText, decryptMessageTextSafe } = await import("../src/lib/message-crypto");
  const { recallActiveKeyId, recallHasher } = await import("../src/lib/recall/keys");
  const { indexPendingMessages, searchRecall } = await import("../src/lib/recall/service");
  const { runUnifiedSearch } = await import("../src/lib/search/engine");
  const { syntheticRecallCorpus } = await import("../src/lib/memory-eval");
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  const deps = {
    run: <T,>(statement: Prisma.Sql) => prisma.$queryRaw(statement) as Promise<T[]>,
    decrypt: decryptMessageTextSafe,
    hasher: recallHasher,
    activeKeyId: recallActiveKeyId,
    unreadable: "[message could not be decrypted]",
  };

  const now = new Date();
  const { corpus, probes, conversations } = syntheticRecallCorpus(messages, now);
  const user = await prisma.user.create({ data: { email: `recall-bench-${Date.now()}@example.invalid` } });
  try {
    const projectIds = new Map<string, string>();
    for (const name of ["p-biz", "p-brand"]) {
      const project = await prisma.project.create({ data: { userId: user.id, name } });
      projectIds.set(name, project.id);
    }
    // Conversations, then messages, in bulk.
    const byConversation = new Map<string, typeof corpus>();
    for (const m of corpus) (byConversation.get(m.conversationId) ?? byConversation.set(m.conversationId, []).get(m.conversationId)!).push(m);
    const convRows = [...byConversation].map(([id, ms]) => ({
      id: `${user.id}-${id}`,
      userId: user.id,
      title: id.startsWith("planted") ? `Decision ${id}` : `Chat ${id}`,
      projectId: ms[0].projectId ? projectIds.get(ms[0].projectId)! : null,
      createdAt: ms[0].createdAt,
      lastMessageAt: ms[ms.length - 1].createdAt,
    }));
    const tWrite = performance.now();
    for (let i = 0; i < convRows.length; i += 1000) await prisma.conversation.createMany({ data: convRows.slice(i, i + 1000) });
    const msgRows = corpus.map((m, i) => ({
      id: `${user.id}-${m.id}`,
      conversationId: `${user.id}-${m.conversationId}`,
      role: i % 2 === 0 ? ("USER" as const) : ("ASSISTANT" as const),
      content: encryptMessageText(m.text),
      createdAt: m.createdAt,
    }));
    for (let i = 0; i < msgRows.length; i += 2000) await prisma.message.createMany({ data: msgRows.slice(i, i + 2000) });
    const writeMs = performance.now() - tWrite;

    const tIndex = performance.now();
    let indexed = 0;
    for (;;) {
      const { indexed: n } = await indexPendingMessages(deps, user.id, { limit: 2000 });
      if (n === 0) break;
      indexed += n;
    }
    const indexMs = performance.now() - tIndex;
    // What autovacuum does in production after a bulk load: fresh statistics.
    await prisma.$executeRawUnsafe(`VACUUM ANALYZE "MessageRecallIndex"`);
    await prisma.$executeRawUnsafe(`ANALYZE "Message"`);
    await prisma.$executeRawUnsafe(`ANALYZE "Conversation"`);
    const [{ bytes }] = await prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_total_relation_size('"MessageRecallIndex"') AS bytes`;

    if (args.includes("--explain")) {
      const { recallCandidatesSql } = await import("../src/lib/search/sql");
      const { parseRecallQuery } = await import("../src/lib/recall/index-core");
      const hash = recallHasher(user.id, recallActiveKeyId())!;
      const q = parseRecallQuery(probes[0].query, now);
      const tokens = [...q.words.map((w) => hash(`w:${w}`)), ...q.entities.map((e) => hash(`e:${e}`))];
      const statement = recallCandidatesSql({ userId: user.id, tokens, projectId: null, since: null, limit: 400 });
      const plan = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`EXPLAIN ANALYZE ${statement}`);
      console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
    }
    const recallTimes: number[] = [];
    const split = { candidatesMs: [] as number[], rankMs: [] as number[], verifyMs: [] as number[], overheadMs: [] as number[] };
    const legacyTimes: number[] = [];
    const rows: { query: string; recallRank: number | null; legacyFound: boolean; recallMs: number; legacyMs: number }[] = [];
    for (let round = 0; round < 5; round++) {
      for (const probe of probes) {
        const projectId = probe.projectId ? projectIds.get(probe.projectId)! : null;
        const t0 = performance.now();
        const found = await searchRecall(deps, { userId: user.id, query: probe.query, projectId: null, since: null, limit: 8 });
        const recallMs = performance.now() - t0;
        split.candidatesMs.push(found.timings.candidatesMs);
        split.rankMs.push(found.timings.rankMs);
        split.verifyMs.push(found.timings.verifyMs);
        split.overheadMs.push(recallMs - found.timings.candidatesMs - found.timings.rankMs - found.timings.verifyMs);
        const t1 = performance.now();
        const legacy = await runUnifiedSearch(
          { userId: user.id, query: probe.query, types: ["message"], projectId: null },
          { executor: { run: (s) => prisma.$queryRaw(s) as Promise<never[]> }, decryptMessage: decryptMessageTextSafe }
        );
        const legacyMs = performance.now() - t1;
        recallTimes.push(recallMs);
        legacyTimes.push(legacyMs);
        if (round === 0) {
          const chats = [...new Set(found.hits.map((h) => h.conversationId))];
          const rank = chats.indexOf(`${user.id}-${probe.conversationId}`);
          rows.push({
            query: probe.query,
            recallRank: rank === -1 ? null : rank + 1,
            legacyFound: legacy.groups.flatMap((g) => g.hits).some((h) => h.href.includes(`${user.id}-${probe.conversationId}`)),
            recallMs: Math.round(recallMs),
            legacyMs: Math.round(legacyMs),
          });
          void projectId;
        }
      }
    }
    const result = {
      messages: corpus.length,
      conversations,
      writeMs: Math.round(writeMs),
      indexed,
      indexMs: Math.round(indexMs),
      indexMessagesPerSecond: Math.round(indexed / (indexMs / 1000)),
      indexBytes: Number(bytes),
      recallP50Ms: Math.round(quantile(recallTimes, 0.5)),
      recallP95Ms: Math.round(quantile(recallTimes, 0.95)),
      legacyScanP50Ms: Math.round(quantile(legacyTimes, 0.5)),
      legacyScanP95Ms: Math.round(quantile(legacyTimes, 0.95)),
      recallSplitP50Ms: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, Math.round(quantile(v, 0.5) * 10) / 10])),
      foundFirst: rows.filter((r) => r.recallRank === 1).length,
      foundTop5: rows.filter((r) => r.recallRank !== null && r.recallRank <= 5).length,
      legacyFound: rows.filter((r) => r.legacyFound).length,
      questions: rows.length,
      rows,
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Session recall on Postgres — ${result.messages} messages / ${result.conversations} chats`);
      console.log(`write ${result.writeMs} ms · index ${result.indexMs} ms (${result.indexMessagesPerSecond} msg/s) · index size ${(result.indexBytes / 1e6).toFixed(1)} MB`);
      console.log(`index search p50 ${result.recallP50Ms} ms · p95 ${result.recallP95Ms} ms   |   old bounded scan p50 ${result.legacyScanP50Ms} ms · p95 ${result.legacyScanP95Ms} ms`);
      console.log(`index search split p50: ${JSON.stringify(result.recallSplitP50Ms)} (overhead = stats + pending count)`);
      console.log(`right chat first ${result.foundFirst}/${result.questions} · top 5 ${result.foundTop5}/${result.questions} · old scan found ${result.legacyFound}/${result.questions}`);
      for (const r of rows) console.log(`  ${r.recallRank ?? "—"}  ${r.legacyFound ? "old:found " : "old:miss  "} ${r.query}`);
    }
  } finally {
    if (args.includes("--keep")) console.log(`kept account ${user.id}`);
    else await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
