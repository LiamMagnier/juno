import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getObjectBytes } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";

export const runtime = "nodejs";

/** Restore a library tombstone without inventing new bytes. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id, deletedAt: { not: null } } });
  if (!attachment) return NextResponse.json({ error: "Deleted attachment not found." }, { status: 404 });

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
    data: { deletedAt: null, parserState: bytes ? "queued" : "skipped" },
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
