/*
 * Session recall — the database half: indexing and searching, over injected
 * dependencies (a statement runner, a decrypt, a hasher factory) so the
 * same code runs from the app, the scripts and the tests.
 *
 * Search makes NO model call: tokens are hashed locally, matched in Postgres,
 * ranked in process (index-core.ts), and only the top candidates' bodies are
 * decrypted — to verify the match and to cut the excerpt.
 */

import { Prisma } from "@prisma/client";
import {
  RECALL_INDEX_VERSION,
  blindTokensFor,
  minimumCoverage,
  parseRecallQuery,
  rankRecallCandidates,
  verifyRecallMatch,
  type BlindHasher,
} from "@/lib/recall/index-core";
import {
  recallBodiesSql,
  recallCandidatesSql,
  recallDocumentFrequencySql,
  recallPendingCountSql,
  recallPendingSql,
  recallStatsSql,
  type RecallCandidateRow,
} from "@/lib/search/sql";

export interface RecallDeps {
  run<T>(statement: Prisma.Sql): Promise<T[]>;
  decrypt: (stored: string) => string;
  /** Hasher for (account, message key); null when the key is gone. */
  hasher: (userId: string, keyId: string) => BlindHasher | null;
  activeKeyId: () => string;
  /** What decrypt returns for an unreadable body. */
  unreadable: string;
  now?: () => Date;
}

/** Messages younger than this are left to the live scan: an assistant reply is still being written. */
export const RECALL_SETTLE_MS = 2 * 60_000;
/** Candidates fetched from the index before ranking. */
export const RECALL_CANDIDATES = 400;
/** Candidates decrypted for verification and excerpts. */
export const RECALL_VERIFY = 40;

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface IndexOutcome {
  indexed: number;
  /** Unreadable bodies, indexed as empty so they are not retried forever. */
  unreadable: number;
}

/**
 * Index up to `limit` of the account's pending messages, newest first.
 * Bounded so it can ride along anywhere: after a chat turn, in a search, in
 * the backfill script. Idempotent — an upsert per message.
 */
export async function indexPendingMessages(
  deps: RecallDeps,
  userId: string,
  opts: { limit: number }
): Promise<IndexOutcome> {
  const keyId = deps.activeKeyId();
  const hash = deps.hasher(userId, keyId);
  if (!hash) return { indexed: 0, unreadable: 0 };
  const now = deps.now?.() ?? new Date();
  const rows = await deps.run<{ id: string; conversationId: string; role: string; content: string; createdAt: Date }>(
    recallPendingSql({
      userId,
      version: RECALL_INDEX_VERSION,
      keyId,
      before: new Date(now.getTime() - RECALL_SETTLE_MS),
      limit: opts.limit,
    })
  );
  let unreadable = 0;
  const values: Prisma.Sql[] = [];
  for (const row of rows) {
    const body = deps.decrypt(row.content);
    const readable = body !== deps.unreadable;
    if (!readable) unreadable++;
    const tokens = readable ? blindTokensFor(body, hash) : [];
    values.push(
      Prisma.sql`(${row.id}, ${userId}, ${row.conversationId}, ${row.role}::"Role", ${row.createdAt}, ${keyId}, ${RECALL_INDEX_VERSION}, ${tokens}::text[], ${tokens.length}, ${now})`
    );
  }
  for (let i = 0; i < values.length; i += 200) {
    await deps.run(Prisma.sql`
      INSERT INTO "MessageRecallIndex" ("messageId", "userId", "conversationId", "role", "createdAt", "keyId", "version", "tokens", "tokenCount", "indexedAt")
      VALUES ${Prisma.join(values.slice(i, i + 200))}
      ON CONFLICT ("messageId") DO UPDATE SET
        "keyId" = EXCLUDED."keyId",
        "version" = EXCLUDED."version",
        "tokens" = EXCLUDED."tokens",
        "tokenCount" = EXCLUDED."tokenCount",
        "indexedAt" = EXCLUDED."indexedAt"
      RETURNING "messageId"
    `);
  }
  return { indexed: rows.length, unreadable };
}

export async function pendingRecallCount(deps: RecallDeps, userId: string): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const [row] = await deps.run<{ pending: number }>(
    recallPendingCountSql({
      userId,
      version: RECALL_INDEX_VERSION,
      keyId: deps.activeKeyId(),
      before: new Date(now.getTime() - RECALL_SETTLE_MS),
    })
  );
  return row?.pending ?? 0;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface RecallHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  role: string;
  createdAt: Date;
  /** The decrypted body — in memory only, for the excerpt. */
  body: string;
  /** The query words it contains (stems, as tokenised), for highlighting. */
  matchedWords: string[];
  score: number;
}

export interface RecallSearchOutcome {
  hits: RecallHit[];
  /** Messages in the index for this account. */
  indexed: number;
  /** Messages not yet indexed (a partial result says so). */
  pending: number;
  /** Search time, split, for the benchmark. */
  timings: { candidatesMs: number; rankMs: number; verifyMs: number };
}

export async function searchRecall(
  deps: RecallDeps,
  request: { userId: string; query: string; projectId: string | null; since: Date | null; limit: number; catchUp?: number }
): Promise<RecallSearchOutcome> {
  const now = deps.now?.() ?? new Date();
  if (request.catchUp && request.catchUp > 0) {
    await indexPendingMessages(deps, request.userId, { limit: request.catchUp });
  }
  const query = parseRecallQuery(request.query, now);
  const [[stats], pending] = await Promise.all([
    deps.run<{ n: number; meanTokens: number; keyIds: string[] }>(recallStatsSql(request.userId)),
    pendingRecallCount(deps, request.userId),
  ]);
  const empty = { hits: [], indexed: stats?.n ?? 0, pending, timings: { candidatesMs: 0, rankMs: 0, verifyMs: 0 } };
  if (query.words.length === 0 || !stats || stats.n === 0) return empty;

  // Hash the query under every key the account's index was built with.
  const wordOf = new Map<string, string>();
  const entityOf = new Map<string, string>();
  for (const keyId of stats.keyIds) {
    const hash = deps.hasher(request.userId, keyId);
    if (!hash) continue;
    for (const word of query.words) wordOf.set(hash(`w:${word}`), word);
    for (const entity of query.entities) entityOf.set(hash(`e:${entity}`), entity);
  }
  const tokens = [...wordOf.keys(), ...entityOf.keys()];
  if (tokens.length === 0) return empty;

  const t0 = performance.now();
  const [rows, dfRows] = await Promise.all([
    deps.run<RecallCandidateRow>(
      recallCandidatesSql({
        userId: request.userId,
        tokens,
        projectId: request.projectId,
        since: request.since,
        limit: RECALL_CANDIDATES,
      })
    ),
    deps.run<{ token: string; df: number }>(recallDocumentFrequencySql({ userId: request.userId, tokens: [...wordOf.keys()] })),
  ]);
  const t1 = performance.now();

  const df = new Map<string, number>();
  for (const row of dfRows) {
    const word = wordOf.get(row.token);
    if (word) df.set(word, (df.get(word) ?? 0) + row.df);
  }
  const ranked = rankRecallCandidates(
    rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      matchedWords: [...new Set(row.matched.map((t) => wordOf.get(t)).filter((w): w is string => !!w))],
      matchedEntities: [...new Set(row.matched.map((t) => entityOf.get(t)).filter((e): e is string => !!e))],
    })),
    { query, corpusSize: stats.n, documentFrequency: df, meanTokenCount: stats.meanTokens, projectId: request.projectId, now }
  );
  const t2 = performance.now();

  const top = ranked.slice(0, RECALL_VERIFY);
  const bodies = top.length
    ? await deps.run<{ id: string; content: string }>(
        recallBodiesSql({ userId: request.userId, messageIds: top.map((c) => c.messageId) })
      )
    : [];
  const bodyOf = new Map(bodies.map((b) => [b.id, deps.decrypt(b.content)]));
  const floor = minimumCoverage(query.words.length);
  const hits: RecallHit[] = [];
  for (const candidate of top) {
    const body = bodyOf.get(candidate.messageId);
    if (!body || body === deps.unreadable) continue;
    const verified = verifyRecallMatch(body, candidate.matchedWords);
    if (verified.length < floor) continue; // a truncated-HMAC collision, or an edit since indexing
    hits.push({
      messageId: candidate.messageId,
      conversationId: candidate.conversationId,
      conversationTitle: candidate.conversationTitle,
      projectId: candidate.projectId,
      role: candidate.role,
      createdAt: candidate.createdAt,
      body,
      matchedWords: verified,
      score: candidate.score,
    });
    if (hits.length >= request.limit) break;
  }
  const t3 = performance.now();
  return {
    hits,
    indexed: stats.n,
    pending,
    timings: { candidatesMs: t1 - t0, rankMs: t2 - t1, verifyMs: t3 - t2 },
  };
}
