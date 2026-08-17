import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { markNotificationRead } from "@/lib/notifications";

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const marked = await markNotificationRead(user.id, id);
  if (!marked) {
    return NextResponse.json({ error: "Notification not found or already read" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
