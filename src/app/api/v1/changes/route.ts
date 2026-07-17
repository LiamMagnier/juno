import { ApiV1Error, apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { listAccountChanges } from "@/lib/sync-feed";
import { CursorCompactedError, parseChangeLimit, parseCursor } from "@/lib/sync-protocol";
import { NativeAuthError } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const url = new URL(request.url);
    let after: bigint;
    let limit: number;
    try {
      after = parseCursor(url.searchParams.get("after"));
      limit = parseChangeLimit(url.searchParams.get("limit"));
    } catch {
      throw new NativeAuthError("invalid_request", 400, "The change cursor or page limit is invalid.");
    }
    return apiV1Json(await listAccountChanges(current.user.id, after, limit));
  } catch (error) {
    if (error instanceof CursorCompactedError) {
      return apiV1Error(
        new ApiV1Error("cursor_compacted", 410, "The cursor predates the compaction floor — resync from bootstrap.", false, {
          compactionFloorCursor: error.floor.toString(),
        }),
      );
    }
    return apiV1Error(error);
  }
}
