import { NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { cloneLibraryAttachments } from "@/lib/library-attach";
import { getObjectBytes } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.strictObject({
  attachmentIds: z.array(z.string().min(1).max(200)).min(1).max(20),
});

/**
 * Add Library files to a project's knowledge ("From Library" on the project
 * page). Each picked file is cloned into a fresh project attachment that
 * reuses the SAME stored object (src/lib/library-attach.ts), so the Library
 * copy and the chat that first carried it keep theirs. Owner only, as an
 * upload to the project is.
 *
 * The clone starts `queued` and is indexed like an upload to the project, so
 * every chat in the project can search it. Its bytes are read back from
 * storage after the response for that: the clone has the object, not the bytes.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Only the project’s owner can add files." }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const clones = await prisma.$transaction(async (tx) => {
    const { clones: made } = await cloneLibraryAttachments(tx, user.id, parsed.data.attachmentIds);
    for (const clone of made) {
      await tx.attachment.update({ where: { id: clone.id, userId: user.id }, data: { projectId: id, parserState: "queued" } });
    }
    return made.map((clone) => ({ ...clone, projectId: id, parserState: "queued" }));
  });
  if (clones.length === 0) return NextResponse.json({ error: "Those files aren’t in your Library any more." }, { status: 404 });

  after(async () => {
    for (const clone of clones) {
      try {
        const { bytes } = await getObjectBytes(clone.storageKey);
        scheduleIngest({ userId: user.id, attachmentId: clone.id, projectId: id, fileName: clone.fileName, mimeType: clone.mimeType, bytes });
      } catch (error) {
        console.error("[projects] indexing a Library file failed", { attachmentId: clone.id, error: error instanceof Error ? error.name : typeof error });
      }
    }
  });
  await prisma.project.updateMany({ where: { id, userId: user.id }, data: { updatedAt: new Date() } });
  return NextResponse.json({ attachments: await Promise.all(clones.map(serializeAttachment)) }, { status: 201 });
}
