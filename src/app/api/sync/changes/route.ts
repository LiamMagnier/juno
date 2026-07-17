import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listAccountChanges } from "@/lib/sync-feed";
import { CursorCompactedError, parseChangeLimit, parseCursor } from "@/lib/sync-protocol";

/*
 * Cookie-session twin of GET /api/v1/changes for the shipping native app.
 * The success payload is byte-for-byte the same shape as /api/v1/changes
 * (shared via sync-feed); only auth and the error envelope follow the web
 * route conventions.
 */

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  let after: bigint;
  let limit: number;
  try {
    after = parseCursor(url.searchParams.get("after"));
    limit = parseChangeLimit(url.searchParams.get("limit"));
  } catch {
    return NextResponse.json({ error: "Invalid cursor or limit" }, { status: 400 });
  }

  try {
    return NextResponse.json(await listAccountChanges(user.id, after, limit));
  } catch (error) {
    if (error instanceof CursorCompactedError) {
      return NextResponse.json(
        {
          error: "The cursor predates the compaction floor — resync from scratch.",
          code: "cursor_compacted",
          compactionFloorCursor: error.floor.toString(),
        },
        { status: 410 },
      );
    }
    throw error;
  }
}
