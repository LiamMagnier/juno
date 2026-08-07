import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listActionApprovals } from "@/lib/action-approval-store";

export const runtime = "nodejs";

/**
 * Every pending and recently answered approval for the signed-in account.
 *
 * This is the recovery path, not the happy path: a live turn streams its
 * approval over the chat stream, but a reload, a second tab, or the native app
 * opening cold has no stream to have missed. Without a list to poll, a request
 * raised while the browser was closed would sit pending until its TTL with
 * nobody able to see it.
 *
 * `listActionApprovals` expires stale pending rows as it reads. That side
 * effect is deliberate and must stay: the expiry sweep has no other scheduler
 * behind it, so a row nobody ever lists is a row that stays pending forever and
 * keeps offering a Yes button for an action whose moment has passed.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const conversationId = params.get("conversationId")?.trim() || null;
  // Opt-in rather than default, because the recent window includes answered and
  // expired rows. A client polling to render pending cards must not have to
  // filter decided ones back out and risk showing a stale question.
  const includeRecent = params.get("includeRecent") === "1";

  const approvals = await listActionApprovals({ userId: user.id, conversationId, includeRecent });
  return NextResponse.json({ approvals });
}
