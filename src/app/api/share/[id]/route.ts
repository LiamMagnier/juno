import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { revokeShare } from "@/lib/share";

export const runtime = "nodejs";

/** Revoke a share link — the public page 404s from the next request on. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const ok = await revokeShare(user.id, id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
