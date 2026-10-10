/**
 * The Prisma ThreadSync store (thread-sync.ts holds the rules). Every query is
 * scoped by the signed-in user's id.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sanitizePrefs, type SyncCursor, type ThreadSyncRow, type ThreadSyncStore } from "@/lib/sync/thread-sync";

type Record_ = {
  key: string;
  draft: string;
  draftUpdatedAt: Date | null;
  draftBy: string | null;
  prefs: Prisma.JsonValue;
  prefsUpdatedAt: Date | null;
  needsYou: boolean;
  readAt: Date | null;
  updatedAt: Date;
};

const toRow = (r: Record_): ThreadSyncRow => ({ ...r, prefs: sanitizePrefs(r.prefs) ?? {} });

const select = {
  key: true,
  draft: true,
  draftUpdatedAt: true,
  draftBy: true,
  prefs: true,
  prefsUpdatedAt: true,
  needsYou: true,
  readAt: true,
  updatedAt: true,
} as const;

function cursorWhere(cursor: SyncCursor | null): Prisma.ThreadSyncWhereInput {
  if (!cursor) return {};
  return { OR: [{ updatedAt: { gt: cursor.at } }, { updatedAt: cursor.at, key: { gt: cursor.key } }] };
}

export const prismaThreadSyncStore: ThreadSyncStore = {
  async get(userId, key) {
    const row = await prisma.threadSync.findFirst({ where: { userId, key }, select });
    return row ? toRow(row) : null;
  },
  async put(userId, row) {
    const data = {
      draft: row.draft,
      draftUpdatedAt: row.draftUpdatedAt,
      draftBy: row.draftBy,
      prefs: row.prefs as Prisma.InputJsonValue,
      prefsUpdatedAt: row.prefsUpdatedAt,
      needsYou: row.needsYou,
      readAt: row.readAt,
      updatedAt: row.updatedAt,
    };
    const saved = await prisma.threadSync.upsert({
      where: { userId_key: { userId, key: row.key } },
      create: { userId, key: row.key, ...data },
      update: data,
      select,
    });
    return toRow(saved);
  },
  async latestUpdatedAt(userId) {
    const row = await prisma.threadSync.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
    return row?.updatedAt ?? null;
  },
  async since(userId, cursor, limit, keys) {
    const rows = await prisma.threadSync.findMany({
      where: { userId, ...(keys?.length ? { key: { in: keys } } : {}), ...cursorWhere(cursor) },
      orderBy: [{ updatedAt: "asc" }, { key: "asc" }],
      take: limit,
      select,
    });
    return rows.map(toRow);
  },
};
