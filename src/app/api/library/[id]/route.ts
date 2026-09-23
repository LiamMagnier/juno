import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { removeFromLibrary } from "@/lib/library-removal";

export const runtime = "nodejs";

/**
 * Take one file out of the Library.
 *
 * Not `DELETE /api/attachments/[id]`, which deletes the file wherever it is:
 * a file sent in a chat or kept in a project stays there, and only the
 * Library lets go of it (`mode: "hidden"`, `keptIn` saying where it stayed).
 * A file nothing else uses is deleted as before (`mode: "deleted"`). Either
 * way it lands in Recently deleted, and `POST /api/attachments/[id]/restore`
 * brings it back. See src/lib/library-removal-policy.ts.
 *
 * `attach` beside this is a static segment, so it still wins its own path.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const removal = await removeFromLibrary(user.id, id);
  if (!removal) return NextResponse.json({ error: "File not found." }, { status: 404 });

  return NextResponse.json({ ok: true, mode: removal.mode, keptIn: removal.keptIn });
}
