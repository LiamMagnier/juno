import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { decodeSyncCursor, isThreadKey, publicThreadSync, readThreadSync, SYNC_WAIT_MAX_MS } from "@/lib/sync/thread-sync";
import { prismaThreadSyncStore } from "@/lib/sync/thread-sync-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Per-thread state shared across devices (docs/code-v2/REMOTE-CONTROL.md
 * §Sync): `?cursor=` returns the rows written after it, `&wait=<ms>` long-polls
 * (≤ 20 s) when there are none, `&keys=a,b` narrows to those threads.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const params = new URL(req.url).searchParams;
  const rawCursor = params.get("cursor");
  const cursor = decodeSyncCursor(rawCursor);
  if (rawCursor && !cursor) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  const wait = Number(params.get("wait") ?? 0);
  const keys = (params.get("keys") ?? "").split(",").filter(Boolean);
  if (keys.length > 100 || keys.some((k) => !isThreadKey(k))) return NextResponse.json({ error: "Invalid keys" }, { status: 400 });
  const page = await readThreadSync(prismaThreadSyncStore, user.id, {
    cursor,
    waitMs: Number.isFinite(wait) ? Math.min(Math.max(wait, 0), SYNC_WAIT_MAX_MS) : 0,
    keys,
    signal: req.signal,
  });
  return NextResponse.json({ threads: page.threads.map(publicThreadSync), cursor: page.cursor }, { headers: { "Cache-Control": "private, no-store" } });
}
