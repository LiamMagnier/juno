import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listNotifications, markAllNotificationsRead } from "@/lib/notifications";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const unreadOnly = searchParams.get("unread") === "true";
  const limitStr = searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 30;

  const result = await listNotifications(user.id, { unreadOnly, limit });
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body.action === "mark_all_read") {
    const count = await markAllNotificationsRead(user.id);
    return NextResponse.json({ ok: true, markedCount: count });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
