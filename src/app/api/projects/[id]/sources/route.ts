import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { CLOUD_FILE_ID } from "@/lib/cloud-files/shared";
import { SourceSyncError } from "@/lib/projects/drive-source";
import {
  addDriveSources,
  driveAvailability,
  listProjectSources,
  scheduleStaleSourceSyncs,
} from "@/lib/projects/drive-source-store";
import type { ProjectSourcesResponse } from "@/lib/projects/project-sources-shared";

export const runtime = "nodejs";
export const maxDuration = 300;

/*
 * A project's cloud sources (Google Drive files and folders kept in sync as
 * project knowledge). Owner only: a source reads the owner's own Drive and
 * stores into the owner's Library, so a collaborator neither sees the
 * owner's Drive names nor files into it.
 *
 * GET   the sources and whether Drive can be offered; queues a sync for any
 *       source whose last one is stale (lib/projects/drive-source-store.ts).
 * POST  file picked Drive items into the project and start their first sync.
 */

async function ownedProject(userId: string, id: string) {
  return prisma.project.findFirst({ where: { id, userId }, select: { id: true } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownedProject(user.id, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const queued = new Set(await scheduleStaleSourceSyncs(user.id, id));
  const [sources, drive] = await Promise.all([listProjectSources(user.id, id), driveAvailability(user.id)]);
  const body: ProjectSourcesResponse = {
    // A source queued just now reads as syncing at once, so the page starts
    // polling instead of drawing a stale "Synced 2 hr ago" for one more round.
    sources: sources.map((source) => (queued.has(source.id) ? { ...source, syncing: true } : source)),
    drive,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

const addBody = z.strictObject({
  provider: z.literal("google-drive"),
  items: z
    .array(z.strictObject({ id: z.string().regex(CLOUD_FILE_ID), kind: z.enum(["file", "folder"]) }))
    .min(1)
    .max(20),
  includeSubfolders: z.boolean().default(true),
});

const STATUS: Record<SourceSyncError["code"], number> = {
  not_connected: 409,
  reconnect: 409,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  library_full: 413,
  capacity: 413,
  provider_error: 502,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownedProject(user.id, id))) return NextResponse.json({ error: "Only the project’s owner can add sources." }, { status: 404 });

  const parsed = addBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (!(await rateLimit({ key: `project-sources:${user.id}`, limit: 30, windowSec: 600 })).success) {
    return NextResponse.json({ error: "Too many sources added at once. Try again in a few minutes." }, { status: 429 });
  }

  // De-duplicated, order kept: picking a folder twice files it once.
  const seen = new Set<string>();
  const picks = parsed.data.items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  try {
    const { sourceIds } = await addDriveSources(user.id, id, picks, parsed.data.includeSubfolders);
    const sources = await listProjectSources(user.id, id);
    const added = new Set(sourceIds);
    return NextResponse.json(
      { sources: sources.map((source) => (added.has(source.id) ? { ...source, syncing: true } : source)), added: sourceIds },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SourceSyncError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
    }
    console.error("[project-sources] add failed", error instanceof Error ? error.name : typeof error);
    return NextResponse.json({ error: "Couldn’t add that from Google Drive. Try again." }, { status: 500 });
  }
}
