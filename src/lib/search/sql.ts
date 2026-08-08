/**
 * The statements unified search runs, built as `Prisma.Sql` values.
 *
 * Separated from index.ts (which executes them) for one reason above all: these
 * are the only queries in the codebase that reach user data through
 * `$queryRaw`, and `$queryRaw` goes around the Prisma ownership guard in
 * src/lib/db.ts entirely — the extension intercepts model operations, not raw
 * SQL. Nothing will catch a missing `"userId" = …` here. So every branch is
 * built in one file, each one carries the scope explicitly, and
 * tests/unified-search.test.ts asserts it statement by statement against the
 * compiled SQL rather than trusting a review to have noticed.
 *
 * Two further rules hold throughout:
 *
 *  - `to_tsquery('simple', …)` matches the way src/lib/search/query.ts marks:
 *    no stemming, prefix per token, stopwords kept. See the comment at the top
 *    of that file for why truthful highlighting was worth the lost recall.
 *
 *  - No tsvector column exists and this slice may not add a migration, so the
 *    vectors are computed at query time and Postgres will scan. Every statement
 *    is therefore scoped by `userId` FIRST (an indexed column on every table
 *    here) and hard-capped with LIMIT. That is what keeps the cost proportional
 *    to one account's corpus rather than the table.
 */

import { Prisma } from "@prisma/client";

/**
 * How much text is pulled back for snippeting, and how much of it sits before
 * the match. A document's extracted text can be 200,000 characters; shipping
 * that for eight results to render one line each is the sort of thing that
 * makes a palette feel slow for reasons nobody can see.
 */
export const SNIPPET_CHARS = 520;
const SNIPPET_LEAD = 160;

export interface SearchSqlOptions {
  userId: string;
  /** Output of buildTsQuery — token prefixes ANDed. */
  tsquery: string;
  /** First term, lowercased, used only to position the snippet window. */
  firstTerm: string;
  limit: number;
  since: Date | null;
  projectId: string | null;
}

/** `to_tsquery('simple', …)`, parameterised. */
function query(tsquery: string): Prisma.Sql {
  return Prisma.sql`to_tsquery('simple', ${tsquery})`;
}

/**
 * A window of `column` around the first occurrence of `term`, or the head of it
 * when the term is not in that column at all.
 *
 * The fallback is not a corner case: a row can match on its title while the
 * body it is snippeted from contains none of the terms. Returning the head lets
 * the caller's marker find nothing and report `snippet: null`, which is the
 * honest outcome — better than a fragment that implies the match was in it.
 *
 * `position()` is computed on `lower(column)`, whose character offsets can in
 * principle differ from the original for a few exotic case mappings. That only
 * nudges a 520-character window by a character or two; the marks the user sees
 * are computed in TypeScript from the returned text, so they stay correct
 * regardless.
 */
function snippetOf(column: Prisma.Sql, term: string): Prisma.Sql {
  // The `::int` casts are load-bearing. Prisma sends a JS number as a bigint
  // parameter, and Postgres has no `substr(text, bigint, bigint)` or
  // `left(text, bigint)` — the statement fails to plan at all, which cost six
  // of the eight sources on the first run against a real database.
  return Prisma.sql`CASE
    WHEN position(${term} in lower(${column})) > 0
      THEN substr(${column}, greatest(1, position(${term} in lower(${column})) - ${SNIPPET_LEAD}::int), ${SNIPPET_CHARS}::int)
    ELSE left(${column}, ${SNIPPET_CHARS}::int)
  END`;
}

/** `AND <cond>` when the filter is set, nothing when it is not. */
function optional(condition: Prisma.Sql | null): Prisma.Sql {
  return condition ? Prisma.sql` AND ${condition}` : Prisma.empty;
}

// ---------------------------------------------------------------------------
// Row shapes. Each mirrors its statement's select list exactly; index.ts maps
// them to SearchHit. `rank` is `real` in Postgres and arrives as a JS number.
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string;
  projectId: string | null;
  updatedAt: Date;
  rank: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  snippetSource: string;
  updatedAt: Date;
  rank: number;
}

export interface FileRow {
  id: string;
  fileName: string;
  storageKey: string;
  conversationId: string | null;
  messageId: string | null;
  projectId: string | null;
  snippetSource: string;
  updatedAt: Date;
  rank: number;
}

export interface KnowledgeRow {
  id: string;
  documentId: string;
  fileName: string;
  text: string;
  page: number | null;
  slide: number | null;
  sheet: string | null;
  cellRange: string | null;
  path: string | null;
  lineStart: number | null;
  projectId: string | null;
  storageKey: string | null;
  attachmentConversationId: string | null;
  updatedAt: Date;
  rank: number;
}

export interface ArtifactRow {
  id: string;
  identifier: string;
  title: string;
  conversationId: string;
  projectId: string | null;
  version: number;
  snippetSource: string;
  updatedAt: Date;
  rank: number;
}

export interface MemoryRow {
  id: string;
  snippetSource: string;
  category: string | null;
  status: string;
  projectId: string | null;
  updatedAt: Date;
  rank: number;
}

export interface WorkSessionRow {
  id: string;
  title: string;
  goal: string;
  status: string;
  projectId: string | null;
  updatedAt: Date;
  rank: number;
}

export interface WorkEventRow {
  id: string;
  seq: number;
  kind: string;
  runId: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string | null;
  snippetSource: string;
  updatedAt: Date;
  rank: number;
}

export interface MessageScanRow {
  id: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  role: string;
  content: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** Conversation titles. The cheapest branch, and the one people expect most. */
export function conversationSearchSql(o: SearchSqlOptions): Prisma.Sql {
  return Prisma.sql`
    SELECT c."id",
           c."title",
           c."projectId",
           c."lastMessageAt" AS "updatedAt",
           ts_rank(to_tsvector('simple', c."title"), ${query(o.tsquery)}) AS rank
      FROM "Conversation" c
     WHERE c."userId" = ${o.userId}
       AND to_tsvector('simple', c."title") @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`c."lastMessageAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`c."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, c."lastMessageAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Projects, over the name AND the custom instructions.
 *
 * Instructions are searched because they are where a project's real subject
 * matter is written down — the name is often two words chosen in a hurry.
 */
export function projectSearchSql(o: SearchSqlOptions): Prisma.Sql {
  const body = Prisma.sql`(p."name" || ' ' || coalesce(p."instructions", ''))`;
  return Prisma.sql`
    SELECT p."id",
           p."name",
           ${snippetOf(Prisma.sql`coalesce(p."instructions", '')`, o.firstTerm)} AS "snippetSource",
           p."updatedAt",
           ts_rank(to_tsvector('simple', ${body}), ${query(o.tsquery)}) AS rank
      FROM "Project" p
     WHERE p."userId" = ${o.userId}
       AND to_tsvector('simple', ${body}) @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`p."updatedAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`p."id" = ${o.projectId}` : null)}
     ORDER BY rank DESC, p."updatedAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Attachments, over the file name and whatever text was extracted from them.
 *
 * `extractedText` is capped before it is vectorised. A 200,000-character PDF
 * costs more to tokenise than every other branch combined, and the tail of a
 * long document is served by the knowledge index below — which has per-block
 * locators and can actually say "page 4" — rather than by this row.
 */
export function fileSearchSql(o: SearchSqlOptions): Prisma.Sql {
  const body = Prisma.sql`(a."fileName" || ' ' || left(coalesce(a."extractedText", ''), 100000))`;
  return Prisma.sql`
    SELECT a."id",
           a."fileName",
           a."storageKey",
           a."conversationId",
           a."messageId",
           a."projectId",
           ${snippetOf(Prisma.sql`coalesce(a."extractedText", '')`, o.firstTerm)} AS "snippetSource",
           a."createdAt" AS "updatedAt",
           ts_rank(to_tsvector('simple', ${body}), ${query(o.tsquery)}) AS rank
      FROM "Attachment" a
     WHERE a."userId" = ${o.userId}
       AND to_tsvector('simple', ${body}) @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`a."createdAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`a."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, a."createdAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Knowledge blocks — the only source with a locator precise enough to cite.
 *
 * Superseded documents are excluded: re-indexing a replaced file keeps the old
 * version so existing citations still resolve, but showing both in search is
 * how a person ends up reading last month's copy of their own document.
 *
 * Both `KnowledgeBlock.userId` and `KnowledgeDocument.userId` are checked. The
 * join makes one of them redundant today; it stops being redundant the moment
 * anything ever writes a block under the wrong document, and this is the file
 * where redundant ownership checks are worth their cost.
 */
export function knowledgeSearchSql(o: SearchSqlOptions): Prisma.Sql {
  return Prisma.sql`
    SELECT b."id",
           b."documentId",
           d."fileName",
           left(b."text", ${SNIPPET_CHARS * 2}::int) AS text,
           b."page",
           b."slide",
           b."sheet",
           b."cellRange",
           b."path",
           b."lineStart",
           d."projectId",
           att."storageKey",
           att."conversationId" AS "attachmentConversationId",
           b."createdAt" AS "updatedAt",
           ts_rank(to_tsvector('simple', b."text"), ${query(o.tsquery)}) AS rank
      FROM "KnowledgeBlock" b
      JOIN "KnowledgeDocument" d ON d."id" = b."documentId"
      LEFT JOIN "Attachment" att ON att."id" = d."attachmentId" AND att."userId" = ${o.userId}
     WHERE b."userId" = ${o.userId}
       AND d."userId" = ${o.userId}
       AND d."supersededById" IS NULL
       AND to_tsvector('simple', b."text") @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`b."createdAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`d."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, b."createdAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Artifacts, over every stored version, reported as the best-matching one.
 *
 * `DISTINCT ON` rather than one row per version: a document edited nine times
 * would otherwise fill the entire group with nine copies of itself, and the
 * user's question is "where is that thing", not "which drafts contained the
 * word". The version that survives is the highest-ranked one, and the hit
 * carries its number so the destination opens that version rather than
 * whichever is current — which is the whole point of searching history.
 *
 * Artifact has no `userId` of its own; it is owned through its conversation,
 * so the scope is the join.
 */
export function artifactSearchSql(o: SearchSqlOptions): Prisma.Sql {
  const body = Prisma.sql`(coalesce(a."title", '') || ' ' || v."content")`;
  return Prisma.sql`
    SELECT * FROM (
      SELECT DISTINCT ON (v."artifactId")
             a."id",
             a."identifier",
             a."title",
             a."conversationId",
             c."projectId",
             v."version",
             ${snippetOf(Prisma.sql`v."content"`, o.firstTerm)} AS "snippetSource",
             v."createdAt" AS "updatedAt",
             ts_rank(to_tsvector('simple', ${body}), ${query(o.tsquery)}) AS rank
        FROM "ArtifactVersion" v
        JOIN "Artifact" a ON a."id" = v."artifactId"
        JOIN "Conversation" c ON c."id" = a."conversationId"
       WHERE c."userId" = ${o.userId}
         AND to_tsvector('simple', ${body}) @@ ${query(o.tsquery)}${optional(
           o.since ? Prisma.sql`v."createdAt" >= ${o.since}` : null
         )}${optional(o.projectId ? Prisma.sql`c."projectId" = ${o.projectId}` : null)}
       ORDER BY v."artifactId", rank DESC, v."version" DESC
    ) best
     ORDER BY best.rank DESC, best."updatedAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Memory entries.
 *
 * Expired entries are excluded — temporary context is supposed to disappear on
 * its own rather than age into a fact, and surfacing it in search is exactly
 * the resurrection the expiry exists to prevent. Superseded and contradicted
 * entries are kept, because "what did I used to believe" is a real question and
 * the status rides along on the hit so the UI can label it.
 */
export function memorySearchSql(o: SearchSqlOptions): Prisma.Sql {
  return Prisma.sql`
    SELECT m."id",
           ${snippetOf(Prisma.sql`m."content"`, o.firstTerm)} AS "snippetSource",
           m."category",
           m."status",
           m."projectId",
           m."updatedAt",
           ts_rank(to_tsvector('simple', m."content"), ${query(o.tsquery)}) AS rank
      FROM "MemoryEntry" m
     WHERE m."userId" = ${o.userId}
       AND m."status" <> 'expired'
       AND to_tsvector('simple', m."content") @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`m."updatedAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`m."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, m."updatedAt" DESC
     LIMIT ${o.limit}
  `;
}

/** Work sessions, over the title and the verbatim goal. */
export function workSessionSearchSql(o: SearchSqlOptions): Prisma.Sql {
  const body = Prisma.sql`(s."title" || ' ' || s."goal")`;
  return Prisma.sql`
    SELECT s."id",
           s."title",
           ${snippetOf(Prisma.sql`s."goal"`, o.firstTerm)} AS goal,
           s."status",
           s."projectId",
           s."lastActivityAt" AS "updatedAt",
           ts_rank(to_tsvector('simple', ${body}), ${query(o.tsquery)}) AS rank
      FROM "WorkSession" s
     WHERE s."userId" = ${o.userId}
       AND s."deletedAt" IS NULL
       AND to_tsvector('simple', ${body}) @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`s."lastActivityAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`s."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, s."lastActivityAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * What a Work run actually did, event by event.
 *
 * `visibility = 'user'` is load-bearing, not a tidiness filter. WorkEvent
 * defaults to `internal` precisely so that an event kind whose author forgot to
 * classify it stays invisible; search is a new reader of that table and must
 * honour the same default, or it becomes the one surface that leaks operator
 * and internal telemetry into the product.
 *
 * The payload is JSON and is matched as its text form. Crude — the keys are
 * matched alongside the values — but a run's payloads are short, and the
 * alternative (enumerating a text path per event kind) would silently stop
 * covering every kind added afterwards.
 */
export function workEventSearchSql(o: SearchSqlOptions): Prisma.Sql {
  const body = Prisma.sql`(e."payload"::text)`;
  return Prisma.sql`
    SELECT e."id",
           e."seq",
           e."kind",
           e."runId",
           r."sessionId",
           s."title" AS "sessionTitle",
           s."projectId",
           ${snippetOf(body, o.firstTerm)} AS "snippetSource",
           e."createdAt" AS "updatedAt",
           ts_rank(to_tsvector('simple', ${body}), ${query(o.tsquery)}) AS rank
      FROM "WorkEvent" e
      JOIN "WorkRun" r ON r."id" = e."runId" AND r."userId" = ${o.userId}
      JOIN "WorkSession" s ON s."id" = r."sessionId" AND s."userId" = ${o.userId}
     WHERE e."userId" = ${o.userId}
       AND e."visibility" = 'user'
       AND s."deletedAt" IS NULL
       AND to_tsvector('simple', ${body}) @@ ${query(o.tsquery)}${optional(
         o.since ? Prisma.sql`e."createdAt" >= ${o.since}` : null
       )}${optional(o.projectId ? Prisma.sql`s."projectId" = ${o.projectId}` : null)}
     ORDER BY rank DESC, e."createdAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * The message scan window: the most recently active conversations, newest
 * first.
 *
 * Message bodies are AES-GCM ciphertext (src/lib/message-crypto.ts), so no
 * amount of SQL can match them — `to_tsvector` over a ciphertext matches
 * nothing, which is the good outcome of a good decision. The only way to search
 * message text is to decrypt it, and the only way to decrypt it is to read the
 * rows. That is unbounded work, so it is bounded here instead: N conversations,
 * then M messages within them, and index.ts reports the bound to the user
 * rather than passing off a truncated search as a complete one.
 *
 * Two statements rather than one join, because `Conversation(userId,
 * lastMessageAt)` is indexed and `Message` is only indexed by
 * `(conversationId, createdAt)`. Picking the conversations first turns the
 * message read into a bounded lookup by an indexed key instead of a sort over
 * every message the account has ever sent.
 */
export function messageScanConversationsSql(
  o: Pick<SearchSqlOptions, "userId" | "since" | "projectId"> & { limit: number }
): Prisma.Sql {
  return Prisma.sql`
    SELECT c."id", c."title", c."projectId"
      FROM "Conversation" c
     WHERE c."userId" = ${o.userId}${optional(
       o.since ? Prisma.sql`c."lastMessageAt" >= ${o.since}` : null
     )}${optional(o.projectId ? Prisma.sql`c."projectId" = ${o.projectId}` : null)}
     ORDER BY c."lastMessageAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * Messages inside an already-authorised set of conversations.
 *
 * The conversation ids come from the statement above, which was itself scoped
 * by `userId`, and the join re-checks ownership anyway. Message carries no
 * userId column of its own, so the join IS the scope — dropping it would make
 * this the one query in the file that reads another account's rows.
 */
export function messageScanSql(o: {
  userId: string;
  conversationIds: readonly string[];
  since: Date | null;
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT m."id",
           m."conversationId",
           c."title" AS "conversationTitle",
           c."projectId",
           m."role"::text AS role,
           m."content",
           m."createdAt"
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId"
     WHERE c."userId" = ${o.userId}
       AND m."conversationId" IN (${Prisma.join(o.conversationIds)})${optional(
         o.since ? Prisma.sql`m."createdAt" >= ${o.since}` : null
       )}
     ORDER BY m."createdAt" DESC
     LIMIT ${o.limit}
  `;
}

/**
 * How many of the account's knowledge documents are not searchable right now.
 *
 * This is the number behind "3 documents are still being indexed". Without it
 * a user whose upload is mid-extraction searches, finds nothing, and concludes
 * Juno cannot read their file — the single most damaging thing a search box can
 * teach someone, because they will not try again.
 */
export function knowledgeReadinessSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE d."state" IN ('queued', 'extracting', 'ocr', 'indexing'))::int AS pending,
      count(*) FILTER (WHERE d."state" IN ('degraded', 'failed', 'stale'))::int AS impaired
      FROM "KnowledgeDocument" d
     WHERE d."userId" = ${userId}
       AND d."supersededById" IS NULL
  `;
}
