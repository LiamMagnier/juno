import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getProfileActivity } from "@/lib/profile-activity-server";

export const runtime = "nodejs";

/**
 * The signed-in account's own activity for the profile page: lifetime and
 * peak-day tokens, streaks, the longest finished task, a year of daily
 * tokens and the model mix (src/lib/profile-activity-server.ts).
 *
 * `?tz=` is the reader's IANA zone (the browser's), so a day on the grid is
 * the reader's day. Accounts store no zone of their own; anything that is not
 * a valid zone falls back to UTC. Owner-scoped: the user id comes from the
 * session (or a native bearer token), never from the query.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const timeZone = new URL(request.url).searchParams.get("tz");
  const activity = await getProfileActivity(user.id, { timeZone });
  return NextResponse.json(activity, { headers: { "cache-control": "private, max-age=30" } });
}
