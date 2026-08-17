import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";
import { describeLocator, type BlockLocation } from "@/lib/knowledge/chunk";
import { embedQuery, type EmbeddingUnavailableReason } from "@/lib/knowledge/embed";
import {
  lexicalCandidateQuery,
  RETRIEVABLE_STATES,
  type LexicalQueryFilters,
} from "@/lib/knowledge/lexical-query";
import {
  cosineSimilarity,
  lexicalQueryExpression,
  packContext,
  reciprocalRankFusion,
  rerankPassages,
  type PackOptions,
  type RerankOptions,
  type RetrievalCandidate,
  type ScoredPassage,
} from "@/lib/knowledge/rank";

/**
 * Hybrid retrieval over a user's indexed documents.
 *
 * The database and provider half; `rank.ts` holds the arithmetic. What lives
 * here is everything that can only be got wrong against a real Postgres:
 *
 *  - **Scoping.** Every query is filtered by `userId`, and the lexical query is
 *    filtered by it *twice* — once on the chunk and once on the joined
 *    document. That is not belt-and-braces for its own sake: `$queryRaw`
 *    bypasses the ownership guard in `db.ts` entirely (the extension hooks
 *    model operations, and a raw query is not one), so this file is the only
 *    thing standing between one person's documents and another's. The join
 *    condition alone would be enough if `KnowledgeChunk.userId` were guaranteed
 *    to agree with its document's — writing both means a row where they
 *    disagree is invisible rather than leaked.
 *
 *  - **Bounding.** Semantic search runs in process over `Float[]` columns, with
 *    no pgvector extension to lean on (a deliberate schema choice — see the
 *    comment on `KnowledgeChunk.embedding`). So the candidate set has to be
 *    bounded before the vectors are loaded, and the lexical query is what
 *    bounds it. The cost of that is stated plainly below, because it is a real
 *    limitation and not a detail.
 *
 *  - **Degrading.** No embedding provider is a normal state, not an error. It
 *    happens whenever the account's background-provider policy has nothing to
 *    permit — which includes the common case of a `same_provider` policy on an
 *    Anthropic conversation, since Anthropic has no embeddings endpoint. The
 *    result then carries `mode: "lexical"` and the reason, and the caller shows
 *    a degraded state rather than an empty one.
 */

/**
 * How many lexical hits are pulled before semantic scoring.
 *
 * The ceiling on memory as much as on time: a 3072-dimension vector is ~24KB of
 * JavaScript numbers, so 120 candidates is a few megabytes per request and 1000
 * would not be.
 */
const LEXICAL_CANDIDATE_LIMIT = 120;

/**
 * How many chunks are fetched in the independent vector retrieval leg.
 *
 * This is the RAG v2 addition: chunks found purely by embedding cosine
 * similarity, without lexical overlap. Kept moderate because each row carries
 * a full embedding vector (~24KB for 3072-dim) and we compute cosine in JS.
 * The sweet spot is enough to catch pure paraphrases while staying under a
 * few MB of working memory per request.
 */
const VECTOR_CANDIDATE_LIMIT = 60;

/**
 * Retrieval filters: project, document, type and date.
 *
 * Typed as the lexical query's own filter shape so the two cannot drift. Type
 * filtering is by document MIME type rather than by block type, because a chunk
 * routinely spans a heading, its paragraphs and a table cell — there is no
 * single block type to filter it on. The date bounds are on when the document
 * entered the library, not on when it was written; nothing in the schema claims
 * to know the latter.
 */
export type KnowledgeFilters = LexicalQueryFilters;

/**
 * Why retrieval ran without its semantic leg.
 *
 * The embedding reasons are passed through unchanged because they are the ones
 * a user can act on ("your background-provider policy allows no provider that
 * offers embeddings"). The three added here are retrieval's own, and they are
 * separate precisely so the degraded state does not blame the provider for a
 * corpus that simply has not been embedded yet.
 */
export type LexicalOnlyReason =
  | EmbeddingUnavailableReason
  /** The question contained no searchable term at all. */
  | "unsearchable_query"
  /** The full-text query itself failed; the turn continues without documents. */
  | "lexical_query_failed"
  /** Embeddings were available, but no candidate carried a vector to compare. */
  | "no_indexed_vectors";

export interface RetrieveOptions {
  userId: string;
  query: string;
  filters?: KnowledgeFilters;
  /** Where this account's content may be sent for embedding. */
  policy: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  /** Passages returned before packing. */
  limit?: number;
  rerank?: Omit<RerankOptions, "projectId">;
  pack?: PackOptions;
  signal?: AbortSignal;
  /** Test seam: the embedding call, so retrieval can be exercised without a key. */
  embed?: typeof embedQuery;
}

export interface KnowledgeRetrieval {
  passages: ScoredPassage[];
  /** "hybrid" when vectors contributed to the ranking; "lexical" when not. */
  mode: "hybrid" | "lexical";
  /** Why the semantic leg was missing. Absent when the mode is hybrid. */
  degradedReason?: LexicalOnlyReason;
  /** Which vector space the semantic leg used, for the audit trail. */
  embeddingModel?: string;
  /** Lexical candidates considered — the ceiling recall was chosen from. */
  candidatesConsidered: number;
  /** Estimated tokens of the packed context. */
  tokens: number;
  droppedForBudget: number;
}

interface CandidateRow {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  blockIds: string[];
  embedding: number[] | null;
  embeddingModel: string | null;
  fileName: string;
  mimeType: string;
  projectId: string | null;
  documentAt: Date;
  lexicalScore: number;
}

/** The lexical leg: run the composed statement (see lexical-query.ts). */
async function lexicalCandidates(
  userId: string,
  expression: string,
  filters: KnowledgeFilters | undefined,
  withEmbeddings: boolean
): Promise<CandidateRow[]> {
  return prisma.$queryRaw<CandidateRow[]>(
    lexicalCandidateQuery({
      userId,
      expression,
      filters,
      withEmbeddings,
      limit: LEXICAL_CANDIDATE_LIMIT,
    })
  );
}

/**
 * Independent vector retrieval (RAG v2).
 *
 * Fetches chunks directly by cosine similarity against the query embedding,
 * bypassing the lexical prefilter entirely. This is what closes the paraphrase
 * recall gap: "how do I get my money back" now finds documents that only say
 * "refund" even with zero lexical overlap.
 *
 * Uses in-process cosine similarity over Float[] columns. For larger corpora
 * a pgvector HNSW index would be faster, but this works correctly at the
 * per-user library scale without requiring the extension.
 */
async function vectorCandidates(
  userId: string,
  queryVector: number[],
  embeddingModelId: string,
  filters: KnowledgeFilters | undefined,
  limit: number
): Promise<CandidateRow[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`c."userId" = ${userId}`,
    Prisma.sql`c."deletedAt" IS NULL`,
    Prisma.sql`c."embeddingModel" = ${embeddingModelId}`,
    Prisma.sql`array_length(c.embedding, 1) > 0`,
    Prisma.sql`d."deletedAt" IS NULL`,
    Prisma.sql`d."supersededById" IS NULL`,
    Prisma.sql`d."state" = ANY(${RETRIEVABLE_STATES})`,
  ];

  if (filters?.projectId !== undefined) {
    conditions.push(
      filters.projectId === null
        ? Prisma.sql`d."projectId" IS NULL`
        : Prisma.sql`d."projectId" = ${filters.projectId}`
    );
  }
  if (filters?.documentIds?.length) {
    conditions.push(Prisma.sql`c."documentId" = ANY(${[...filters.documentIds]})`);
  }

  // Fetch chunks with embeddings, then score in-process.
  // We fetch more than `limit` to have a good pool, then sort by cosine and take top N.
  const fetchLimit = Math.min(limit * 3, 300);

  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT
      c.id,
      c."documentId",
      c.ordinal,
      c.text,
      c."blockIds",
      c.embedding,
      c."embeddingModel",
      d."fileName",
      d."mimeType",
      d."projectId",
      COALESCE(d."indexedAt", d."createdAt") AS "documentAt",
      0.0 AS "lexicalScore"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeDocument" d ON d.id = c."documentId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY c."createdAt" DESC
    LIMIT ${fetchLimit}
  `);

  if (rows.length === 0) return [];

  // Score by cosine similarity and return top N
  const scored = rows
    .filter((row) => row.embedding && row.embedding.length > 0)
    .map((row) => ({
      row,
      score: cosineSimilarity(queryVector, row.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((entry) => entry.row);
}

/** Resolve the citation blocks for the packed passages, in one scoped query. */
async function resolveLocators(
  userId: string,
  passages: readonly ScoredPassage[]
): Promise<ScoredPassage[]> {
  const ids = [...new Set(passages.flatMap((passage) => passage.blockIds))];
  if (ids.length === 0) return [...passages];

  const blocks = await prisma.knowledgeBlock.findMany({
    where: { userId, id: { in: ids }, deletedAt: null },
    select: {
      id: true,
      page: true,
      slide: true,
      sheet: true,
      cellRange: true,
      path: true,
      lineStart: true,
      lineEnd: true,
      heading: true,
      ordinal: true,
    },
    orderBy: { ordinal: "asc" },
  });
  const byId = new Map<string, BlockLocation & { ordinal: number }>(
    blocks.map((block) => [block.id, block])
  );

  return passages.map((passage) => {
    const located = passage.blockIds
      .map((id) => byId.get(id))
      .filter((block): block is BlockLocation & { ordinal: number } => Boolean(block))
      .sort((a, b) => a.ordinal - b.ordinal);
    return { ...passage, locator: describeLocator(located) };
  });
}

/**
 * Retrieve passages for a question, with the citations that let an answer point
 * at page 4.
 *
 * Never throws for want of an embedding provider, and never returns a passage
 * without `documentId`, `blockIds` and a `locator` — an uncitable passage is
 * indistinguishable from the model making something up, which is the failure
 * this whole subsystem exists to prevent.
 */
export async function retrieveKnowledge(options: RetrieveOptions): Promise<KnowledgeRetrieval> {
  const empty = (
    mode: "hybrid" | "lexical",
    degradedReason?: LexicalOnlyReason
  ): KnowledgeRetrieval => ({
    passages: [],
    mode,
    ...(degradedReason ? { degradedReason } : {}),
    candidatesConsidered: 0,
    tokens: 0,
    droppedForBudget: 0,
  });

  // The query vector is fetched first because whether it exists decides whether
  // the candidate rows need to carry their (large) vectors at all, AND whether
  // to run the independent vector retrieval path.
  const embed = options.embed ?? embedQuery;
  const embedded = await embed({
    text: options.query,
    policy: options.policy,
    conversationProvider: options.conversationProvider,
    signal: options.signal,
  });

  // ---- Leg 1: Lexical candidates ----
  const expression = lexicalQueryExpression(options.query);
  let lexicalRows: CandidateRow[] = [];
  if (expression) {
    try {
      lexicalRows = await lexicalCandidates(options.userId, expression, options.filters, embedded.ok);
    } catch (error) {
      console.error(
        "[knowledge/retrieve] lexical query failed:",
        error instanceof Error ? error.message : String(error)
      );
      // Continue with vector-only path if available
    }
  }

  // ---- Leg 2: Independent vector retrieval (RAG v2) ----
  // This is the key change: fetch semantically similar chunks directly without
  // requiring lexical overlap. This fixes the paraphrase recall bottleneck
  // where "how do I get my money back" finds documents that only say "refund".
  let vectorRows: CandidateRow[] = [];
  if (embedded.ok) {
    try {
      vectorRows = await vectorCandidates(
        options.userId,
        embedded.vector,
        embedded.model.id,
        options.filters,
        VECTOR_CANDIDATE_LIMIT
      );
    } catch (error) {
      console.error(
        "[knowledge/retrieve] vector retrieval failed:",
        error instanceof Error ? error.message : String(error)
      );
      // Fall through to lexical-only
    }
  }

  // If both legs returned nothing, return empty
  if (lexicalRows.length === 0 && vectorRows.length === 0) {
    if (!expression) return empty("lexical", "unsearchable_query");
    return {
      ...empty(embedded.ok ? "hybrid" : "lexical", embedded.ok ? undefined : embedded.reason),
      ...(embedded.ok ? { embeddingModel: embedded.model.id } : {}),
    };
  }

  // Merge all candidate rows into a single map, deduplicating by chunk id
  const candidates = new Map<string, RetrievalCandidate>();
  const allRows = [...lexicalRows, ...vectorRows];
  for (const row of allRows) {
    if (!candidates.has(row.id)) {
      candidates.set(row.id, {
        chunkId: row.id,
        documentId: row.documentId,
        fileName: row.fileName,
        mimeType: row.mimeType,
        projectId: row.projectId,
        ordinal: row.ordinal,
        text: row.text,
        blockIds: row.blockIds,
        documentAt: row.documentAt,
      });
    }
  }

  // Build independent rankings for RRF fusion

  // Lexical order: as returned by Postgres ts_rank
  const lexicalOrder = lexicalRows.map((row) => row.id);

  // Semantic order from lexical candidates (for candidates that have embeddings)
  let lexicalSemanticOrder: string[] = [];
  if (embedded.ok) {
    lexicalSemanticOrder = lexicalRows
      .filter((row) => row.embeddingModel === embedded.model.id && row.embedding?.length)
      .map((row) => ({ id: row.id, score: cosineSimilarity(embedded.vector, row.embedding!) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .map((entry) => entry.id);
  }

  // Independent vector order: chunks found purely by embedding similarity
  const vectorOrder = vectorRows.map((row) => row.id);

  // Build the rankings array for RRF: include all non-empty legs
  const rankings: string[][] = [];
  if (lexicalOrder.length > 0) rankings.push(lexicalOrder);
  if (lexicalSemanticOrder.length > 0) rankings.push(lexicalSemanticOrder);
  if (vectorOrder.length > 0) rankings.push(vectorOrder);

  // If no rankings at all, return empty
  if (rankings.length === 0) {
    return empty("lexical", embedded.ok ? "no_indexed_vectors" : embedded.reason);
  }

  const fused = reciprocalRankFusion(rankings);

  const scored: ScoredPassage[] = fused.map((entry) => ({
    ...candidates.get(entry.id)!,
    score: entry.score,
    lexicalRank: entry.ranks[0] ?? null,
    semanticRank: rankings.length > 1 ? entry.ranks[1] ?? null : null,
    locator: "",
  }));

  const reranked = rerankPassages(scored, {
    ...options.rerank,
    projectId: options.filters?.projectId ?? null,
    limit: options.limit ?? options.rerank?.limit,
  });
  const packed = packContext(reranked, options.pack);
  const passages = await resolveLocators(options.userId, packed.passages);

  // Hybrid means vectors actually contributed to ranking
  const hybrid = lexicalSemanticOrder.length > 0 || vectorOrder.length > 0;
  return {
    passages,
    mode: hybrid ? "hybrid" : "lexical",
    ...(hybrid
      ? { embeddingModel: embedded.ok ? embedded.model.id : undefined }
      : { degradedReason: embedded.ok ? "no_indexed_vectors" : embedded.reason }),
    candidatesConsidered: candidates.size,
    tokens: packed.tokens,
    droppedForBudget: packed.droppedForBudget,
  };
}

// ---------------------------------------------------------------------------
// The chat entry point
// ---------------------------------------------------------------------------

export interface ProjectKnowledgeContext {
  passages: ScoredPassage[];
  mode: "hybrid" | "lexical";
  degradedReason?: LexicalOnlyReason;
  /**
   * File names covered by the index for this project.
   *
   * The chat route injects project reference files wholesale. Where a file has
   * been indexed, the retrieved passages replace that dump — otherwise the same
   * document is in the prompt twice, once entire and once in extract, and the
   * whole point of retrieval (a prompt that does not grow with the library) is
   * lost.
   */
  indexedFileNames: string[];
}

/**
 * Whether a project has anything indexed, and what it says about the question.
 *
 * Returns null when the project has no ready documents at all — the caller then
 * behaves exactly as it did before this existed, which is the contract: a
 * project nobody has indexed must not change behaviour, and must not pay for an
 * embedding call to discover that.
 */
export async function retrieveProjectKnowledge(options: {
  userId: string;
  projectId: string;
  query: string;
  policy: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  signal?: AbortSignal;
  embed?: typeof embedQuery;
}): Promise<ProjectKnowledgeContext | null> {
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      userId: options.userId,
      projectId: options.projectId,
      state: { in: RETRIEVABLE_STATES },
      deletedAt: null,
      supersededById: null,
    },
    select: { fileName: true },
    take: 200,
  });
  if (documents.length === 0) return null;

  const retrieval = await retrieveKnowledge({
    userId: options.userId,
    query: options.query,
    filters: { projectId: options.projectId },
    policy: options.policy,
    conversationProvider: options.conversationProvider,
    signal: options.signal,
    embed: options.embed,
  });

  return {
    passages: retrieval.passages,
    mode: retrieval.mode,
    ...(retrieval.degradedReason ? { degradedReason: retrieval.degradedReason } : {}),
    indexedFileNames: [...new Set(documents.map((document) => document.fileName))],
  };
}

/**
 * Retrieve from files attached directly to a conversation.
 *
 * Project retrieval used to be the only caller because project documents were
 * the first knowledge surface. That made a direct PDF provider-dependent:
 * Anthropic received its bytes, while every other adapter saw only a filename
 * because the PDF has no flat `extractedText`. Attachment ids are the durable
 * join that works for both project and unfiled uploads, so use them as the
 * retrieval boundary rather than pretending every conversation has a project.
 */
export async function retrieveAttachmentKnowledge(options: {
  userId: string;
  attachmentIds: readonly string[];
  query: string;
  policy: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  signal?: AbortSignal;
  embed?: typeof embedQuery;
}): Promise<ProjectKnowledgeContext | null> {
  const attachmentIds = [...new Set(options.attachmentIds)].slice(0, 20);
  if (attachmentIds.length === 0 || !options.query.trim()) return null;

  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      userId: options.userId,
      attachmentId: { in: attachmentIds },
      state: { in: RETRIEVABLE_STATES },
      deletedAt: null,
      supersededById: null,
    },
    select: { id: true, fileName: true },
    take: 200,
  });
  if (documents.length === 0) return null;

  const retrieval = await retrieveKnowledge({
    userId: options.userId,
    query: options.query,
    filters: { documentIds: documents.map((document) => document.id) },
    policy: options.policy,
    conversationProvider: options.conversationProvider,
    signal: options.signal,
    embed: options.embed,
  });

  return {
    passages: retrieval.passages,
    mode: retrieval.mode,
    ...(retrieval.degradedReason ? { degradedReason: retrieval.degradedReason } : {}),
    indexedFileNames: [...new Set(documents.map((document) => document.fileName))],
  };
}

export type { ScoredPassage } from "@/lib/knowledge/rank";
