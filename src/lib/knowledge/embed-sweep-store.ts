/**
 * The Prisma side of the project knowledge embedding sweep (PRJ-1).
 *
 * The claim is the one cross-account statement, and is written against
 * `prismaUnguarded` on purpose so the intent is explicit: the sweep has no
 * request user, and finds the documents that need work across accounts. It
 * then re-binds the owner it found in the conditional update that takes the
 * lease, and every later statement is scoped to that owner through the
 * guarded client.
 */

import "server-only";
import { prisma } from "@/lib/prisma";
import { prismaUnguarded } from "@/lib/db";
import { RETRIEVABLE_STATES } from "./lexical-query";
import { EMBED_SWEEP_LEASE_MS, LEXICAL_RECHECK_MS, type EmbedSweepStore } from "./embed-sweep";
import { createHash } from "node:crypto";

const VECTOR_WRITE_BATCH = 200;

export const prismaEmbedSweepStore: EmbedSweepStore = {
  async claim(now, limit) {
    const staleBefore = new Date(now.getTime() - EMBED_SWEEP_LEASE_MS);
    const recheckBefore = new Date(now.getTime() - LEXICAL_RECHECK_MS);
    const needsWork = {
      deletedAt: null,
      supersededById: null,
      state: { in: RETRIEVABLE_STATES },
      OR: [
        { embeddingState: "pending" },
        { embeddingState: "embedding", OR: [{ embeddingClaimedAt: null }, { embeddingClaimedAt: { lt: staleBefore } }] },
        { embeddingState: "lexical_only", OR: [{ embeddingClaimedAt: null }, { embeddingClaimedAt: { lt: recheckBefore } }] },
      ],
    };
    const candidates = await prismaUnguarded.knowledgeDocument.findMany({
      where: needsWork,
      select: { id: true, userId: true, projectId: true, chunkCount: true },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(limit, 20)),
    });
    const claimed = [];
    for (const document of candidates) {
      // The same predicate again, with the owner: a second sweeper that got
      // there first makes this match nothing.
      const lease = await prismaUnguarded.knowledgeDocument.updateMany({
        where: { id: document.id, userId: document.userId, ...needsWork },
        data: { embeddingState: "embedding", embeddingClaimedAt: now },
      });
      if (lease.count === 1) claimed.push(document);
    }
    return claimed;
  },

  async blocksOf(userId, documentId) {
    const rows = await prisma.knowledgeBlock.findMany({
      where: { userId, documentId, deletedAt: null },
      select: { id: true, ordinal: true, type: true, text: true, heading: true },
      orderBy: { ordinal: "asc" },
    });
    return rows;
  },

  async replaceChunks(userId, documentId, chunks) {
    await prisma.knowledgeChunk.deleteMany({ where: { userId, documentId } });
    for (let i = 0; i < chunks.length; i += 500) {
      await prisma.knowledgeChunk.createMany({
        data: chunks.slice(i, i + 500).map((chunk) => ({
          userId,
          documentId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          tokens: chunk.tokens,
          blockIds: chunk.blockIds,
          textHash: createHash("sha256").update(chunk.text).digest("hex"),
        })),
      });
    }
  },

  async chunksToEmbed(userId, documentId) {
    return prisma.knowledgeChunk.findMany({
      where: { userId, documentId, deletedAt: null, embedding: { isEmpty: true } },
      select: { id: true, text: true, textHash: true },
      orderBy: { ordinal: "asc" },
    });
  },

  async dominantModel(userId, projectId) {
    const spaces = await prisma.knowledgeDocument.groupBy({
      by: ["embeddingModel"],
      where: { userId, projectId, deletedAt: null, embeddingModel: { not: null } },
      _count: { _all: true },
    });
    const top = spaces.sort((a, b) => b._count._all - a._count._all)[0];
    return top?.embeddingModel ?? null;
  },

  async reusableVectors(userId, textHashes, embeddingModel) {
    const rows = await prisma.knowledgeChunk.findMany({
      where: {
        userId,
        textHash: { in: textHashes },
        embeddingModel,
        deletedAt: null,
        NOT: { embedding: { isEmpty: true } },
      },
      select: { textHash: true, embedding: true },
      distinct: ["textHash"],
    });
    return new Map(rows.filter((row) => row.textHash).map((row) => [row.textHash!, row.embedding]));
  },

  async writeVectors(userId, embeddingModel, rows) {
    for (let i = 0; i < rows.length; i += VECTOR_WRITE_BATCH) {
      await prisma.$transaction(
        rows.slice(i, i + VECTOR_WRITE_BATCH).map((row) =>
          prisma.knowledgeChunk.updateMany({
            where: { id: row.id, userId },
            data: { embedding: row.embedding, embeddingModel },
          })
        )
      );
    }
  },

  async finish(userId, documentId, patch) {
    await prisma.knowledgeDocument.updateMany({
      where: { id: documentId, userId },
      data: patch,
    });
  },
};
