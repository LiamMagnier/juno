import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { parseCursor } from "@/lib/sync-protocol";
import { accountChangeStreamResponse } from "@/lib/sync-feed";

/*
 * Cookie-session twin of GET /api/v1/changes/stream for the shipping native
 * app (Juno/Services/Backend/SyncLiveness.swift): a long-lived SSE wake-up
 * stream that emits `cursor` events (`{"cursor":"…"}`) whenever the account's
 * change cursor advances, heartbeats in between, and closes with `done` after
 * ~55s so the client reconnects. The app connects without `after` and treats
 * any cursor event as "run a full refresh", so bare connects baseline to the
 * current cursor instead of replaying history.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The stream holds ~55s (sync-feed STREAM_WINDOW_MS) then ends with `done` so
// clients reconnect; keep the route budget just above the hold.
export const maxDuration = 60;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawAfter = new URL(request.url).searchParams.get("after");
  let after: bigint | null;
  try {
    after = rawAfter === null ? null : parseCursor(rawAfter);
  } catch {
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }
  return accountChangeStreamResponse({ accountId: user.id, after, signal: request.signal });
}
