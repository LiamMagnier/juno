import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listNotifications, markAllNotificationsRead } from "@/lib/notifications";
import { parseInboxQuery } from "@/lib/notify/inbox";

/**
 * The inbox, a page at a time: `?limit=1..50&before=<cursor>&unread=true`.
 * Answers `NotificationsPage`; pass its `nextBefore` back for the page before.
 * Native clients call it with their bearer — `getCurrentUser` accepts one.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = parseInboxQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  return NextResponse.json(await listNotifications(user.id, parsed.query));
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action === "mark_all_read") {
    const count = await markAllNotificationsRead(user.id);
    return NextResponse.json({ ok: true, markedCount: count });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
