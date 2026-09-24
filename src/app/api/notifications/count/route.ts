import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { countNotifications } from "@/lib/notifications";

/**
 * The inbox dot, for the poll: `NotificationsCount`. One indexed count and
 * one probe, so it is cheap enough to ask every half minute.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await countNotifications(user.id));
}
