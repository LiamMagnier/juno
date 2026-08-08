import { Prisma } from "@prisma/client";
import { LEXICAL_TSCONFIG } from "@/lib/knowledge/rank";

/**
 * The full-text half of retrieval, as a composed statement rather than a call.
 *
 * Split out of `retrieve.ts`, and deliberately free of `server-only` and of any
 * Prisma *client*, for one reason: this is the only query in the knowledge
 * subsystem that the ownership guard in `db.ts` cannot see. The guard is a
 * Prisma query extension, and `$queryRaw` is not a model operation, so nothing
 * automatic stands between one person's documents and another's here. A rule
 * that important should be checkable without a database, and it is —
 * tests/knowledge-retrieve.test.ts reads the statement this returns and asserts
 * that the account is bound into it twice and that no user input reaches the
 * SQL as text.
 *
 * Every value is a bound parameter, including the text-search configuration and
 * the tsquery expression. The expression is sanitised separately by
 * `lexicalQueryExpression`, because a tsquery is its own small language and
 * binding it does not stop `!` or `<->` from meaning something inside it.
 */

/** Document states whose chunks are safe to answer from. */
export const RETRIEVABLE_STATES = ["ready", "degraded"];

export interface LexicalQueryFilters {
  /** Restrict to one project's documents. Null means "unfiled documents". */
  projectId?: string | null;
  documentIds?: readonly string[];
  mimeTypes?: readonly string[];
  since?: Date | null;
  until?: Date | null;
}

export interface LexicalQuerySpec {
  userId: string;
  /** Output of `lexicalQueryExpression` — sanitised tsquery syntax. */
  expression: string;
  filters?: LexicalQueryFilters;
  /**
   * Whether to select the vector columns. A 3072-dimension embedding is ~24KB
   * of JavaScript numbers per row, so they are only fetched when there is a
   * query vector to compare them against.
   */
  withEmbeddings: boolean;
  limit: number;
}

/**
 * `to_tsvector` is computed per row rather than read from an expression index,
 * because adding one is a migration and the schema is landed. At personal-
 * library scale (thousands of chunks, not millions) the scan is cheap; if it
 * stops being, the index belongs on `to_tsvector('simple', "text")` over
 * `KnowledgeChunk` and this statement needs no change to start using it.
 */
export function lexicalCandidateQuery(spec: LexicalQuerySpec): Prisma.Sql {
  const config = Prisma.sql`${LEXICAL_TSCONFIG}::regconfig`;
  const tsquery = Prisma.sql`to_tsquery(${config}, ${spec.expression})`;
  const tsvector = Prisma.sql`to_tsvector(${config}, c."text")`;
  const filters = spec.filters;

  const conditions: Prisma.Sql[] = [
    // Twice, on purpose. The join condition alone would be enough if
    // `KnowledgeChunk.userId` were guaranteed to agree with its document's;
    // asserting both means a row where they disagree is invisible rather than
    // leaked.
    Prisma.sql`c."userId" = ${spec.userId}`,
    Prisma.sql`d."userId" = ${spec.userId}`,
    Prisma.sql`c."deletedAt" IS NULL`,
    Prisma.sql`d."deletedAt" IS NULL`,
    Prisma.sql`d."state" = ANY(${RETRIEVABLE_STATES})`,
    // A superseded version keeps its rows so old citations still resolve, but
    // answering from a replaced document is answering from a stale one.
    Prisma.sql`d."supersededById" IS NULL`,
    Prisma.sql`${tsvector} @@ ${tsquery}`,
  ];

  if (filters?.projectId !== undefined) {
    conditions.push(
      filters.projectId === null
        ? Prisma.sql`d."projectId" IS NULL`
        : Prisma.sql`d."projectId" = ${filters.projectId}`
    );
  }
  if (filters?.documentIds?.length) {
    conditions.push(Prisma.sql`d."id" = ANY(${[...filters.documentIds]})`);
  }
  if (filters?.mimeTypes?.length) {
    conditions.push(Prisma.sql`d."mimeType" = ANY(${[...filters.mimeTypes]})`);
  }
  if (filters?.since) conditions.push(Prisma.sql`d."createdAt" >= ${filters.since}`);
  if (filters?.until) conditions.push(Prisma.sql`d."createdAt" <= ${filters.until}`);

  const embeddingColumns = spec.withEmbeddings
    ? Prisma.sql`c."embedding" AS "embedding", c."embeddingModel" AS "embeddingModel",`
    : Prisma.sql`NULL::double precision[] AS "embedding", NULL::text AS "embeddingModel",`;

  return Prisma.sql`
    SELECT c."id",
           c."documentId",
           c."ordinal",
           c."text",
           c."blockIds",
           ${embeddingColumns}
           d."fileName",
           d."mimeType",
           d."projectId",
           COALESCE(d."indexedAt", d."createdAt") AS "documentAt",
           ts_rank_cd(${tsvector}, ${tsquery}) AS "lexicalScore"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
     WHERE ${Prisma.join(conditions, " AND ")}
     ORDER BY "lexicalScore" DESC, c."documentId" ASC, c."ordinal" ASC
     LIMIT ${spec.limit}
  `;
}
