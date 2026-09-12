import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { revokeAllSessions } from "@/lib/account-security";

export const runtime = "nodejs";

/**
 * Sign out everywhere.
 *
 * Juno's sessions are stateless JWTs, so there is no list of devices to revoke
 * one by one — the account carries a `sessionVersion` that every token is
 * stamped with and every session read re-checks, and incrementing it is what
 * makes every issued token stale at once. That includes the caller's own,
 * which is correct: "sign out everywhere" that leaves you signed in here is
 * not what the words say, and a user pressing it on a device they no longer
 * trust would be the worst case to get wrong.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `sessions-revoke:${user.id}`, limit: 10, windowSec: 60 * 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }

  await revokeAllSessions(user.id);
  return NextResponse.json({ ok: true });
}
