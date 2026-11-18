import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isCloudAttachEnabled } from "@/lib/env";
import { removeProjectSource, scheduleSourceSync, listProjectSources } from "@/lib/projects/drive-source-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/*
 * One cloud source of a project. Owner only, like the list beside it.
 *
 * POST    Sync now: queue a sync after the response; the page polls the list.
 * DELETE  Remove the source and the files it mirrored from the project.
 */

async function ownedSource(userId: string, projectId: string, sourceId: string) {
  return prisma.projectSource.findFirst({ where: { id: sourceId, userId, projectId }, select: { id: true } });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, sourceId } = await params;
  if (!isCloudAttachEnabled()) {
    return NextResponse.json({ error: "Google Drive isn’t turned on for this server.", code: "not_enabled" }, { status: 404 });
  }
  if (!(await ownedSource(user.id, id, sourceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await rateLimit({ key: `project-source-sync:${user.id}`, limit: 60, windowSec: 600 })).success) {
    return NextResponse.json({ error: "Synced a lot just now. Try again in a few minutes." }, { status: 429 });
  }
  scheduleSourceSync(user.id, [sourceId]);
  const sources = await listProjectSources(user.id, id);
  return NextResponse.json(
    { sources: sources.map((source) => (source.id === sourceId ? { ...source, syncing: true } : source)) },
    { status: 202 },
  );
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, sourceId } = await params;
  const removed = await removeProjectSource(user.id, id, sourceId);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
