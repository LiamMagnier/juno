import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { markNotificationRead } from "@/lib/notifications";

/**
 * Marks one notification read. Idempotent: a row that is already read answers
 * `changed: false`, because the phone that opened the push and the tab that
 * clicked the row are routinely the same person twice. 404 means only that
 * the id is not this account's.
 */
export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const marked = await markNotificationRead(user.id, id);
  if (!marked.found) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, changed: marked.changed });
}
