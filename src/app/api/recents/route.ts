import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  countByFilter,
  isRecentFilter,
  matchesFilter,
  mergeRecents,
  perSourceLimit,
  type RecentItem,
} from "@/lib/work/recents";

/**
 * One list of everything, across Chat, Work, Code and Projects.
 *
 * Four queries rather than a UNION, because the four tables have genuinely
 * different shapes and a UNION would need every column cast into one row type —
 * which means adding a column to any of them silently changes what this route
 * returns. Four small indexed reads, projected in TypeScript where the
 * projection is visible and testable, is the honest version.
 *
 * Each source is asked for the whole limit, never a share of it. A quarter each
 * would drop the five most recent chats whenever the user chatted all morning
 * and touched nothing else, and the failure is invisible because the merged
 * list still comes back full.
 */

export const runtime = "nodejs";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const params = new URL(req.url).searchParams;

  const rawFilter = params.get("filter") ?? "all";
  if (!isRecentFilter(rawFilter)) {
    return NextResponse.json({ error: "Invalid input", parameter: "filter" }, { status: 400 });
  }

  const rawLimit = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const take = perSourceLimit(limit);

  // Conversations carry both Chat and Code; `kind` is what tells them apart,
  // and it is projected rather than filtered so one read serves both lists.
  const [conversations, workSessions, projects] = await Promise.all([
    prisma.conversation.findMany({
      // Conversation soft-deletes with archivedAt rather than deletedAt; the
      // two Work tables use deletedAt. Reading each table's own column rather
      // than assuming one convention is why this is four queries.
      where: { userId: user.id, archivedAt: null },
      orderBy: [{ pinned: "desc" }, { lastMessageAt: "desc" }],
      take,
      select: {
        id: true,
        title: true,
        kind: true,
        pinned: true,
        projectId: true,
        lastMessageAt: true,
        updatedAt: true,
      },
    }),
    prisma.workSession.findMany({
      where: { userId: user.id, deletedAt: null, archived: false },
      orderBy: [{ pinned: "desc" }, { lastActivityAt: "desc" }],
      take,
      select: {
        id: true,
        title: true,
        status: true,
        needsAttention: true,
        pinned: true,
        projectId: true,
        lastActivityAt: true,
      },
    }),
    prisma.project.findMany({
      where: { userId: user.id },
      orderBy: [{ starred: "desc" }, { updatedAt: "desc" }],
      take,
      select: { id: true, name: true, starred: true, updatedAt: true },
    }),
  ]);

  const chatItems: RecentItem[] = [];
  const codeItems: RecentItem[] = [];
  for (const row of conversations) {
    const isCode = row.kind === "code";
    const item: RecentItem = {
      id: row.id,
      kind: isCode ? "code" : "chat",
      title: row.title || (isCode ? "Untitled session" : "New chat"),
      updatedAt: (row.lastMessageAt ?? row.updatedAt).toISOString(),
      pinned: row.pinned,
      projectId: row.projectId,
      href: `/chat/${row.id}`,
    };
    (isCode ? codeItems : chatItems).push(item);
  }

  const workItems: RecentItem[] = workSessions.map((row) => ({
    id: row.id,
    kind: "work",
    title: row.title || "Untitled task",
    updatedAt: row.lastActivityAt.toISOString(),
    pinned: row.pinned,
    status: row.status,
    needsAttention: row.needsAttention,
    projectId: row.projectId,
    href: `/work/${row.id}`,
  }));

  const projectItems: RecentItem[] = projects.map((row) => ({
    id: row.id,
    kind: "project",
    title: row.name,
    updatedAt: row.updatedAt.toISOString(),
    // Starred is the project surface's word for pinned, and the merged list has
    // exactly one notion of "keep this at the top".
    pinned: row.starred,
    href: `/projects/${row.id}`,
  }));

  const merged = mergeRecents([chatItems, workItems, codeItems, projectItems], MAX_LIMIT);

  // Counted before filtering and before slicing, so the filter bar shows how
  // many rows each tab holds rather than how many survived the tab that
  // happens to be open.
  const counts = countByFilter(merged);
  const items = merged.filter((item) => matchesFilter(item, rawFilter)).slice(0, limit);

  return NextResponse.json({ items, counts, filter: rawFilter });
}
