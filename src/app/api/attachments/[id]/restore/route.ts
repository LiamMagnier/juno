import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getObjectBytes } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";
import { libraryViewWhere } from "@/lib/library-removal-policy";

export const runtime = "nodejs";

/**
 * Bring a file back from Recently deleted without inventing new bytes: a
 * library tombstone, or a file that was only taken out of the Library.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id, ...libraryViewWhere("deleted") } });
  if (!attachment) return NextResponse.json({ error: "Deleted attachment not found." }, { status: 404 });

  // Only taken out of the Library: a chat or project kept it, so its bytes and
  // its knowledge index never went anywhere, and putting it back in the
  // Library is the one column. No re-read, no re-index.
  if (!attachment.deletedAt) {
    // Conditional on the row still being only hidden when the write lands. The
    // project page and the native project client delete through
    // DELETE /api/attachments/[id], and one landing between the read above and
    // this write would otherwise leave a tombstone that this reported as
    // restored: the page drops it from Recently deleted, and the next load
    // puts it back there.
    const shown = await prisma.attachment.updateMany({
      where: { id: attachment.id, userId: user.id, deletedAt: null, libraryRemovedAt: { not: null } },
      data: { libraryRemovedAt: null },
    });
    if (shown.count === 1) {
      return NextResponse.json({ ok: true, attachment: { id: attachment.id, parserState: attachment.parserState } });
    }

    // The row moved under us. Restore what is there now.
    attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id } });
    if (!attachment) return NextResponse.json({ error: "Deleted attachment not found." }, { status: 404 });
    if (!attachment.deletedAt) {
      // Another Restore (an Undo, a second tab) got there first: the file is
      // where the reader asked for it.
      if (!attachment.libraryRemovedAt) {
        return NextResponse.json({ ok: true, attachment: { id: attachment.id, parserState: attachment.parserState } });
      }
      // Restored and removed again in the meantime. Nothing to do safely here;
      // the client keeps the row in Recently deleted.
      return NextResponse.json({ error: "This file changed while it was being restored. Try again." }, { status: 409 });
    }
    // Deleted where it was used in the meantime: fall through and restore the
    // tombstone, bytes and index included.
  }

  // Avoid pulling a large media object merely to restore its library row. Only
  // document-sized files need a fresh knowledge index; images and oversized
  // files are restored with an explicit non-indexed parser state.
  const canReindex = attachment.kind === "FILE" && attachment.size <= 64 * 1024 * 1024;
  let bytes: Uint8Array | null = null;
  if (canReindex) {
    try {
      bytes = (await getObjectBytes(attachment.storageKey)).bytes;
    } catch {
      return NextResponse.json({ error: "The stored file is unavailable and cannot be restored." }, { status: 410 });
    }
  }

  const restored = await prisma.attachment.update({
    where: { id: attachment.id, userId: user.id },
    // Back in the Library too, if it had been taken out of it before the
    // delete (a hidden project file the project page then deleted).
    data: { deletedAt: null, libraryRemovedAt: null, parserState: bytes ? "queued" : "skipped" },
  });

  if (bytes) {
    scheduleIngest({
      userId: user.id,
      attachmentId: restored.id,
      projectId: restored.projectId,
      fileName: restored.fileName,
      mimeType: restored.mimeType,
      bytes,
    });
  }

  return NextResponse.json({ ok: true, attachment: { id: restored.id, parserState: restored.parserState } });
}
