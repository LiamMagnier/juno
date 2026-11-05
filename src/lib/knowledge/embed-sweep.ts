/**
 * The project knowledge embedding sweep (PRJ-1).
 *
 * Ingest writes a document's chunks with no vectors and marks it
 * `embeddingState: "pending"`; this fills the vectors later, off the upload
 * path, so a slow or rate-limited embeddings provider never holds up an
 * upload and never leaves a document unretrievable. Lexical retrieval works
 * from the moment the chunks land; vectors only add paraphrase recall.
 *
 * Pure and injected, like `ingest.ts`: the decisions (what to claim, whether
 * the policy permits a provider, which vectors can be reused, when to stop
 * for the hour) are what need tests, and there is no database in the test
 * environment. `embed-sweep-store.ts` is the Prisma side.
 *
 * The policy is asked with NO conversation provider, because no conversation
 * is in progress. Under `same_provider`, the default, that permits no remote
 * model by design: those accounts get `lexical_only` with the denial reason
 * recorded, and semantic coverage for them waits on a local embedder (MEM-10).
 * `selected_provider` and `any_allowed_provider` accounts get vectors.
 */

import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";
import { packDocumentChunks, type ChunkableBlock, type PackedChunk } from "./chunk";

export const EMBED_SWEEP_INTERVAL_MS = 30_000;
/** Documents claimed per tick. Two keeps one tick well inside the interval. */
export const EMBED_SWEEP_BATCH = 2;
/** A claim older than this was abandoned by a process that died mid-document. */
export const EMBED_SWEEP_LEASE_MS = 15 * 60_000;
/** A lexical-only document is asked about again this often: the policy may have changed. */
export const LEXICAL_RECHECK_MS = 24 * 60 * 60_000;
/** Per account per hour, so one person's large library cannot starve the others. */
export const EMBED_CHUNKS_PER_USER_PER_HOUR = 2_000;

export interface ClaimedDocument {
  id: string;
  userId: string;
  projectId: string | null;
  chunkCount: number;
}

export interface SweepChunk {
  id: string;
  text: string;
  textHash: string | null;
}

export type EmbedOutcome =
  | { ok: true; model: { id: string }; vectors: number[][] }
  | { ok: false; reason: string; deniedReason?: string };

export interface EmbedSweepStore {
  /** Leases up to `limit` documents that need work. Cross-account by nature. */
  claim(now: Date, limit: number): Promise<ClaimedDocument[]>;
  /** Blocks of a document that was indexed before ingest wrote chunks. */
  blocksOf(userId: string, documentId: string): Promise<ChunkableBlock[]>;
  replaceChunks(userId: string, documentId: string, chunks: PackedChunk[]): Promise<void>;
  /** Chunks still without a vector. */
  chunksToEmbed(userId: string, documentId: string): Promise<SweepChunk[]>;
  /** The vector space most of this project's chunks are already in, so new ones stay comparable. */
  dominantModel(userId: string, projectId: string | null): Promise<string | null>;
  /** Vectors already computed for these exact inputs in this space, by text hash. */
  reusableVectors(userId: string, textHashes: string[], embeddingModel: string): Promise<Map<string, number[]>>;
  writeVectors(userId: string, embeddingModel: string, rows: Array<{ id: string; embedding: number[] }>): Promise<void>;
  finish(
    userId: string,
    documentId: string,
    patch: {
      embeddingState: "pending" | "embedded" | "lexical_only";
      embeddingModel?: string | null;
      embeddingReason?: string | null;
      chunkCount?: number;
      tokenCount?: number;
    }
  ): Promise<void>;
}

export interface EmbedSweepDeps {
  store: EmbedSweepStore;
  loadPolicy(userId: string): Promise<BackgroundProviderPolicy>;
  embed(options: {
    texts: string[];
    userId: string;
    policy: BackgroundProviderPolicy;
    conversationProvider: null;
    preferModelId: string | null;
  }): Promise<EmbedOutcome>;
  now?: () => Date;
  /** Chunks embedded per account in the current hour; owned by the caller so it survives ticks. */
  budget?: Map<string, { hour: number; used: number }>;
}

export interface SweepDocumentResult {
  documentId: string;
  state: "pending" | "embedded" | "lexical_only";
  embedded: number;
  reused: number;
  backfilled: boolean;
  reason?: string;
}

function hourOf(date: Date) {
  return Math.floor(date.getTime() / 3_600_000);
}

function spendBudget(deps: EmbedSweepDeps, userId: string, wanted: number, now: Date): boolean {
  if (!deps.budget || wanted === 0) return true;
  const hour = hourOf(now);
  const current = deps.budget.get(userId);
  const used = current && current.hour === hour ? current.used : 0;
  if (used + wanted > EMBED_CHUNKS_PER_USER_PER_HOUR) return false;
  deps.budget.set(userId, { hour, used: used + wanted });
  return true;
}

/** One claimed document: backfill its chunks if it has none, then embed what lacks a vector. */
export async function sweepDocument(deps: EmbedSweepDeps, document: ClaimedDocument): Promise<SweepDocumentResult> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  let backfilled = false;

  // Indexed before ingest wrote chunks: chunk from the stored blocks, with no
  // re-extraction (the bytes may not even be stored any more).
  if (document.chunkCount === 0) {
    const blocks = await store.blocksOf(document.userId, document.id);
    if (blocks.length === 0) {
      await store.finish(document.userId, document.id, { embeddingState: "lexical_only", embeddingReason: "no_text" });
      return { documentId: document.id, state: "lexical_only", embedded: 0, reused: 0, backfilled, reason: "no_text" };
    }
    const chunks = packDocumentChunks(blocks);
    await store.replaceChunks(document.userId, document.id, chunks);
    backfilled = true;
    await store.finish(document.userId, document.id, {
      embeddingState: "pending",
      chunkCount: chunks.length,
      tokenCount: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    });
  }

  const pending = await store.chunksToEmbed(document.userId, document.id);
  if (pending.length === 0) {
    await store.finish(document.userId, document.id, { embeddingState: "embedded" });
    return { documentId: document.id, state: "embedded", embedded: 0, reused: 0, backfilled };
  }

  const preferModelId = await store.dominantModel(document.userId, document.projectId);

  // Chunking is deterministic, so a re-index after a parser bump produces the
  // same texts: their vectors are copied, not bought again.
  let reused = 0;
  let remaining = pending;
  if (preferModelId) {
    const hashes = pending.map((chunk) => chunk.textHash).filter((hash): hash is string => !!hash);
    const known = hashes.length ? await store.reusableVectors(document.userId, hashes, preferModelId) : new Map<string, number[]>();
    const copies = pending
      .filter((chunk) => chunk.textHash && known.has(chunk.textHash))
      .map((chunk) => ({ id: chunk.id, embedding: known.get(chunk.textHash!)! }));
    if (copies.length) {
      await store.writeVectors(document.userId, preferModelId, copies);
      reused = copies.length;
      const copied = new Set(copies.map((copy) => copy.id));
      remaining = pending.filter((chunk) => !copied.has(chunk.id));
    }
  }
  if (remaining.length === 0) {
    await store.finish(document.userId, document.id, { embeddingState: "embedded", embeddingModel: preferModelId, embeddingReason: null });
    return { documentId: document.id, state: "embedded", embedded: 0, reused, backfilled };
  }

  if (!spendBudget(deps, document.userId, remaining.length, now)) {
    // Back in the queue for a later hour, not marked lexical-only: nothing
    // about the account changed, it simply used its hour.
    await store.finish(document.userId, document.id, { embeddingState: "pending" });
    return { documentId: document.id, state: "pending", embedded: 0, reused, backfilled, reason: "hourly_limit" };
  }

  const policy = await deps.loadPolicy(document.userId);
  const result = await deps.embed({
    texts: remaining.map((chunk) => chunk.text),
    userId: document.userId,
    policy,
    conversationProvider: null,
    preferModelId,
  });
  if (!result.ok || result.vectors.length !== remaining.length) {
    const reason = result.ok ? "vector_count_mismatch" : result.deniedReason ?? result.reason;
    await store.finish(document.userId, document.id, {
      embeddingState: "lexical_only",
      embeddingReason: reason,
      ...(reused ? { embeddingModel: preferModelId } : {}),
    });
    return { documentId: document.id, state: "lexical_only", embedded: 0, reused, backfilled, reason };
  }

  await store.writeVectors(
    document.userId,
    result.model.id,
    remaining.map((chunk, index) => ({ id: chunk.id, embedding: result.vectors[index] }))
  );
  await store.finish(document.userId, document.id, { embeddingState: "embedded", embeddingModel: result.model.id, embeddingReason: null });
  return { documentId: document.id, state: "embedded", embedded: remaining.length, reused, backfilled };
}

/** One tick: claim a few documents and sweep each. A failure in one never stops the others. */
export async function runEmbedSweep(deps: EmbedSweepDeps): Promise<SweepDocumentResult[]> {
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.store.claim(now, EMBED_SWEEP_BATCH);
  const results: SweepDocumentResult[] = [];
  for (const document of claimed) {
    try {
      results.push(await sweepDocument(deps, document));
    } catch (error) {
      // Left `embedding` with its lease: it is claimed again once the lease
      // runs out, rather than flipped to a state that says something false.
      console.error("[knowledge/embed-sweep]", document.id, error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}
