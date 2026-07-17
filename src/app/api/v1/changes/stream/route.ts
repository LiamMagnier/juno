import { requireNativeRequest } from "@/lib/native-request";
import { parseCursor } from "@/lib/sync-protocol";
import { accountChangeStreamResponse } from "@/lib/sync-feed";
import { apiV1Error, CONTRACT_VERSION } from "@/lib/api-v1";
import { NativeAuthError } from "@/lib/native-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The stream holds ~55s (sync-feed STREAM_WINDOW_MS) then ends with `done` so
// clients reconnect; keep the route budget just above the hold.
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const rawAfter = new URL(request.url).searchParams.get("after");
    let after: bigint | null;
    try {
      // Absent → baseline to the account's current cursor (wake-up only);
      // explicit → immediate catch-up event when the account is ahead of it.
      after = rawAfter === null ? null : parseCursor(rawAfter);
    } catch {
      throw new NativeAuthError("invalid_request", 400, "The change cursor is invalid.");
    }
    return await accountChangeStreamResponse({
      accountId: current.user.id,
      after,
      signal: request.signal,
      headers: { "X-Juno-Contract-Version": CONTRACT_VERSION },
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
