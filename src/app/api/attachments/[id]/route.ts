import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { tombstoneAttachment } from "@/lib/library-removal";
import { headObject, openObjectStream } from "@/lib/storage";
import { MIME_SNIFF_BYTES, sanitizeFileName, sniffImageMime } from "@/lib/uploads";

const patchSchema = z.object({ fileName: z.string().trim().min(1).max(200) });

// Authenticated same-origin image bytes for browser features that cannot rely
// on storage-provider CORS (realtime voice image input, canvas conversion).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id, kind: "IMAGE", deletedAt: null },
    select: { storageKey: true },
  });
  if (!attachment) return NextResponse.json({ error: "Image not found." }, { status: 404 });

  // Sniff from the object's first bytes, then stream the rest straight to the
  // client. Reading the whole object to identify it meant a 50 MB image cost
  // 50 MB of RSS per concurrent request, and PM2 restarts juno-backend at
  // ~1400 MB — a restart that kills every in-flight SSE stream on the box.
  try {
    const { size, prefix } = await headObject(attachment.storageKey, MIME_SNIFF_BYTES);
    const mimeType = sniffImageMime(prefix);
    if (!mimeType) return NextResponse.json({ error: "Invalid image." }, { status: 415 });

    const body = await openObjectStream(attachment.storageKey);
    return new NextResponse(body, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(size),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Image unavailable." }, { status: 404 });
  }
}

// Rename a file/image in the Library (changes the displayed name only).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id, deletedAt: null }, select: { id: true } });
  if (!attachment) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid name." }, { status: 400 });

  const fileName = sanitizeFileName(parsed.data.fileName);
  const updated = await prisma.attachment.update({ where: { id: attachment.id, userId: user.id }, data: { fileName } });
  return NextResponse.json({ ok: true, fileName: updated.fileName });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  // A real delete, whoever uses the file: the project page and the native
  // project client remove project files and covers through this route. The
  // Library's delete is DELETE /api/library/[id], which leaves a file a chat
  // or project still uses where it is.
  await prisma.$transaction((tx) => tombstoneAttachment(tx, user.id, attachment));

  return NextResponse.json({ ok: true });
}
