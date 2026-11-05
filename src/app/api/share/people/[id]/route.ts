import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { removePersonFromShare } from "@/lib/share-people";

export const runtime = "nodejs";

/**
 * Take one person off a share with specific people. Their next request to the
 * page is refused; everyone else on it keeps access. Owner-scoped: another
 * account's recipient id is a 404, the same as one that does not exist.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const removed = await removePersonFromShare(user.id, id);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
