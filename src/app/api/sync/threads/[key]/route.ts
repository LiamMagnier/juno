import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { isThreadKey, parseThreadUpdate, publicThreadSync, writeThreadSync } from "@/lib/sync/thread-sync";
import { prismaThreadSyncStore } from "@/lib/sync/thread-sync-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

async function keyFrom(params: Promise<{ key: string }>): Promise<string | null> {
  const { key } = await params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return null;
  }
  return isThreadKey(decoded) ? decoded : null;
}

/** One thread's shared state (null fields when nothing was written yet). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const key = await keyFrom(params);
  if (!key) return NextResponse.json({ error: "Invalid thread" }, { status: 400 });
  const row = await prismaThreadSyncStore.get(user.id, key);
  return NextResponse.json({ thread: row ? publicThreadSync(row) : null }, { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Writes a draft (debounced by the client), the composer settings, "read" or
 * needs-you. Each group applies only when newer than what is stored.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const key = await keyFrom(params);
  if (!key) return NextResponse.json({ error: "Invalid thread" }, { status: 400 });
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* parseThreadUpdate refuses it */
  }
  const parsed = parseThreadUpdate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const limit = await rateLimit({ key: `thread-sync:${user.id}`, limit: 600, windowSec: 60 }).catch(() => ({ success: true }));
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "10" } });
  const row = await writeThreadSync(prismaThreadSyncStore, user.id, key, parsed.update);
  return NextResponse.json({ thread: publicThreadSync(row) }, { headers: { "Cache-Control": "private, no-store" } });
}
